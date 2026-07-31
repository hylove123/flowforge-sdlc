/**
 * e2e 通用辅助（Web 模式）
 *
 * 应用特性（见 src/context/AppContext.jsx）：
 * - 初始状态 isAuthenticated = true，默认用户「张明」，打开根路径即进入主界面；
 * - 登录页仅在退出登录后出现（App.jsx 中 !isAuthenticated 时渲染 Login）；
 * - 登录校验只匹配用户名/邮箱（demo 逻辑，密码非空即可）；
 * - 业务状态保存在内存 reducer 中，每个新浏览器上下文都是干净的种子数据，
 *   无需额外注入 localStorage。
 */
import { expect } from '@playwright/test'

/** 种子用户（AppContext 内置） */
export const SEED_USERS = {
  pm: '张明',
  architect: '李华',
  tester: '王磊',
}

/** 种子项目名（AppContext 内置 p1~p4） */
export const SEED_PROJECTS = [
  '智能客服系统 v2.0',
  '数据中台重构',
  '移动端App升级',
  '内部运维平台',
]

/**
 * 屏蔽外部网络请求（如 Google Fonts）。
 * 离线/受限网络下外部 CSS 会阻塞页面 load 事件导致 goto 超时，
 * e2e 只关心本地应用行为，直接 abort 所有非 127.0.0.1 请求。
 */
export async function blockExternalRequests(page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => route.abort())
}

/** 打开应用并等待主界面（侧边栏 + 顶栏）就绪 */
export async function gotoApp(page, path = '/') {
  await blockExternalRequests(page)
  await page.goto(path)
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.topbar')).toBeVisible()
}

/** 等待登录页渲染完成 */
export async function expectLoginPage(page) {
  await expect(page.getByRole('heading', { name: 'FlowForge SDLC' })).toBeVisible()
  await expect(page.getByPlaceholder('请输入用户名或邮箱')).toBeVisible()
  await expect(page.getByPlaceholder('请输入密码')).toBeVisible()
}

/** 通过顶栏用户菜单退出登录，回到登录页 */
export async function logout(page) {
  await page.locator('.user-switcher-btn').click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await expectLoginPage(page)
}

/** 在登录页填写表单登录并等待主界面 */
export async function login(page, name = SEED_USERS.pm, password = 'e2e-demo') {
  await page.getByPlaceholder('请输入用户名或邮箱').fill(name)
  await page.getByPlaceholder('请输入密码').fill(password)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
}

/** 点击侧边栏导航项（NavLink 渲染为 link role） */
export async function clickSidebarNav(page, label) {
  await page.locator('.sidebar').getByRole('link', { name: label, exact: true }).click()
}

/** 当前打开的模态对话框（role=dialog） */
export function activeDialog(page) {
  return page.getByRole('dialog')
}
