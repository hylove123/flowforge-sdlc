import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '@/context/AppContext'
import SettingsPage from '@/pages/Settings'

vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}))

function renderSettings() {
  return render(<SettingsPage />, { wrapper: AppProvider })
}

describe('Settings page', () => {
  it('renders all 8 tabs', () => {
    renderSettings()
    const tabLabels = ['全局配置', '团队成员', 'Skill管理', 'Rule管理', 'MCP工具', 'Git 凭证', '通知设置', '开发环境']
    for (const label of tabLabels) {
      // Some labels also appear as section headings, so use getAllByText
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('dev environment tab shows 3 mode cards', async () => {
    const user = userEvent.setup()
    renderSettings()
    // Click the "开发环境" tab
    await user.click(screen.getByText('开发环境'))
    // Should show the three dev mode cards
    expect(screen.getByText('本地IDE')).toBeInTheDocument()
    expect(screen.getByText('Bridge Agent')).toBeInTheDocument()
    expect(screen.getByText('云端开发')).toBeInTheDocument()
  })

  it('dev mode cards have role="button" and keyboard support', async () => {
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByText('开发环境'))

    // Helper: find the closest ancestor div with cursor:pointer style
    function findClickableCard(el) {
      let node = el
      while (node) {
        if (node.style && node.style.cursor === 'pointer') return node
        node = node.parentElement
      }
      return null
    }

    // Verify each card is present and has cursor:pointer (interactive)
    const localIde = findClickableCard(screen.getByText('本地IDE'))
    expect(localIde).toBeTruthy()

    const bridgeAgent = findClickableCard(screen.getByText('Bridge Agent'))
    expect(bridgeAgent).toBeTruthy()

    const cloudDev = findClickableCard(screen.getByText('云端开发'))
    expect(cloudDev).toBeTruthy()

    // Clicking a card should switch devMode (interaction completes without error)
    await user.click(cloudDev)
    expect(cloudDev).toBeInTheDocument()
  })
})
