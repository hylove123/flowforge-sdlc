import React, { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, FolderKanban, GitBranch, Bot, BookOpen, Brain, Settings, ChevronLeft, ChevronRight
} from 'lucide-react'

// 3.2 信息架构收敛：「交付」为主区，「配置」为次区，「知识」独立；
// 流程编排（低频）不再占一级导航，入口收敛到项目配置与 Cmd+K 面板
const navGroups = [
  {
    label: '交付',
    items: [
      { path: '/', icon: LayoutDashboard, label: '仪表盘' },
      { path: '/pipeline', icon: GitBranch, label: '流水线' },
    ],
  },
  {
    label: '配置',
    items: [
      { path: '/projects', icon: FolderKanban, label: '项目' },
      { path: '/agents', icon: Bot, label: '智能体' },
      { path: '/models', icon: Brain, label: '模型配置' },
    ],
  },
  {
    label: '知识',
    items: [
      { path: '/knowledge', icon: BookOpen, label: '知识库' },
    ],
  },
]

const bottomItems = [
  { path: '/settings', icon: Settings, label: '设置' },
]

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Brand */}
      <div className="sidebar-brand">
        <div className="sidebar-brand-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        {!collapsed && <span className="sidebar-brand-text">FlowForge</span>}
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        {navGroups.map(group => (
          <React.Fragment key={group.label}>
            {!collapsed && <div className="sidebar-section-label">{group.label}</div>}
            {group.items.map(item => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <item.icon size={18} />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </React.Fragment>
        ))}
      </nav>

      {/* Bottom Items */}
      <div style={{ marginTop: 'auto', padding: 'var(--space-3)' }}>
        {bottomItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
            title={collapsed ? item.label : undefined}
          >
            <item.icon size={18} />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </div>

      {/* Collapse Button */}
      <div
        className="sidebar-collapse-btn"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
      >
        {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        {!collapsed && <span>收起侧边栏</span>}
      </div>
    </aside>
  )
}
