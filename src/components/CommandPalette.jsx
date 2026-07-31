/**
 * CommandPalette — global Cmd+K / Ctrl+K launcher (Phase 6 体验打磨)
 *
 *   路由跳转   every page route
 *   快捷动作   新建交付 / 重建索引 / 打开设置 (CustomEvents picked up by pages)
 *   知识搜索   tauri + sidecar ready → knowledge.search; web mode hides it
 *
 * Keyboard: ↑/↓ select · Enter run · Esc close. Mounted once at the App root.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, LayoutDashboard, FolderKanban, GitBranch, Bot, BookOpen,
  Cpu, Settings2, Workflow, Settings, FilePlus2, RefreshCw, BookMarked,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { useSidecar } from '@/context/SidecarContext'

// pages the palette can jump to (label + keywords feed the filter)
const ROUTE_COMMANDS = [
  { id: 'nav-dashboard', label: '仪表盘', keywords: 'dashboard home 首页', path: '/', icon: LayoutDashboard },
  { id: 'nav-projects', label: '项目', keywords: 'projects 项目列表', path: '/projects', icon: FolderKanban },
  { id: 'nav-pipeline', label: '流水线', keywords: 'pipeline 交付 流程', path: '/pipeline', icon: GitBranch },
  { id: 'nav-agents', label: '智能体', keywords: 'agents ai 机器人', path: '/agents', icon: Bot },
  { id: 'nav-knowledge', label: '知识库', keywords: 'knowledge 图谱 索引', path: '/knowledge', icon: BookOpen },
  { id: 'nav-models', label: '模型配置', keywords: 'models llm 模型', path: '/models', icon: Cpu },
  { id: 'nav-project-config', label: '项目配置', keywords: 'project config 仓库', path: '/project-config', icon: Settings2 },
  { id: 'nav-flow-editor', label: '流程编辑器', keywords: 'flow editor dag 编排', path: '/flow-editor', icon: Workflow },
  { id: 'nav-settings', label: '设置', keywords: 'settings 偏好', path: '/settings', icon: Settings },
]

export default function CommandPalette() {
  const navigate = useNavigate()
  const { currentProject, showToast } = useApp()
  const sidecar = useSidecar()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [knowledgeHits, setKnowledgeHits] = useState([])
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const knowledgeSearchAvailable = sidecar.mode === 'tauri' && sidecar.isReady

  // quick actions — pages listen for the CustomEvents after navigation
  // (dispatch is deferred one tick so a freshly-mounted page can attach its listener)
  const actionCommands = useMemo(() => [
    {
      id: 'act-new-delivery', label: '新建交付', keywords: 'new delivery requirement 需求',
      icon: FilePlus2, group: '快捷动作',
      run: () => {
        navigate('/')
        setTimeout(() => window.dispatchEvent(new CustomEvent('flowforge:create-requirement')), 80)
      },
    },
    {
      id: 'act-rebuild-index', label: '重建索引', keywords: 'rebuild index 代码索引',
      icon: RefreshCw, group: '快捷动作',
      run: () => {
        navigate('/knowledge')
        setTimeout(() => window.dispatchEvent(new CustomEvent('flowforge:rebuild-index')), 80)
      },
    },
    {
      id: 'act-open-settings', label: '打开设置', keywords: 'open settings 偏好',
      icon: Settings, group: '快捷动作',
      run: () => navigate('/settings'),
    },
  ], [navigate])

  // ─── global hotkey ────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // reset state whenever the palette opens
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
      setKnowledgeHits([])
      // focus after mount
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // ─── knowledge search (tauri only, debounced) ────────────────
  useEffect(() => {
    if (!open || !knowledgeSearchAvailable || query.trim().length < 2) {
      setKnowledgeHits([])
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await sidecar.invoke('knowledge.search', {
          projectId: currentProject?.id, query: query.trim(), topK: 5,
        })
        if (!cancelled) setKnowledgeHits(Array.isArray(res?.results) ? res.results : [])
      } catch {
        if (!cancelled) setKnowledgeHits([])
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, query, knowledgeSearchAvailable, sidecar, currentProject])

  // ─── filtering ────────────────────────────────────────────────
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (cmd) =>
      !q || cmd.label.toLowerCase().includes(q) || cmd.keywords.toLowerCase().includes(q)

    const routes = ROUTE_COMMANDS.filter(matches).map((c) => ({
      ...c, group: '页面', run: () => navigate(c.path),
    }))
    const actions = actionCommands.filter(matches)
    const knowledge = knowledgeHits.map((hit, i) => ({
      id: `kn-${i}`,
      label: hit.label || hit.text?.slice(0, 60) || '知识条目',
      sub: hit.type ? `${hit.type}${hit.stageId ? ` · ${hit.stageId}` : ''}` : undefined,
      icon: BookMarked,
      group: '知识搜索',
      run: () => navigate('/knowledge'),
    }))
    return [...routes, ...actions, ...knowledge]
  }, [query, actionCommands, knowledgeHits, navigate])

  useEffect(() => {
    setSelected((prev) => Math.min(prev, Math.max(items.length - 1, 0)))
  }, [items])

  const execute = (item) => {
    if (!item) return
    setOpen(false)
    try {
      item.run()
    } catch (e) {
      showToast?.(`命令执行失败：${e?.message || e}`, 'error')
    }
  }

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((prev) => (items.length ? (prev + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((prev) => (items.length ? (prev - 1 + items.length) % items.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      execute(items[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  // keep the selected row in view
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  let lastGroup = null
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', justifyContent: 'center', paddingTop: '15vh' }}
      onClick={() => setOpen(false)}
      role="presentation"
      data-testid="command-palette-overlay"
    >
      <div
        style={{ width: '560px', maxWidth: '92vw', height: 'fit-content', maxHeight: '60vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '12px', boxShadow: '0 16px 48px rgba(0,0,0,0.24)', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <Search size={16} style={{ color: 'var(--fg-tertiary)', flexShrink: 0 }} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={knowledgeSearchAvailable ? '搜索页面、动作或知识库…' : '搜索页面或动作…'}
            aria-label="命令搜索"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: '14px', color: 'var(--fg)' }}
          />
          <kbd style={{ fontSize: '11px', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: '4px', padding: '1px 5px' }}>Esc</kbd>
        </div>

        <div ref={listRef} role="listbox" aria-label="命令列表" style={{ overflowY: 'auto', padding: '6px' }}>
          {items.length === 0 && (
            <div style={{ padding: '18px', textAlign: 'center', fontSize: '13px', color: 'var(--fg-tertiary)' }}>
              没有匹配的命令
            </div>
          )}
          {items.map((item, i) => {
            const Icon = item.icon
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <React.Fragment key={item.id}>
                {header && (
                  <div style={{ padding: '6px 10px 2px', fontSize: '11px', color: 'var(--fg-muted)' }}>{header}</div>
                )}
                <div
                  role="option"
                  aria-selected={i === selected}
                  data-selected={i === selected}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => execute(item)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
                    background: i === selected ? 'color-mix(in srgb, var(--accent) 10%, var(--bg))' : 'transparent',
                    color: 'var(--fg)',
                  }}
                >
                  <Icon size={15} style={{ color: 'var(--fg-tertiary)', flexShrink: 0 }} aria-hidden="true" />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                  {item.sub && <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>{item.sub}</span>}
                </div>
              </React.Fragment>
            )
          })}
        </div>

        {!knowledgeSearchAvailable && (
          <div style={{ padding: '6px 14px', borderTop: '1px solid var(--border)', fontSize: '11px', color: 'var(--fg-muted)' }}>
            知识搜索需要桌面版（Tauri）且 sidecar 就绪
          </div>
        )}
      </div>
    </div>
  )
}
