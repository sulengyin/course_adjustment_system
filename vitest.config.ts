import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 默认 5s 不够用：bcrypt 用例在低核机器上会因 CPU 排队而超时，
    // 表现为"16 个不相干的用例同时 timed out"，看起来像代码坏了，实际是环境。
    // 这里只放宽上限，不放宽断言——死循环仍然会在 20s 被掐断。
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
