// Dashboard 交付驾驶舱测试（3.1）：KPI 基于真实阶段数与评审数据，
// 全链路状态板渲染阶段链，不再有 currentStageIndex < 8 类硬编码。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import { AppProvider, PROJECTS_KEY, DELIVERIES_KEY, STAGE_DELIVERABLES_KEY } from '@/context/AppContext'
import { storage } from '@/adapters/StorageService'
import { SEED_PROJECTS, SEED_DELIVERIES } from './fixtures/seedData'
import Dashboard from '@/pages/Dashboard'

vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}))

function renderDashboard() {
  return render(<Dashboard />, { wrapper: AppProvider })
}

describe('Dashboard delivery cockpit', () => {
  beforeEach(() => {
    storage.setJSON(PROJECTS_KEY, SEED_PROJECTS)
    storage.setJSON(DELIVERIES_KEY, SEED_DELIVERIES)
    // 两条真实评审记录 → 平均质量分 (90 + 80) / 2 = 85
    storage.setJSON(STAGE_DELIVERABLES_KEY, {
      d1: {
        req: { content: '需求', review: { totalScore: 90, passed: true }, generatedAt: '2026-06-25' },
        brd: { content: 'BRD', review: { totalScore: 80, passed: true }, generatedAt: '2026-06-26' },
      },
    })
  })

  it('KPIs come from real delivery/review data', () => {
    renderDashboard()
    const kpiGrid = screen.getByRole('list', { name: '关键指标' })
    // d1(idx 2/9)、d2(idx 5/9) 进行中；d3(idx 8/9) 已完成
    expect(within(kpiGrid).getByLabelText(/进行中交付/)).toHaveTextContent('2')
    // 无执行引擎 interrupted 会话 → 待确认门禁为 0
    expect(within(kpiGrid).getByLabelText(/等待人工确认门禁/)).toHaveTextContent('0')
    // 评审平均分 = (90 + 80) / 2
    expect(within(kpiGrid).getByLabelText(/平均质量分/)).toHaveTextContent('85')
  })

  it('全链路状态板 renders a stage chain per delivery with real stage count', () => {
    renderDashboard()
    // d1 的阶段链：默认 DAG 9 个阶段 pill
    const chain = screen.getByRole('list', { name: '智能客服对话引擎升级 阶段链' })
    expect(within(chain).getAllByRole('listitem')).toHaveLength(9)
    // 已完成交付标记「已完成」
    expect(screen.getByText('已完成')).toBeInTheDocument()
    // 阶段链中渲染 DAG 真实阶段 label（首尾阶段）
    expect(within(chain).getByText('交付')).toBeInTheDocument()
    expect(within(chain).getAllByRole('listitem')[0]).toBeTruthy()
  })

  it('has no hardcoded 8-stage progress or GPT-4o matrix remnants', () => {
    const { container } = renderDashboard()
    // 旧版硬编码 KPI 文案已移除
    expect(screen.queryByText('待评审任务')).not.toBeInTheDocument()
    expect(screen.queryByText('智能体运行中')).not.toBeInTheDocument()
    // Dashboard 不再渲染任何硬编码模型矩阵
    expect(container.textContent).not.toContain('GPT-4o-mini')
  })
})
