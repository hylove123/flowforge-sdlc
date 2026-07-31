/**
 * 03 — Dashboard 渲染与项目列表 / 创建项目流程
 *
 * 覆盖：KPI 卡片、项目列表、FlywheelPanel 在 Web 模式下的降级占位、
 * 新建项目对话框（创建 / 取消）、进行中的交付区块、项目管理页列表。
 */
import { test, expect } from '@playwright/test'
import { gotoApp, activeDialog, SEED_PROJECTS } from './helpers.js'

test.describe('Dashboard 与项目', () => {
  test('Dashboard 渲染 KPI 卡片与项目列表', async ({ page }) => {
    await gotoApp(page)
    await expect(page.locator('.kpi-card')).toHaveCount(4)
    for (const label of ['活跃项目', '待评审任务', '智能体运行中', '本周交付']) {
      await expect(page.locator('.kpi-label', { hasText: label })).toBeVisible()
    }
    const projectCard = page.locator('.card', { hasText: '进行中的项目' })
    for (const name of SEED_PROJECTS) {
      await expect(projectCard.getByText(name)).toBeVisible()
    }
  })

  test('FlywheelPanel 在 Web 模式下展示降级占位符', async ({ page }) => {
    await gotoApp(page)
    const panel = page.getByTestId('flywheel-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('知识飞轮需要桌面版')).toBeVisible()
    await expect(panel.getByText('Web 模式下暂不可用')).toBeVisible()
    // 刷新按钮仅在 sidecar 就绪时出现
    await expect(panel.getByRole('button', { name: /刷新/ })).toHaveCount(0)
  })

  test('新建项目：填写表单创建后出现在项目列表', async ({ page }) => {
    await gotoApp(page)
    const projectCard = page.locator('.card', { hasText: '进行中的项目' })
    await projectCard.getByRole('button', { name: '新建项目' }).click()

    const dialog = activeDialog(page)
    await expect(dialog.getByRole('heading', { name: '新建项目' })).toBeVisible()
    await dialog.locator('#cp-name').fill('E2E 验证项目')
    await dialog.locator('#cp-stage').selectOption('需求分析')
    await dialog.getByText('张明').click() // 勾选成员
    await dialog.getByRole('button', { name: '创建' }).click()

    await expect(activeDialog(page)).toHaveCount(0)
    await expect(projectCard.getByText('E2E 验证项目')).toBeVisible()
  })

  test('新建项目：取消不产生新项目', async ({ page }) => {
    await gotoApp(page)
    const projectCard = page.locator('.card', { hasText: '进行中的项目' })
    await projectCard.getByRole('button', { name: '新建项目' }).click()
    const dialog = activeDialog(page)
    await dialog.locator('#cp-name').fill('不应存在的项目')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(activeDialog(page)).toHaveCount(0)
    await expect(projectCard.getByText('不应存在的项目')).toHaveCount(0)
  })

  test('进行中的交付区块展示当前项目的交付需求', async ({ page }) => {
    await gotoApp(page)
    const deliveryCard = page.locator('.card', { hasText: '进行中的交付' })
    await expect(deliveryCard.getByText('智能客服对话引擎升级')).toBeVisible()
    await expect(deliveryCard.getByText('移动端消息推送SDK')).toBeVisible()
  })

  test('点击项目卡片跳转交付流水线', async ({ page }) => {
    await gotoApp(page)
    const projectCard = page.locator('.card', { hasText: '进行中的项目' })
    await projectCard.getByText(SEED_PROJECTS[0]).click()
    await expect(page).toHaveURL(/\/pipeline$/)
    await expect(page.locator('.breadcrumb-current')).toContainText('交付流水线')
  })

  test('项目管理页加载全部种子项目', async ({ page }) => {
    await gotoApp(page, '/projects')
    await expect(page.getByRole('heading', { name: '项目管理' })).toBeVisible()
    for (const name of SEED_PROJECTS) {
      await expect(page.locator('.page-content').getByText(name).first()).toBeVisible()
    }
  })
})
