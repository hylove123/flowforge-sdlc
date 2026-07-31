import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { useNavigate } from 'react-router-dom'

export default function TopBar() {
  const { projects, currentProject, currentUser, setCurrentProject, logout, showToast } = useApp()
  const navigate = useNavigate()
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  const [userDropdownOpen, setUserDropdownOpen] = useState(false)
  const projectRef = useRef(null)
  const userRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (projectRef.current && !projectRef.current.contains(e.target)) {
        setProjectDropdownOpen(false)
      }
      if (userRef.current && !userRef.current.contains(e.target)) {
        setUserDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="topbar">
      <a href="#main-content" className="skip-to-content">跳过导航</a>
      <div className="topbar-left">
        {/* Project Switcher */}
        <div className="project-switcher" ref={projectRef}>
          <button
            className="project-switcher-btn"
            onClick={() => { setProjectDropdownOpen(!projectDropdownOpen); setUserDropdownOpen(false) }}
            aria-haspopup="listbox"
            aria-expanded={projectDropdownOpen}
            aria-label="切换项目"
          >
            <span className="project-switcher-name">{currentProject.name}</span>
            <span className="config-scope-tag">项目级配置</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {projectDropdownOpen && (
            <div className="dropdown-menu" role="listbox" aria-label="项目列表">
              {projects.map(p => (
                <button
                  key={p.id}
                  className={`dropdown-item ${p.id === currentProject.id ? 'dropdown-item--active' : ''}`}
                  role="option"
                  aria-selected={p.id === currentProject.id}
                  onClick={() => { setCurrentProject(p); setProjectDropdownOpen(false) }}
                >
                  <div className="dropdown-item-content">
                    <span className="dropdown-item-title">{p.name}</span>
                    <span className="dropdown-item-subtitle">{p.stage} · {p.progress}%</span>
                  </div>
                  {p.id === currentProject.id && <Check size={14} className="dropdown-item-check" aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="topbar-right">
        {/* User Switcher */}
        <div className="user-switcher" ref={userRef}>
          <button
            className="user-switcher-btn"
            onClick={() => { setUserDropdownOpen(!userDropdownOpen); setProjectDropdownOpen(false) }}
            aria-haspopup="listbox"
            aria-expanded={userDropdownOpen}
            aria-label="切换用户"
          >
            <div className="user-avatar">{currentUser.avatarInitial}</div>
            <span style={{ fontSize: '13px', fontWeight: 510 }}>{currentUser.name}</span>
            <ChevronDown size={12} />
          </button>
          {userDropdownOpen && (
            <div className="dropdown-menu dropdown-menu--right" role="menu">
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div className="user-avatar">{currentUser.avatarInitial}</div>
                  <div>
                    <div style={{ fontWeight: 510, fontSize: '14px' }}>{currentUser.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{currentUser.role}</div>
                  </div>
                </div>
              </div>
              <button className="dropdown-item" role="menuitem" onClick={() => { showToast('个人设置功能开发中', 'info'); setUserDropdownOpen(false) }}>
                个人设置
              </button>
              <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <button className="dropdown-item" role="menuitem" style={{ color: 'var(--color-error, #e53935)' }}
                  onClick={() => { logout(); setUserDropdownOpen(false); navigate('/login') }}>
                  退出登录
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
