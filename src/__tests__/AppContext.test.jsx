import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider, useApp, buildInitialState } from '@/context/AppContext'

// Helper: renders a component that exposes context values via data-testid
function ContextReader() {
  const ctx = useApp()
  return (
    <div>
      <span data-testid="devMode">{ctx.devMode}</span>
      <span data-testid="currentUser">{ctx.currentUser ? ctx.currentUser.name : 'not-logged-in'}</span>
      <span data-testid="isAuthenticated">{ctx.isAuthenticated ? 'true' : 'false'}</span>
      <span data-testid="currentProject">{ctx.currentProject.name}</span>
      <span data-testid="toastCount">{ctx.toasts.length}</span>
      <span data-testid="toasts">{JSON.stringify(ctx.toasts)}</span>
      <button data-testid="setDevMode" onClick={() => ctx.setDevMode('cloud')}>setDevMode</button>
      <button data-testid="setCurrentProject" onClick={() => ctx.setCurrentProject(ctx.projects[1])}>setCurrentProject</button>
      <button data-testid="addToast" onClick={() => ctx.showToast('hello', 'info')}>addToast</button>
      <button data-testid="removeToast" onClick={() => { if (ctx.toasts.length) ctx.removeToast(ctx.toasts[0].id) }}>removeToast</button>
      <button data-testid="toggleSkill" onClick={() => {
        const skill = ctx.currentProject.skills[0]
        if (skill) ctx.toggleProjectConfigItem(ctx.currentProject.id, 'skills', skill.name)
      }}>toggleSkill</button>
      <button data-testid="toggleRule" onClick={() => {
        const rule = ctx.currentProject.rules[0]
        if (rule) ctx.toggleProjectConfigItem(ctx.currentProject.id, 'rules', rule.name)
      }}>toggleRule</button>
      <button data-testid="toggleMcp" onClick={() => {
        const tool = ctx.currentProject.mcpTools[0]
        if (tool) ctx.toggleProjectConfigItem(ctx.currentProject.id, 'mcpTools', tool.name)
      }}>toggleMcp</button>
      <button data-testid="toggleNotif" onClick={() => {
        ctx.toggleNotification(ctx.currentProject.id, 'stageComplete')
      }}>toggleNotif</button>
      <button data-testid="doLogin" onClick={() => ctx.login(ctx.users[0])}>login</button>
      <button data-testid="doLogout" onClick={() => ctx.logout()}>logout</button>
      <span data-testid="skillEnabled">{ctx.currentProject.skills[0]?.enabled ? 'true' : 'false'}</span>
      <span data-testid="ruleEnabled">{ctx.currentProject.rules[0]?.enabled ? 'true' : 'false'}</span>
      <span data-testid="mcpEnabled">{ctx.currentProject.mcpTools[0]?.enabled ? 'true' : 'false'}</span>
      <span data-testid="notifStageComplete">{ctx.currentProject.notifications?.stageComplete ? 'true' : 'false'}</span>
    </div>
  )
}

function renderWithContext(ui) {
  return render(ui, { wrapper: AppProvider })
}

describe('AppContext', () => {
  it('has correct initial state defaults', () => {
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('devMode')).toHaveTextContent('bridge-agent')
    // The app now boots with a default logged-in user (users[0] = 张明)
    expect(screen.getByTestId('currentUser')).toHaveTextContent('张明')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true')
    // currentProject defaults to projects[0]
    expect(screen.getByTestId('currentProject')).toHaveTextContent('智能客服系统 v2.0')
  })

  it('SET_DEV_MODE changes devMode', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('devMode')).toHaveTextContent('bridge-agent')
    await user.click(screen.getByTestId('setDevMode'))
    expect(screen.getByTestId('devMode')).toHaveTextContent('cloud')
  })

  it('SET_CURRENT_PROJECT changes currentProject', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('currentProject')).toHaveTextContent('智能客服系统 v2.0')
    await user.click(screen.getByTestId('setCurrentProject'))
    expect(screen.getByTestId('currentProject')).toHaveTextContent('数据中台重构')
  })

  it('ADD_TOAST adds a toast and REMOVE_TOAST removes it', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('toastCount')).toHaveTextContent('0')

    await user.click(screen.getByTestId('addToast'))
    expect(screen.getByTestId('toastCount')).toHaveTextContent('1')
    const toasts = JSON.parse(screen.getByTestId('toasts').textContent)
    expect(toasts[0].message).toBe('hello')
    expect(toasts[0].type).toBe('info')

    await user.click(screen.getByTestId('removeToast'))
    expect(screen.getByTestId('toastCount')).toHaveTextContent('0')
  })

  it('TOGGLE_PROJECT_CONFIG_ITEM toggles skill enabled state', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('skillEnabled')).toHaveTextContent('true')
    await user.click(screen.getByTestId('toggleSkill'))
    expect(screen.getByTestId('skillEnabled')).toHaveTextContent('false')
    await user.click(screen.getByTestId('toggleSkill'))
    expect(screen.getByTestId('skillEnabled')).toHaveTextContent('true')
  })

  it('TOGGLE_PROJECT_CONFIG_ITEM toggles rule enabled state', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('ruleEnabled')).toHaveTextContent('true')
    await user.click(screen.getByTestId('toggleRule'))
    expect(screen.getByTestId('ruleEnabled')).toHaveTextContent('false')
  })

  it('TOGGLE_PROJECT_CONFIG_ITEM toggles mcpTool enabled state', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('mcpEnabled')).toHaveTextContent('true')
    await user.click(screen.getByTestId('toggleMcp'))
    expect(screen.getByTestId('mcpEnabled')).toHaveTextContent('false')
  })

  it('TOGGLE_NOTIFICATION toggles notification keys', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    // p1 notifications.stageComplete starts as true
    expect(screen.getByTestId('notifStageComplete')).toHaveTextContent('true')
    await user.click(screen.getByTestId('toggleNotif'))
    expect(screen.getByTestId('notifStageComplete')).toHaveTextContent('false')
    await user.click(screen.getByTestId('toggleNotif'))
    expect(screen.getByTestId('notifStageComplete')).toHaveTextContent('true')
  })

  it('LOGIN sets currentUser and isAuthenticated', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    // Log out first to reach the unauthenticated state, then log back in
    await user.click(screen.getByTestId('doLogout'))
    expect(screen.getByTestId('currentUser')).toHaveTextContent('not-logged-in')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('false')
    await user.click(screen.getByTestId('doLogin'))
    expect(screen.getByTestId('currentUser')).toHaveTextContent('张明')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true')
  })

  it('LOGOUT clears currentUser and isAuthenticated', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    await user.click(screen.getByTestId('doLogin'))
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true')
    await user.click(screen.getByTestId('doLogout'))
    expect(screen.getByTestId('currentUser')).toHaveTextContent('not-logged-in')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('false')
  })

  it('useApp throws outside provider', () => {
    // Suppress error boundary console output
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function BadComponent() {
      useApp()
      return null
    }
    expect(() => render(<BadComponent />)).toThrow('useApp must be used within an AppProvider')
    spy.mockRestore()
  })
})

describe('buildInitialState runtime branching', () => {
  it('tauri mode boots with a clean state: no demo users/projects/deliveries', () => {
    // detectRuntimeMode honors the window.__FLOWFORGE_MODE__ override
    window.__FLOWFORGE_MODE__ = 'tauri'
    try {
      const state = buildInitialState()
      expect(state.projects).toEqual([])
      expect(state.deliveries).toEqual([])
      // Single local workspace user instead of demo users
      expect(state.users).toHaveLength(1)
      expect(state.users[0].name).toBe('我的工作区')
      expect(state.currentUser).toBe(state.users[0])
      // currentProject is a neutral placeholder (never null — pages dereference it)
      expect(state.currentProject).toBeTruthy()
      expect(state.currentProject.name).not.toBe('智能客服系统 v2.0')
      // System default agents are kept: DEFAULT_STAGE_AGENTS binds stages to a1~a5
      expect(state.agents.map(a => a.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
    } finally {
      delete window.__FLOWFORGE_MODE__
    }
  })

  it('web mode keeps the demo seed (protects Playwright e2e)', () => {
    const state = buildInitialState('web')
    expect(state.projects.map(p => p.name)).toContain('智能客服系统 v2.0')
    expect(state.users.map(u => u.name)).toEqual(['张明', '李华', '王磊'])
    expect(state.deliveries).toHaveLength(3)
    expect(state.currentProject).toBe(state.projects[0])
  })
})
