import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright e2e 配置（任务 #9）
 *
 * - 仅覆盖浏览器 Web 模式：sidecar/Tauri 能力在用例中验证其降级表现。
 * - webServer 复用 npm run dev（vite --host 127.0.0.1 --port 5173 --strictPort），
 *   已有 dev server 在跑时直接复用（reuseExistingServer）。
 * - vitest 侧通过 vite.config.js test.exclude 的 'e2e/**' 规则隔离本目录。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    locale: 'zh-CN',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
