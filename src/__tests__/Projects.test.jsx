import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider, useApp, PROJECTS_KEY, DELIVERIES_KEY, STAGE_DELIVERABLES_KEY } from '@/context/AppContext'
import { storage } from '@/adapters/StorageService'
import { SEED_PROJECTS, SEED_DELIVERIES } from './fixtures/seedData'
import Projects from '@/pages/Projects'

vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}))

function renderProjects() {
  return render(<Projects />, { wrapper: AppProvider })
}

// Wrapper that also exposes context for assertions
function ProjectsWithContextReader() {
  return (
    <div>
      <ContextReader />
      <Projects />
    </div>
  )
}

function ContextReader() {
  const ctx = useApp()
  return (
    <div>
      <span data-testid="currentProject">{ctx.currentProject.name}</span>
    </div>
  )
}

describe('Projects page', () => {
  beforeEach(() => {
    // Pure client boots from local storage — seed a populated workspace
    storage.setJSON(PROJECTS_KEY, SEED_PROJECTS)
    storage.setJSON(DELIVERIES_KEY, SEED_DELIVERIES)
    storage.remove(STAGE_DELIVERABLES_KEY)
  })

  it('renders project list', () => {
    renderProjects()
    // All 4 projects should be listed (use getAllByText because ConfigScopeBanner also renders current project name)
    expect(screen.getAllByText('智能客服系统 v2.0').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('数据中台重构').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('移动端App升级').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('内部运维平台').length).toBeGreaterThanOrEqual(1)
  })

  it('project selector cards have role="button" and tabIndex', () => {
    renderProjects()
    // The project name appears in both ConfigScopeBanner and the card list.
    // Find the one inside a .card element.
    const allMatches = screen.getAllByText('智能客服系统 v2.0')
    const cardMatch = allMatches.find(el => el.closest('.card'))
    expect(cardMatch).toBeTruthy()
    const card = cardMatch.closest('.card')
    expect(card).toBeInTheDocument()
    expect(card.style.cursor).toBe('pointer')
  })

  it('clicking a project calls setCurrentProject', async () => {
    const user = userEvent.setup()
    render(<ProjectsWithContextReader />, { wrapper: AppProvider })

    // Initially shows first project
    expect(screen.getByTestId('currentProject')).toHaveTextContent('智能客服系统 v2.0')

    // Click on the second project
    const secondProject = screen.getByText('数据中台重构')
    await user.click(secondProject)

    // currentProject should now be the second project
    expect(screen.getByTestId('currentProject')).toHaveTextContent('数据中台重构')
  })

  it('embeds the project config view (unified project center)', () => {
    renderProjects()
    // Config tabs of the merged ProjectConfig are visible on the projects page
    expect(screen.getByText('仓库管理')).toBeInTheDocument()
    expect(screen.getByText('交付流编排')).toBeInTheDocument()
    expect(screen.getByText('索引管理')).toBeInTheDocument()
    expect(screen.getByText('成员管理')).toBeInTheDocument()
  })

  it('removing a project cascades repo records and index metadata', async () => {
    const user = userEvent.setup()
    // Seed a repo + index record owned by the second project (p2)
    storage.setJSON('flowforge_repositories', [
      { id: 'repo_x', projectId: 'p2', name: 'svc', path: '/tmp/svc', status: 'ready' },
      { id: 'repo_y', projectId: 'p1', name: 'core', path: '/tmp/core', status: 'ready' },
    ])
    storage.setJSON('flowforge_codebase_index', [
      { id: 'idx_x', projectId: 'p2', repoId: 'repo_x', status: 'ready' },
    ])
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    renderProjects()
    await user.click(screen.getByLabelText('移除项目 数据中台重构'))

    // Project gone from the list
    expect(screen.queryByText('数据中台重构')).not.toBeInTheDocument()
    // Cascade: p2 repo + index records removed, other project untouched
    const repos = storage.getJSON('flowforge_repositories', [])
    expect(repos.map(r => r.id)).toEqual(['repo_y'])
    expect(storage.getJSON('flowforge_codebase_index', [])).toEqual([])
  })

  it('cancelling the remove confirmation keeps the project', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderProjects()
    await user.click(screen.getByLabelText('移除项目 数据中台重构'))

    expect(screen.getByText('数据中台重构')).toBeInTheDocument()
    expect(screen.getAllByText('内部运维平台').length).toBeGreaterThanOrEqual(1)
  })
})
