import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * 多视口响应式检查。
 *
 * 只断言"真的会坏事"的几件事，不截图比对、不锁定具体像素：
 *   1. 整页不该出现横向滚动条（内容溢出被 `.board-scroll` 吃掉才算对）
 *   2. 输入框与主按钮不能小到手指点不准
 *   3. 窄屏下课表必须能横向滑动，否则一周七天的列会被挤成竖排
 *   4. 页面不许有未捕获的 JS 错误
 *
 * 这些在现有的 fake DOM 里量不出来——那里没有排版引擎，`scrollWidth` 恒等于内容宽。
 */

/** 与 seed 的初始口令不同，且满足口令策略；beforeAll 会改一次，之后都用它登录。 */
const E2E_PASSWORD = 'E2e!Mobile2026';
const LOGIN_NAME = 'teacher01';

const VIEWPORTS = [
  { name: '320-Galaxy-S9+', width: 320, height: 658 },
  { name: '375-iPhone-SE', width: 375, height: 667 },
  { name: '412-Pixel-7', width: 412, height: 915 },
  { name: '430-iPhone-14-Pro-Max', width: 430, height: 932 },
  { name: '1280-桌面', width: 1280, height: 800 },
];

/** 整页横向溢出量（px）。>0 表示用户能把页面左右拖动，这是移动端最刺眼的一种坏。 */
async function pageOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function login(page: Page): Promise<void> {
  await page.fill('#login-name', LOGIN_NAME);
  await page.fill('#login-password', E2E_PASSWORD);
  await page.locator('form.login button[type="submit"]').click();
}

const SEED_WORK = process.env.CA_E2E_WORK ?? '/tmp/ca-e2e';

/**
 * 从种子日志里取一次性初始口令。
 *
 * seed-demo.ts 给 teacher01 这类账号生成的是随机口令，只打印一次。
 * 与其为了测试把它们改成固定口令（那会破坏"演示账号必须一次性口令"这条约束），
 * 不如把那份输出落盘读回来。格式变了会在这里明确失败，而不是让后面 5 个用例莫名 401。
 */
function initialPasswordOf(loginName: string): string {
  const file = join(SEED_WORK, 'seed.log');
  let log: string;
  try {
    log = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `读不到种子日志：${file}。webServer 没起来，或 CA_E2E_WORK 与 ci-serve-demo.sh 不一致。`,
    );
  }
  const match = new RegExp(`${loginName}[^\\n]*初始口令\\s+(\\S+)`).exec(log);
  if (match === null) {
    throw new Error(`种子日志里找不到 ${loginName} 的初始口令，seed-demo.ts 的输出格式可能变了：\n${log}`);
  }
  return match[1] as string;
}

// seed 出来的账号首次登录必须改密。这里先用种子口令登录、改一次密，
// 之后所有用例都用 E2E_PASSWORD。重试或被重跑时口令已经是新的，所以先试新口令再说。
test.beforeAll(async ({ request }) => {
  const loginWith = (password: string) =>
    request.post('/api/auth/login', { data: { loginName: LOGIN_NAME, password } });

  const alreadyChanged = await loginWith(E2E_PASSWORD);
  if (alreadyChanged.ok()) return;

  const initial = initialPasswordOf(LOGIN_NAME);
  const first = await loginWith(initial);
  expect(first.ok(), `用种子口令登录 ${LOGIN_NAME} 失败`).toBeTruthy();

  const { token } = (await first.json()) as { token: string };
  const changed = await request.post('/api/me/password', {
    headers: { authorization: `Bearer ${token}` },
    data: { oldPassword: initial, newPassword: E2E_PASSWORD },
  });
  expect(changed.ok(), '改密失败，后续用例无法登录').toBeTruthy();
});

test.describe('登录页', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}：不横向溢出，输入框与按钮够大`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await expect(page.locator('#login-name')).toBeVisible();

      expect(await pageOverflowPx(page), '整页出现横向滚动').toBeLessThanOrEqual(1);

      const input = await page.locator('#login-name').boundingBox();
      expect(input, '账号输入框量不到尺寸').not.toBeNull();
      expect(input!.height, '输入框高度不足以点准').toBeGreaterThanOrEqual(32);

      const submit = await page.locator('form.login button[type="submit"]').boundingBox();
      expect(submit, '登录按钮量不到尺寸').not.toBeNull();
      expect(submit!.height, '登录按钮高度不足以点准').toBeGreaterThanOrEqual(36);

      expect(errors, '页面有未捕获错误').toEqual([]);
    });
  }
});

test.describe('登录后', () => {
  // 只挑两个极端：最窄的 320 与常见的 430。中间尺寸的行为基本落在两者之间。
  for (const vp of VIEWPORTS.filter((v) => v.width === 320 || v.width === 430)) {
    test(`${vp.name}：课表可横滑，页面不整体溢出`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await login(page);

      // 账号若仍要求改密，说明 beforeAll 没生效，后面的断言没有意义，直接说清楚。
      await expect(page.locator('text=首次登录需修改口令')).toHaveCount(0);
      await expect(page.locator('.board-scroll').first()).toBeVisible();

      expect(await pageOverflowPx(page), '整页横向溢出').toBeLessThanOrEqual(1);

      const board = await page.evaluate(() => {
        const el = document.querySelector('.board-scroll');
        return el === null ? null : { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      expect(board, '找不到课表滚动容器').not.toBeNull();
      expect(board!.scrollWidth, '课表内容没有超出容器，横滑无从谈起').toBeGreaterThan(
        board!.clientWidth,
      );

      // 能真的滑动：滚到最右，scrollLeft 必须变化。
      const scrolled = await page.evaluate(() => {
        const el = document.querySelector('.board-scroll') as HTMLElement | null;
        if (el === null) return -1;
        el.scrollLeft = el.scrollWidth;
        return el.scrollLeft;
      });
      expect(scrolled, '课表容器无法横向滚动').toBeGreaterThan(0);

      expect(errors, '页面有未捕获错误').toEqual([]);
    });
  }
});
