/**
 * 02 — 侧边栏导航：各导航项点击后路由与页面标题正确
 *
 * 导航项与页面标题对照来自 src/components/Sidebar.jsx 与各页面组件的
 * page-header <h2>（Pipeline 页无固定 h2 标题，改验证面包屑「交付流水线」）。
 */
import { test, expect } from '@playwright/test'
import { gotoApp, clickSidebarNav } from './helpers.js'

const NAV_CASES = [
  { label: '项目', path: '/projects', heading: '项目管理' },
  { label: '流程编排', path: '/flow-editor', heading: '流程编排' },
  { label: '智能体', path: '/agents', heading: '智能体管理' },
  { label: '配置中心', path: '/project-config', heading: '项目配置中心' },
  { label: '知识库', path: '/knowledge', heading: '知识库' },
  { label: '模型配置', path: '/models', heading: '模型管理' },
  { label: '设置', path: '/settings', heading: '系统设置' },
]

test.describe('侧边栏导航', () => {
  test('依次点击各导航项，路由与页面标题正确', async ({ page }) => {
    await gotoApp(page)
    for (const { label, path, heading } of NAV_CASES) {
      await clickSidebarNav(page, label)
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expect(
        page.locator('.page-content').getByRole('heading', { name: heading, exact: true })
      ).toBeVisible()
      // 当前导航项获得 active 态
      await expect(
        page.locator('.sidebar').getByRole('link', { name: label, exact: true })
      ).toHaveClass(/active/)
    }
  })

  test('交付流导航进入流水线页（面包屑校验）', async ({ page }) => {
    await gotoApp(page)
    await clickSidebarNav(page, '交付流')
    await expect(page).toHaveURL(/\/pipeline$/)
    await expect(page.locator('.breadcrumb-current')).toContainText('交付流水线')
  })

  test('工作台导航回到首页', async ({ page }) => {
    await gotoApp(page, '/settings')
    await clickSidebarNav(page, '工作台')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: /你好，/ })).toBeVisible()
  })

  test('未知路由重定向回工作台', async ({ page }) => {
    await gotoApp(page, '/no-such-route')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: /你好，/ })).toBeVisible()
  })

  test('侧边栏可以收起与展开', async ({ page }) => {
    await gotoApp(page)
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/)
    await expect(page.locator('.sidebar-brand-text')).toHaveCount(0)
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/)
    await expect(page.locator('.sidebar-brand-text')).toBeVisible()
  })
})
