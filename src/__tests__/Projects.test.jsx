import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider, useApp } from '@/context/AppContext'
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
})
