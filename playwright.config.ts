import { defineConfig, devices } from '@playwright/test';

/**
 * 多视口浏览器测试。
 *
 * 目的单一：在真实排版引擎里验证"窄屏会不会塌"——横向溢出、按钮太小、课表能不能横滑、
 * 有没有 JS 报错。fake DOM 量不出这些，必须真浏览器。
 *
 * 边界：这里全是 Chromium + 视口/UA 模拟，**不是真机**。iOS Safari 的滚动惯性、
 * 软键盘顶起、微信与钉钉内置 WebView 的差异都测不到，那部分仍归
 * docs/reports/P7-T04 的实机清单，不能拿 CI 绿代替实机验收。
 */

const PORT = Number(process.env.CA_E2E_PORT ?? 18189);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 40_000,
  expect: { timeout: 8_000 },

  // 每个用例都会登录同一个账号。串行跑，避免并发改密互相踩。
  fullyParallel: false,
  workers: 1,

  // 网络或渲染偶发抖动时给一次重试；真问题仍然是红的。
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // 假彩色不影响断言，但能让失败截图更好读
    actionTimeout: 10_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // 起一个临时演示实例：临时库 + 种子 + 前台运行，测试结束由 Playwright 关掉。
  webServer: {
    command: 'bash scripts/ci-serve-demo.sh',
    url: `${BASE_URL}/api/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
