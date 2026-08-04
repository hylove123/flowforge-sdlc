import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '@/context/AppContext'
import CommandPalette from '@/components/CommandPalette'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

// Renders in web mode (no SidecarProvider → default context, knowledge search hidden)
function renderPalette() {
  return render(<CommandPalette />, { wrapper: AppProvider })
}

function openPalette() {
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
}

describe('CommandPalette', () => {
  beforeEach(() => {
    mockNavigate.mockClear()
  })

  it('opens with Cmd+K and closes with Esc', async () => {
    renderPalette()
    expect(screen.queryByTestId('command-palette-overlay')).not.toBeInTheDocument()

    openPalette()
    expect(screen.getByTestId('command-palette-overlay')).toBeInTheDocument()
    // route commands are listed by default
    expect(screen.getByText('仪表盘')).toBeInTheDocument()
    expect(screen.getByText('流水线')).toBeInTheDocument()

    const input = screen.getByLabelText('命令搜索')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('command-palette-overlay')).not.toBeInTheDocument()
  })

  it('toggles on repeated Cmd+K / Ctrl+K', () => {
    renderPalette()
    openPalette()
    expect(screen.getByTestId('command-palette-overlay')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true })
    expect(screen.queryByTestId('command-palette-overlay')).not.toBeInTheDocument()
  })

  it('filters commands by query and shows empty state for no match', async () => {
    const user = userEvent.setup()
    renderPalette()
    openPalette()

    const input = screen.getByLabelText('命令搜索')
    await user.type(input, '知识')
    expect(screen.getByText('知识库')).toBeInTheDocument()
    expect(screen.queryByText('流水线')).not.toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'zzz-no-such-command')
    expect(screen.getByText('没有匹配的命令')).toBeInTheDocument()
  })

  it('executes a route command with Enter and closes', async () => {
    const user = userEvent.setup()
    renderPalette()
    openPalette()

    const input = screen.getByLabelText('命令搜索')
    await user.type(input, '设置')
    // first match is the 设置 route command
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockNavigate).toHaveBeenCalledWith('/settings')
    expect(screen.queryByTestId('command-palette-overlay')).not.toBeInTheDocument()
  })

  it('navigates the selection with arrow keys before executing', async () => {
    renderPalette()
    openPalette()

    const input = screen.getByLabelText('命令搜索')
    // default selection = 仪表盘 (/), ArrowDown → 项目 (/projects)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockNavigate).toHaveBeenCalledWith('/projects')
  })

  it('runs a quick action by click (重建索引 → /projects + CustomEvent)', async () => {
    vi.useFakeTimers()
    try {
      const listener = vi.fn()
      window.addEventListener('flowforge:rebuild-index', listener)
      renderPalette()
      openPalette()

      fireEvent.click(screen.getByText('重建索引'))
      expect(mockNavigate).toHaveBeenCalledWith('/projects')
      // CustomEvent dispatch is deferred so the target page can mount first
      vi.advanceTimersByTime(100)
      expect(listener).toHaveBeenCalledTimes(1)
      window.removeEventListener('flowforge:rebuild-index', listener)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides knowledge search in web mode', () => {
    renderPalette()
    openPalette()
    expect(screen.getByText('知识搜索需要桌面版（Tauri）且 sidecar 就绪')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('搜索页面或动作…')).toBeInTheDocument()
  })
})
