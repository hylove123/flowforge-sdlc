/**
 * 05 — 交付流程关键路径（Web 模式）
 *
 * 覆盖：Pipeline 页渲染、需求列表与详情联动、新建需求（Pipeline 页 +
 * Dashboard 快捷入口）、阶段导航切换。
 * Tauri-only 能力（sidecar 图执行、断点恢复、外派执行）在 Web 模式下
 * 验证其降级表现：DelegatePanel 提示文案可见、断点续跑按钮不出现。
 */
import { test, expect } from '@playwright/test'
import { gotoApp, activeDialog, SEED_PROJECTS } from './helpers.js'

test.describe('交付流程', () => {
  test('Pipeline 页渲染：头部、需求列表与详情面板', async ({ page }) => {
    await gotoApp(page, '/pipeline')
    const header = page.locator('.pipeline-compact-header')
    await expect(header.getByRole('heading', { name: SEED_PROJECTS[0] })).toBeVisible()
    await expect(header.getByText(/个交付需求 · \d+ 个阶段/)).toBeVisible()

    // p1 种子交付：d1 智能客服对话引擎升级、d3 移动端消息推送SDK
    const list = page.locator('.delivery-list-panel')
    await expect(list.locator('.delivery-req-card')).toHaveCount(2)
    await expect(list.getByText('智能客服对话引擎升级')).toBeVisible()
    await expect(list.getByText('移动端消息推送SDK')).toBeVisible()

    // 默认选中第一条需求，详情面板展示标题与阶段导航
    await expect(page.locator('.delivery-detail-title')).toHaveText('智能客服对话引擎升级')
    await expect(page.getByRole('tablist', { name: '阶段导航' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '当前阶段', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: /交付追溯/ })).toBeVisible()
  })

  test('切换需求后详情面板联动更新', async ({ page }) => {
    await gotoApp(page, '/pipeline')
    await page.locator('.delivery-req-card', { hasText: '移动端消息推送SDK' }).click()
    await expect(page.locator('.delivery-detail-title')).toHaveText('移动端消息推送SDK')
    // d3 已到交付阶段（index 8）→ 进度 9 / 9
    await expect(page.locator('.delivery-progress-text')).toContainText('9 / 9')
  })

  test('阶段导航点击切换查看阶段', async ({ page }) => {
    await gotoApp(page, '/pipeline')
    await page.getByRole('tablist', { name: '阶段导航' })
      .getByRole('tab', { name: /^需求分析/ }).click()
    await expect(page.locator('.delivery-stage-info-name')).toHaveText('需求分析')
  })

  test('Web 模式降级：外派/断点恢复等 Tauri-only 能力展示占位', async ({ page }) => {
    await gotoApp(page, '/pipeline')
    // DelegatePanel 的 Web 模式提示（当前阶段页签内）
    await expect(page.getByText('外派与 MCP 工具执行需要桌面版')).toBeVisible()
    await expect(page.getByText('当前为 Web 模式')).toBeVisible()
    // sidecar 图执行进度与断点续跑仅在 tauri 模式出现
    await expect(page.getByRole('button', { name: '从断点继续' })).toHaveCount(0)
    await expect(page.getByText('执行引擎运行中')).toHaveCount(0)
  })

  test('Pipeline 页新建需求：创建后进入列表并可查看详情', async ({ page }) => {
    await gotoApp(page, '/pipeline')
    await page.locator('.pipeline-compact-header').getByRole('button', { name: '新建需求' }).click()

    const dialog = activeDialog(page)
    await expect(dialog.getByRole('heading', { name: '新建需求' })).toBeVisible()
    await dialog.locator('#delivery-title').fill('E2E 端到端交付验证')
    await dialog.locator('#delivery-desc').fill('由 Playwright 创建的交付需求')
    await dialog.locator('#delivery-priority').selectOption('P0')
    await dialog.getByRole('button', { name: '创建' }).click()
    await expect(activeDialog(page)).toHaveCount(0)

    const list = page.locator('.delivery-list-panel')
    await expect(list.locator('.delivery-req-card')).toHaveCount(3)
    const newCard = list.locator('.delivery-req-card', { hasText: 'E2E 端到端交付验证' })
    await expect(newCard).toBeVisible()

    // 选中新需求：从第一个阶段开始
    await newCard.click()
    await expect(page.locator('.delivery-detail-title')).toHaveText('E2E 端到端交付验证')
    await expect(page.locator('.delivery-progress-text')).toContainText('1 / 9')
  })

  test('Dashboard 快捷入口新建需求后出现在进行中的交付', async ({ page }) => {
    await gotoApp(page)
    await page.locator('.card', { hasText: '快捷操作' })
      .getByRole('button', { name: '新建需求' }).click()

    const dialog = activeDialog(page)
    await dialog.locator('#cr-title').fill('E2E 快捷需求')
    await dialog.locator('#cr-project').selectOption({ label: SEED_PROJECTS[0] })
    await dialog.getByRole('button', { name: '创建' }).click()
    await expect(activeDialog(page)).toHaveCount(0)

    const deliveryCard = page.locator('.card', { hasText: '进行中的交付' })
    await expect(deliveryCard.getByText('E2E 快捷需求')).toBeVisible()

    // 进入交付流水线可看到同一需求
    await page.locator('.sidebar').getByRole('link', { name: '交付流', exact: true }).click()
    await expect(
      page.locator('.delivery-list-panel').getByText('E2E 快捷需求')
    ).toBeVisible()
  })
})
