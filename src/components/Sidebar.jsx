import React, { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, FolderKanban, GitBranch, Bot, BookOpen, Brain, Settings, ChevronLeft, ChevronRight, Settings2, Workflow
} from 'lucide-react'

const navItems = [
  { path: '/', icon: LayoutDashboard, label: '工作台' },
  { path: '/projects', icon: FolderKanban, label: '项目' },
  { path: '/pipeline', icon: GitBranch, label: '交付流' },
  { path: '/flow-editor', icon: Workflow, label: '流程编排' },
  { path: '/agents', icon: Bot, label: '智能体' },
  { path: '/project-config', icon: Settings2, label: '配置中心' },
  { path: '/knowledge', icon: BookOpen, label: '知识库' },
  { path: '/models', icon: Brain, label: '模型配置' },
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
        {!collapsed && <div className="sidebar-section-label">主菜单</div>}
        {navItems.map(item => (
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
