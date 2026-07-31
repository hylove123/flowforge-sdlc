/**
 * 01 — 登录/入口页与进入主界面流程
 *
 * 应用默认已登录（AppContext isAuthenticated 初始为 true），
 * 因此登录页通过「退出登录」到达，再验证登录/注册切换与重新登录。
 */
import { test, expect } from '@playwright/test'
import { gotoApp, logout, login, expectLoginPage, SEED_USERS } from './helpers.js'

test.describe('登录与入口', () => {
  test('打开根路径默认已登录，直接进入工作台', async ({ page }) => {
    await gotoApp(page)
    await expect(page.getByRole('heading', { name: `你好，${SEED_USERS.pm}` })).toBeVisible()
    await expect(page.locator('.sidebar-brand-text')).toHaveText('FlowForge')
    // 顶栏展示当前用户
    await expect(page.locator('.user-switcher-btn')).toContainText(SEED_USERS.pm)
  })

  test('退出登录后展示登录页', async ({ page }) => {
    await gotoApp(page)
    await logout(page)
    await expect(page.getByText('AI驱动的软件开发全生命周期平台')).toBeVisible()
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible()
    // 主界面骨架不再渲染
    await expect(page.locator('.sidebar')).toHaveCount(0)
  })

  test('未知用户登录提示「用户名或密码错误」', async ({ page }) => {
    await gotoApp(page)
    await logout(page)
    await page.getByPlaceholder('请输入用户名或邮箱').fill('不存在的用户')
    await page.getByPlaceholder('请输入密码').fill('whatever')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByText('用户名或密码错误')).toBeVisible()
  })

  test('空表单提交展示字段级校验提示', async ({ page }) => {
    await gotoApp(page)
    await logout(page)
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.getByText('请输入用户名或邮箱').last()).toBeVisible()
  })

  test('使用种子用户重新登录进入主界面', async ({ page }) => {
    await gotoApp(page)
    await logout(page)
    await login(page, SEED_USERS.architect)
    await expect(page.getByRole('heading', { name: `你好，${SEED_USERS.architect}` })).toBeVisible()
    await expect(page.locator('.user-switcher-btn')).toContainText(SEED_USERS.architect)
  })

  test('登录/注册模式可以互相切换', async ({ page }) => {
    await gotoApp(page)
    await logout(page)
    await page.getByText('还没有账号？立即注册').click()
    await expect(page.getByRole('button', { name: '注册' })).toBeVisible()
    await expect(page.getByPlaceholder('请输入姓名')).toBeVisible()
    await page.getByText('已有账号？返回登录').click()
    await expectLoginPage(page)
  })
})
