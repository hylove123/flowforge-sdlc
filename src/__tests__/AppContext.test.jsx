import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider, useApp, buildInitialState, PROJECTS_KEY, DELIVERIES_KEY } from '@/context/AppContext'
import { storage } from '@/adapters/StorageService'

// Helper: renders a component that exposes context values via data-testid
function ContextReader() {
  const ctx = useApp()
  return (
    <div>
      <span data-testid="devMode">{ctx.devMode}</span>
      <span data-testid="currentUser">{ctx.currentUser ? ctx.currentUser.name : 'not-logged-in'}</span>
      <span data-testid="isAuthenticated">{ctx.isAuthenticated ? 'true' : 'false'}</span>
      <span data-testid="currentProject">{ctx.currentProject.name}</span>
      <span data-testid="projectCount">{ctx.projects.length}</span>
      <span data-testid="deliveryCount">{ctx.deliveries.length}</span>
      <span data-testid="deliveryTitles">{ctx.deliveries.map(d => d.title).join('|')}</span>
      <span data-testid="deliveryArchived">{ctx.deliveries.map(d => (d.archived ? '1' : '0')).join('')}</span>
      <span data-testid="toastCount">{ctx.toasts.length}</span>
      <span data-testid="toasts">{JSON.stringify(ctx.toasts)}</span>
      <span data-testid="notifStageComplete">{ctx.currentProject.notifications?.stageComplete ? 'true' : 'false'}</span>
      <button data-testid="setDevMode" onClick={() => ctx.setDevMode('cloud')}>setDevMode</button>
      <button data-testid="addToast" onClick={() => ctx.showToast('hello', 'info')}>addToast</button>
      <button data-testid="removeToast" onClick={() => { if (ctx.toasts.length) ctx.removeToast(ctx.toasts[0].id) }}>removeToast</button>
      <button data-testid="addProject" onClick={() => ctx.addProject({
        id: 'p-test', name: '测试项目', members: [], agents: [], skills: [{ name: 'S1', enabled: true }],
        rules: [], mcpTools: [], modelMatrix: [], reviewGates: [],
        notifications: { stageComplete: true }, pipeline: { stages: [] }, activities: [],
      })}>addProject</button>
      <button data-testid="setCurrentProject" onClick={() => { if (ctx.projects[0]) ctx.setCurrentProject(ctx.projects[0]) }}>setCurrentProject</button>
      <button data-testid="deleteProject" onClick={() => ctx.deleteProject('p-test')}>deleteProject</button>
      <button data-testid="toggleNotif" onClick={() => ctx.toggleNotification(ctx.currentProject.id, 'stageComplete')}>toggleNotif</button>
      <button data-testid="createDelivery" onClick={() => ctx.createDelivery({
        id: 'd-test', title: '测试需求', description: '', priority: 'P1',
        projectId: ctx.currentProject.id, assignee: '', currentStageIndex: 0, createdAt: '2026-01-01',
      })}>createDelivery</button>
      <button data-testid="updateDelivery" onClick={() => ctx.updateDelivery('d-test', { title: '改过的需求' })}>updateDelivery</button>
      <button data-testid="archiveDelivery" onClick={() => ctx.archiveDelivery('d-test', true)}>archiveDelivery</button>
      <button data-testid="unarchiveDelivery" onClick={() => ctx.archiveDelivery('d-test', false)}>unarchiveDelivery</button>
      <button data-testid="deleteDelivery" onClick={() => ctx.deleteDelivery('d-test')}>deleteDelivery</button>
      <button data-testid="doLogin" onClick={() => ctx.login(ctx.users[0])}>login</button>
      <button data-testid="doLogout" onClick={() => ctx.logout()}>logout</button>
    </div>
  )
}

function renderWithContext(ui) {
  return render(ui, { wrapper: AppProvider })
}

describe('AppContext', () => {
  beforeEach(() => {
    // pure client boots clean: wipe any persisted slices from other tests
    storage.remove(PROJECTS_KEY)
    storage.remove(DELIVERIES_KEY)
  })

  it('has correct initial state defaults (clean local workspace)', () => {
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('devMode')).toHaveTextContent('bridge-agent')
    // Single local workspace user, no demo accounts
    expect(screen.getByTestId('currentUser')).toHaveTextContent('我的工作区')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true')
    // No seeded projects — the empty-workspace placeholder is current
    expect(screen.getByTestId('projectCount')).toHaveTextContent('0')
    expect(screen.getByTestId('currentProject')).toHaveTextContent('未创建项目')
  })

  it('SET_DEV_MODE changes devMode', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    expect(screen.getByTestId('devMode')).toHaveTextContent('bridge-agent')
    await user.click(screen.getByTestId('setDevMode'))
    expect(screen.getByTestId('devMode')).toHaveTextContent('cloud')
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

  it('TOGGLE_NOTIFICATION toggles notification keys on the current project', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    await user.click(screen.getByTestId('addProject'))
    await user.click(screen.getByTestId('setCurrentProject'))
    expect(screen.getByTestId('notifStageComplete')).toHaveTextContent('true')
    await user.click(screen.getByTestId('toggleNotif'))
    expect(screen.getByTestId('notifStageComplete')).toHaveTextContent('false')
    await user.click(screen.getByTestId('toggleNotif'))
    expect(screen.getByTestId('notifStageComplete')).toHaveTextContent('true')
  })

  it('LOGIN/LOGOUT still flip auth state (actions kept for compatibility)', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    await user.click(screen.getByTestId('doLogout'))
    expect(screen.getByTestId('currentUser')).toHaveTextContent('not-logged-in')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('false')
    await user.click(screen.getByTestId('doLogin'))
    expect(screen.getByTestId('currentUser')).toHaveTextContent('我的工作区')
    expect(screen.getByTestId('isAuthenticated')).toHaveTextContent('true')
  })

  it('DELETE_PROJECT removes the project, its deliveries, and switches current', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    await user.click(screen.getByTestId('addProject'))
    await user.click(screen.getByTestId('setCurrentProject'))
    await user.click(screen.getByTestId('createDelivery'))
    expect(screen.getByTestId('projectCount')).toHaveTextContent('1')
    expect(screen.getByTestId('deliveryCount')).toHaveTextContent('1')

    await user.click(screen.getByTestId('deleteProject'))
    expect(screen.getByTestId('projectCount')).toHaveTextContent('0')
    // cascade: deliveries of the removed project are dropped too
    expect(screen.getByTestId('deliveryCount')).toHaveTextContent('0')
    // current project falls back to the empty-workspace placeholder
    expect(screen.getByTestId('currentProject')).toHaveTextContent('未创建项目')
  })

  it('delivery CRUD: create / update / archive / unarchive / delete', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    await user.click(screen.getByTestId('addProject'))
    await user.click(screen.getByTestId('setCurrentProject'))
    await user.click(screen.getByTestId('createDelivery'))
    expect(screen.getByTestId('deliveryTitles')).toHaveTextContent('测试需求')

    await user.click(screen.getByTestId('updateDelivery'))
    expect(screen.getByTestId('deliveryTitles')).toHaveTextContent('改过的需求')

    await user.click(screen.getByTestId('archiveDelivery'))
    expect(screen.getByTestId('deliveryArchived')).toHaveTextContent('1')

    await user.click(screen.getByTestId('unarchiveDelivery'))
    expect(screen.getByTestId('deliveryArchived')).toHaveTextContent('0')

    await user.click(screen.getByTestId('deleteDelivery'))
    expect(screen.getByTestId('deliveryCount')).toHaveTextContent('0')
  })

  it('persists projects and deliveries into local storage', async () => {
    const user = userEvent.setup()
    renderWithContext(<ContextReader />)
    await user.click(screen.getByTestId('addProject'))
    await user.click(screen.getByTestId('setCurrentProject'))
    await user.click(screen.getByTestId('createDelivery'))

    const savedProjects = storage.getJSON(PROJECTS_KEY, [])
    expect(savedProjects.map(p => p.id)).toContain('p-test')
    const savedDeliveries = storage.getJSON(DELIVERIES_KEY, [])
    expect(savedDeliveries.map(d => d.id)).toContain('d-test')
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

describe('buildInitialState', () => {
  beforeEach(() => {
    storage.remove(PROJECTS_KEY)
    storage.remove(DELIVERIES_KEY)
  })

  it('boots with a clean state: no demo users/projects/deliveries', () => {
    const state = buildInitialState()
    expect(state.projects).toEqual([])
    expect(state.deliveries).toEqual([])
    // Single local workspace user instead of demo users
    expect(state.users).toHaveLength(1)
    expect(state.users[0].name).toBe('我的工作区')
    expect(state.currentUser).toBe(state.users[0])
    // currentProject is a neutral placeholder (never null — pages dereference it)
    expect(state.currentProject).toBeTruthy()
    expect(state.currentProject.id).toBe('p-empty-workspace')
    // System default agents are kept: DEFAULT_STAGE_AGENTS binds stages to a1~a5
    expect(state.agents.map(a => a.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
  })

  it('hydrates persisted projects and deliveries', () => {
    storage.setJSON(PROJECTS_KEY, [{ id: 'p-x', name: '已存项目' }])
    storage.setJSON(DELIVERIES_KEY, [{ id: 'd-x', title: '已存需求', projectId: 'p-x', currentStageIndex: 0 }])
    const state = buildInitialState()
    expect(state.projects.map(p => p.name)).toEqual(['已存项目'])
    // stageConfigs get backfilled on load
    expect(state.projects[0].stageConfigs).toBeTruthy()
    expect(state.deliveries).toHaveLength(1)
    expect(state.currentProject.id).toBe('p-x')
  })
})
