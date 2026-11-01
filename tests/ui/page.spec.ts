/**
 * 界面本身的静态约束。
 *
 * 没有浏览器可用时，这些断言仍然能挡住最容易犯的错：
 *  - 内联脚本/内联样式（CSP 会拦，但更应该在源码里就不出现）
 *  - innerHTML / document.write / eval（把数据当 HTML 用）
 *  - 页面引用了不存在的 DOM id 或 CSS 类（改了 JS 忘了改 HTML/CSS）
 *  - 前端调用了服务端不存在的接口（改了路由忘了改页面）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../../web/index.html', import.meta.url)), 'utf8');
const js = readFileSync(fileURLToPath(new URL('../../web/app.js', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../../web/styles.css', import.meta.url)), 'utf8');
const http = readFileSync(fileURLToPath(new URL('../../src/server/http.ts', import.meta.url)), 'utf8');

describe('页面结构', () => {
  it('没有内联脚本、内联样式与事件属性（CSP 之外的第二道防线）', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(js).not.toMatch(/\sstyle\s*:/);
  });

  it('不使用 innerHTML / outerHTML / document.write / eval', () => {
    for (const pattern of [/innerHTML/, /outerHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/]) {
      expect(js).not.toMatch(pattern);
    }
  });

  it('引用的元素 id 都存在于页面或由脚本创建', () => {
    const created = new Set(['view', 'slot-detail']);
    const declared = new Set(
      [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string),
    );
    for (const id of [...declared, ...created]) {
      expect(js.includes(`'${id}'`) || html.includes(`id="${id}"`)).toBe(true);
    }
    for (const match of js.matchAll(/getElementById\('([^']+)'\)/g)) {
      const id = match[1] as string;
      expect(declared.has(id) || created.has(id)).toBe(true);
    }
  });

  it('使用的 CSS 类都在样式表里定义', () => {
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string));
    const used = new Set<string>();
    for (const match of js.matchAll(/class: '([^']+)'/g)) {
      for (const token of (match[1] as string).split(/\s+/)) {
        if (token && !token.includes('$')) used.add(token);
      }
    }
    for (const match of html.matchAll(/class="([^"]+)"/g)) {
      for (const token of (match[1] as string).split(/\s+/)) if (token) used.add(token);
    }
    const missing = [...used].filter((token) => !defined.has(token));
    expect(missing).toEqual([]);
  });

  it('页面调用的接口都在服务端注册过', () => {
    const paths = new Set<string>();
    for (const match of js.matchAll(/'(\/api\/[^']*)'/g)) paths.add((match[1] as string).split('?')[0] as string);
    for (const match of js.matchAll(/`(\/api\/[^`$]*)`/g)) paths.add((match[1] as string).split('?')[0] as string);
    for (const match of js.matchAll(/`(\/api\/[^`$]*)\$\{/g)) paths.add((match[1] as string).split('?')[0] as string);
    expect(paths.size).toBeGreaterThan(5);
    // 路由里用正则写路径，斜杠被转义过；比较前先还原。
    const routes = http.replace(/\\\//g, '/');
    const missing = [...paths].filter((path) => !routes.includes(path));
    expect(missing).toEqual([]);
  });

  it('页面不引用任何外部主机资源', () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(js).not.toMatch(/https?:\/\//i);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
  });
});
