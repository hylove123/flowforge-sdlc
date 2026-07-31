/**
 * 04 — 设置页表单交互与保存
 *
 * 覆盖：页签切换、默认项目切换（联动顶栏项目切换器）、通知开关、
 * 团队成员邀请、开发环境模式选择、Skill 启停、保存按钮。
 * 注：应用的 Toast 组件未挂载到视图中，因此断言以状态变化为准。
 */
import { test, expect } from '@playwright/test'
import { gotoApp, activeDialog } from './helpers.js'

async function openTab(page, label) {
  await page.locator('.tab-item', { hasText: label }).click()
}

test.describe('设置页', () => {
  test('渲染系统设置与全部页签', async ({ page }) => {
    await gotoApp(page, '/settings')
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
    for (const tab of ['全局配置', '团队成员', 'Skill管理', 'Rule管理', 'MCP工具', '通知设置', '开发环境']) {
      await expect(page.locator('.tab-item', { hasText: tab })).toBeVisible()
    }
    // 全局配置默认展示 AI 服务与数据管理
    await expect(page.getByRole('heading', { name: 'AI 服务' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '数据管理' })).toBeVisible()
  })

  test('切换默认项目后顶栏项目切换器同步更新', async ({ page }) => {
    await gotoApp(page, '/settings')
    const card = page.locator('.card', { hasText: '项目默认配置' })
    await card.locator('select').selectOption({ label: '数据中台重构' })
    await expect(page.locator('.project-switcher-name')).toHaveText('数据中台重构')
  })

  test('通知设置：开关切换生效', async ({ page }) => {
    await gotoApp(page, '/settings')
    await openTab(page, '通知设置')
    const toggle = page.getByRole('switch', { name: '阶段完成通知' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('团队成员：邀请成员后出现在成员表格', async ({ page }) => {
    await gotoApp(page, '/settings')
    await openTab(page, '团队成员')
    await expect(page.getByText('3 位成员')).toBeVisible()

    await page.getByRole('button', { name: '邀请成员' }).click()
    const dialog = activeDialog(page)
    await dialog.getByPlaceholder('请输入成员姓名').fill('E2E新成员')
    await dialog.getByPlaceholder('name@example.com').fill('e2e@example.com')
    await dialog.getByRole('button', { name: '邀请', exact: true }).click()

    await expect(activeDialog(page)).toHaveCount(0)
    await expect(page.locator('.data-table').getByText('E2E新成员')).toBeVisible()
    await expect(page.getByText('4 位成员')).toBeVisible()
  })

  test('开发环境：切换开发模式选中态正确', async ({ page }) => {
    await gotoApp(page, '/settings')
    await openTab(page, '开发环境')
    const uriCard = page.locator('[role="button"][aria-pressed]', { hasText: '本地IDE' })
    const bridgeCard = page.locator('[role="button"][aria-pressed]', { hasText: 'Bridge Agent' })
    // 默认 devMode 为 bridge-agent
    await expect(bridgeCard).toHaveAttribute('aria-pressed', 'true')
    await uriCard.click()
    await expect(uriCard).toHaveAttribute('aria-pressed', 'true')
    await expect(bridgeCard).toHaveAttribute('aria-pressed', 'false')
  })

  test('Skill管理：启停开关切换生效', async ({ page }) => {
    await gotoApp(page, '/settings')
    await openTab(page, 'Skill管理')
    const toggle = page.getByRole('switch', { name: '启用 PRD-Generator' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('保存更改按钮可用且点击后页面保持正常', async ({ page }) => {
    await gotoApp(page, '/settings')
    const saveBtn = page.getByRole('button', { name: '保存更改' })
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
  })
})
