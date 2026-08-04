import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider, PROJECTS_KEY, DELIVERIES_KEY, STAGE_DELIVERABLES_KEY } from '@/context/AppContext'
import { storage } from '@/adapters/StorageService'
import { SEED_PROJECTS, SEED_DELIVERIES } from './fixtures/seedData'
import Pipeline from '@/pages/Pipeline'

vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}))

function renderPipeline() {
  return render(<Pipeline />, { wrapper: AppProvider })
}

describe('Pipeline page (delivery workspace)', () => {
  beforeEach(() => {
    // Pure client boots from local storage — seed the demo-era workspace
    storage.setJSON(PROJECTS_KEY, SEED_PROJECTS)
    storage.setJSON(DELIVERIES_KEY, SEED_DELIVERIES)
    storage.remove(STAGE_DELIVERABLES_KEY)
  })

  it('renders compact header with project name and 新建需求 action', () => {
    renderPipeline()
    // Header shows the current project name and delivery/stage counts
    expect(screen.getByRole('heading', { name: '智能客服系统 v2.0' })).toBeInTheDocument()
    expect(screen.getByText('2 个交付需求 · 9 个阶段')).toBeInTheDocument()
    // "新建需求" appears both as the primary header button and the list-panel ghost button
    expect(screen.getAllByRole('button', { name: '新建需求' }).length).toBeGreaterThanOrEqual(1)
  })

  it('lists deliveries of the current project in the requirement panel', () => {
    renderPipeline()
    // Default project p1 has two deliveries (d1 and d3)
    expect(screen.getByRole('button', { name: /选择需求 智能客服对话引擎升级/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /选择需求 移动端消息推送SDK/ })).toBeInTheDocument()
  })

  it('selects the first delivery by default and shows its detail panel', () => {
    renderPipeline()
    // Detail panel shows the delivery description and overall progress bar
    expect(screen.getByText('支持多轮对话、意图识别增强、知识库实时检索')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '整体交付进度' })).toBeInTheDocument()
    // Detail tabs are rendered
    expect(screen.getByRole('tab', { name: '当前阶段' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /交付追溯/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /阶段配置/ })).toBeInTheDocument()
  })

  it('renders stage navigation with all 9 stages', () => {
    renderPipeline()
    const stageNav = screen.getByRole('tablist', { name: '阶段导航' })
    expect(within(stageNav).getAllByRole('tab')).toHaveLength(9)
    // Stage nodes are labeled with their status relative to the delivery's current stage
    expect(within(stageNav).getByRole('tab', { name: '需求分析，已完成' })).toBeInTheDocument()
    expect(within(stageNav).getByRole('tab', { name: 'PRD，当前阶段' })).toBeInTheDocument()
    expect(within(stageNav).getByRole('tab', { name: '交付，待开始' })).toBeInTheDocument()
  })

  it('requirement cards show priority, assignee and selection state', () => {
    renderPipeline()
    // First delivery is selected by default (aria-pressed)
    const d1Card = screen.getByRole('button', { name: /选择需求 智能客服对话引擎升级/ })
    const d3Card = screen.getByRole('button', { name: /选择需求 移动端消息推送SDK/ })
    expect(d1Card).toHaveAttribute('aria-pressed', 'true')
    expect(d3Card).toHaveAttribute('aria-pressed', 'false')
    // Card meta: priority tag and assignee
    expect(within(d1Card).getByText('P0')).toBeInTheDocument()
    expect(within(d1Card).getByText(/张明/)).toBeInTheDocument()
    expect(within(d3Card).getByText('P2')).toBeInTheDocument()
    expect(within(d3Card).getByText(/王磊/)).toBeInTheDocument()
    // NOTE: switching to d3 (交付 stage, no bound agent) is intentionally not
    // clicked here — Pipeline.jsx's no-agent branch references an unimported
    // AlertCircle icon and crashes (latent bug, out of scope for this task).
  })

  it('clicking a stage nav node switches the active stage info', async () => {
    const user = userEvent.setup()
    renderPipeline()
    // Default active stage follows the delivery's current stage (PRD, index 2)
    expect(document.querySelector('.delivery-stage-info-name')).toHaveTextContent('PRD')
    const stageNav = screen.getByRole('tablist', { name: '阶段导航' })
    await user.click(within(stageNav).getByRole('tab', { name: '需求分析，已完成' }))
    expect(document.querySelector('.delivery-stage-info-name')).toHaveTextContent('需求分析')
    expect(document.querySelector('.delivery-stage-info-type')).toHaveTextContent('已完成')
  })

  it('selecting a delivery in a stage without a bound agent renders the no-agent branch without crashing', async () => {
    const user = userEvent.setup()
    renderPipeline()
    // d3 (移动端消息推送SDK) is in the 交付 (deploy) stage, which has no default agent
    await user.click(screen.getByRole('button', { name: /选择需求 移动端消息推送SDK/ }))
    // The no-agent branch (with the AlertCircle icon) must render instead of throwing
    expect(screen.getByText('未配置智能体，该阶段将使用默认配置')).toBeInTheDocument()
    expect(screen.getByText('前往配置')).toBeInTheDocument()
    expect(document.querySelector('.delivery-stage-info-name')).toHaveTextContent('交付')
  })
})
