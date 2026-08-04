// Pipeline × sidecar 事件闭环测试（1.1 回写 / 1.2 门禁确认 / 驳回通知）
// 通过 mock SidecarContext 伪造 tauri 模式并捕获事件订阅 handler，
// 手动触发 graph/* 事件验证 UI 与存储回写。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { AppProvider, PROJECTS_KEY, DELIVERIES_KEY, STAGE_DELIVERABLES_KEY } from '@/context/AppContext'
import { storage } from '@/adapters/StorageService'
import { SEED_PROJECTS, SEED_DELIVERIES } from './fixtures/seedData'
import Pipeline from '@/pages/Pipeline'

vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}))

// Fake sidecar：tauri + ready，捕获 graph 事件订阅 handler
vi.mock('@/context/SidecarContext', () => {
  const handlers = []
  return {
    __handlers: handlers,
    useSidecar: () => ({
      mode: 'tauri',
      isReady: true,
      invoke: vi.fn(async () => ({ ok: true, threadId: 'p1_d1', status: 'running' })),
      onEvent: (_evt, handler) => { handlers.push(handler); return () => {} },
    }),
  }
})

import { __handlers } from '@/context/SidecarContext'

function emit(method, params) {
  act(() => {
    for (const h of __handlers) h({ method, params })
  })
}

describe('Pipeline graph event loop (harness backbone)', () => {
  beforeEach(() => {
    __handlers.length = 0
    storage.setJSON(PROJECTS_KEY, SEED_PROJECTS)
    storage.setJSON(DELIVERIES_KEY, SEED_DELIVERIES)
    storage.remove(STAGE_DELIVERABLES_KEY)
  })

  it('review gate interrupt renders the 门禁确认 card with confirm/reject actions', () => {
    render(<Pipeline />, { wrapper: AppProvider })
    emit('graph/interrupted', {
      threadId: 'p1_d1',
      next: ['review'],
      currentStage: 'dev',
      interrupts: [{ node: 'review', value: { stage: 'review', reason: 'review_gate' } }],
    })
    expect(screen.getByText(/门禁待确认/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /确认进入评审/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /人工驳回/ })).toBeInTheDocument()
  })

  it('stage_done writes the deliverable and review back to storage (回写闭环)', () => {
    render(<Pipeline />, { wrapper: AppProvider })
    emit('graph/stage_done', {
      threadId: 'p1_d1',
      deliveryId: 'd1',
      stage: 'req',
      content: '引擎生成的需求文档',
      reviewScore: 88,
      passed: true,
      review: { totalScore: 88, passed: true, suggestions: [], dimensions: {} },
    })
    const saved = storage.getJSON(STAGE_DELIVERABLES_KEY, {})
    expect(saved.d1.req.content).toBe('引擎生成的需求文档')
    expect(saved.d1.req.review.totalScore).toBe(88)
  })

  it('review_rejected shows the rejection bar with abort-auto-retry action', () => {
    render(<Pipeline />, { wrapper: AppProvider })
    emit('graph/review_rejected', {
      threadId: 'p1_d1',
      score: 55,
      threshold: 75,
      retryCount: 1,
      retryTarget: 'dev',
    })
    expect(screen.getByRole('button', { name: /中止自动重试/ })).toBeInTheDocument()
  })

  it('delegate interrupt shows the external-deliverable guidance instead of the review card', () => {
    render(<Pipeline />, { wrapper: AppProvider })
    emit('graph/interrupted', {
      threadId: 'p1_d1',
      next: ['dev'],
      currentStage: 'dev',
      interrupts: [{ node: 'dev', value: { stage: 'dev', mode: 'delegate', reason: 'awaiting_external_deliverable' } }],
    })
    expect(screen.getByText(/等待外部交付物/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /确认进入评审/ })).not.toBeInTheDocument()
  })
})
