import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderKanban, Plus,
  FileText, CheckCircle2, Bot, ChevronRight,
  FileText as FileTextIcon, Clock, X, MessageSquare
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import AiChatPanel from '@/components/AiChatPanel'
import FlywheelPanel from '@/components/FlywheelPanel'

export default function Dashboard() {
  const navigate = useNavigate()
  const { projects, currentProject, currentUser, showToast, addProject, users, deliveries, stageNames, createDelivery } = useApp()

  // ─── KPIs derived from real state (no hardcoded demo numbers) ───
  const runningAgents = projects.reduce((n, p) => n + (p.agents || []).filter(a => a.status === 'running').length, 0)
  const kpis = [
    { label: '活跃项目', value: String(projects.filter(p => p.status === 'active').length), suffix: '个' },
    { label: '待评审任务', value: String(deliveries.filter(d => d.currentStageIndex < 8).length), suffix: '个' },
    { label: '智能体运行中', value: String(runningAgents), suffix: '个' },
    { label: '本周交付', value: String(deliveries.filter(d => d.currentStageIndex >= 8).length), suffix: '次' },
  ]

  // ─── Dialog state ──────────────────────────────────────────────
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [showCreateRequirement, setShowCreateRequirement] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  // Create Project form state
  const [projectName, setProjectName] = useState('')
  const [projectStage, setProjectStage] = useState('需求分析')
  const [projectDesc, setProjectDesc] = useState('')
  const [selectedMembers, setSelectedMembers] = useState([])

  // Create Requirement form state
  const [reqTitle, setReqTitle] = useState('')
  const [reqDesc, setReqDesc] = useState('')
  const [reqPriority, setReqPriority] = useState('P1')
  const [reqProject, setReqProject] = useState('')

  // ─── Escape key handler ────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showCreateProject) setShowCreateProject(false)
        if (showCreateRequirement) setShowCreateRequirement(false)
      }
    }
    if (showCreateProject || showCreateRequirement) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showCreateProject, showCreateRequirement])

  // ─── Handlers ──────────────────────────────────────────────────
  const toggleMember = (memberName) => {
    setSelectedMembers(prev =>
      prev.includes(memberName)
        ? prev.filter(m => m !== memberName)
        : [...prev, memberName]
    )
  }

  const handleCreateProject = () => {
    if (!projectName.trim()) return
    const newProject = {
      id: `p${Date.now()}`,
      name: projectName.trim(),
      stage: projectStage,
      progress: 0,
      status: 'planning',
      members: selectedMembers,
      agents: [],
      skills: [],
      rules: [],
      mcpTools: [],
      modelMatrix: [
        { stage: '需求分析', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: 'BRD生成', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.7, reviewTemp: 0.3, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: 'PRD生成', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.6, reviewTemp: 0.3, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: '测试用例', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.5, reviewTemp: 0.2, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: '开发方案', genModel: 'GPT-4o', reviewModel: 'GPT-4o-mini', genTemp: 0.6, reviewTemp: 0.3, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: '开发', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: 'Code Review', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.3, reviewTemp: null, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
        { stage: '自动化测试', genModel: 'GPT-4o', reviewModel: '—', genTemp: 0.2, reviewTemp: null, tokens: '0', avgTime: '—', passRate: '—', status: 'connected' },
      ],
      reviewGates: [
        { stage: '需求分析', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
        { stage: 'BRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 80 },
        { stage: 'PRD', aiReview: true, humanReview: true, manualTrigger: true, threshold: 75 },
        { stage: '测试用例', aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
        { stage: '开发方案', aiReview: true, humanReview: false, manualTrigger: true, threshold: 75 },
      ],
      notifications: {
        stageComplete: true,
        aiReviewComplete: true,
        humanReviewRequest: true,
        devComplete: false,
        deliverySuccess: false,
        errorAlert: true,
      },
      pipeline: {
        stages: [
          { id: 1, name: '需求分析', icon: 'FileText', status: 'pending', hasAiReview: true, aiReviewStatus: null },
          { id: 2, name: 'BRD', icon: 'BookOpen', status: 'pending', hasAiReview: true, aiReviewStatus: null },
          { id: 3, name: 'PRD', icon: 'FileText', status: 'pending', hasAiReview: true, aiReviewStatus: null },
          { id: 4, name: '测试用例', icon: 'CheckSquare', status: 'pending', hasAiReview: true, aiReviewStatus: null },
          { id: 5, name: '开发方案', icon: 'Code', status: 'pending', hasAiReview: false, aiReviewStatus: null },
          { id: 6, name: '开发', icon: 'Terminal', status: 'pending', hasAiReview: false, aiReviewStatus: null },
          { id: 7, name: 'Code Review', icon: 'Search', status: 'pending', hasAiReview: true, aiReviewStatus: null },
          { id: 8, name: '自动化测试', icon: 'Zap', status: 'pending', hasAiReview: false, aiReviewStatus: null },
          { id: 9, name: '交付', icon: 'Package', status: 'pending', hasAiReview: false, aiReviewStatus: null },
        ],
      },
      activities: [],
    }
    addProject(newProject)
    showToast(`项目「${newProject.name}」创建成功`, 'success')
    setShowCreateProject(false)
    setProjectName('')
    setProjectStage('需求分析')
    setProjectDesc('')
    setSelectedMembers([])
  }

  const handleCreateRequirement = () => {
    if (!reqTitle.trim()) return
    const newDelivery = {
      id: `d${Date.now()}`,
      title: reqTitle.trim(),
      description: reqDesc.trim(),
      priority: reqPriority,
      projectId: reqProject || currentProject.id,
      assignee: currentUser ? currentUser.name : '',
      currentStageIndex: 0,
      createdAt: new Date().toISOString().split('T')[0],
    }
    createDelivery(newDelivery)
    showToast(`需求「${reqTitle.trim()}」已创建，进入交付流程`, 'success')
    setShowCreateRequirement(false)
    setReqTitle('')
    setReqDesc('')
    setReqPriority('P1')
    setReqProject('')
  }

  const openCreateProject = () => {
    setProjectName('')
    setProjectStage('需求分析')
    setProjectDesc('')
    setSelectedMembers([])
    setShowCreateProject(true)
  }

  const openCreateRequirement = () => {
    setReqTitle('')
    setReqDesc('')
    setReqPriority('P1')
    setReqProject(projects.length > 0 ? projects[0].id : '')
    setShowCreateRequirement(true)
  }

  // CommandPalette 快捷动作「新建交付」→ 打开新建需求对话框
  useEffect(() => {
    const onCreateRequirement = () => openCreateRequirement()
    window.addEventListener('flowforge:create-requirement', onCreateRequirement)
    return () => window.removeEventListener('flowforge:create-requirement', onCreateRequirement)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects])

  const activities = currentProject.activities || []
  const projectDeliveries = deliveries.filter(d => d.projectId === currentProject.id)

  const activityIcons = {
    CheckCircle: { icon: CheckCircle2, color: 'var(--color-success)' },
    Bot: { icon: Bot, color: 'var(--color-ai-review)' },
    AlertTriangle: { icon: Clock, color: 'var(--color-human-review)' },
    GitBranch: { icon: FileTextIcon, color: 'var(--fg-tertiary)' },
    Users: { icon: FolderKanban, color: 'var(--fg-tertiary)' },
    FileText: { icon: FileText, color: 'var(--color-progress)' },
    Terminal: { icon: Bot, color: 'var(--color-progress)' },
  }

  return (
    <div className="fade-in">
      {/* Greeting */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 510, color: 'var(--fg)' }}>
          你好，{currentUser.name}
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginTop: '4px' }}>
          当前项目：{currentProject.name} · {currentProject.stage}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid" role="list" aria-label="关键指标">
        {kpis.map((kpi, i) => (
          <div key={i} className="kpi-card" role="listitem" aria-label={`${kpi.label}：${kpi.value}${kpi.suffix}`}>
            <div className="kpi-label">{kpi.label}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
              <span className="kpi-value">{kpi.value}</span>
              <span style={{ fontSize: '13px', color: 'var(--fg-tertiary)' }}>{kpi.suffix}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 'var(--space-5)', marginTop: 'var(--space-5)' }}>
        {/* Project Cards */}
        <div className="card">
          <div className="card-header">
            <h4 className="card-title">进行中的项目</h4>
            <button className="btn btn-primary" style={{ fontSize: '13px' }} onClick={openCreateProject}>
              <Plus size={14} aria-hidden="true" /> 新建项目
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }} role="list" aria-label="项目列表">
            {projects.map((project) => (
              <div key={project.id}
                role="listitem"
                tabIndex={0}
                aria-label={`${project.name}，${project.stage}，进度 ${project.progress}%`}
                onClick={() => navigate('/pipeline')}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate('/pipeline') }}
                style={{
                  padding: 'var(--space-4)',
                  border: `1px solid ${project.id === currentProject.id ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                  background: project.id === currentProject.id ? 'color-mix(in srgb, var(--accent) 3%, var(--bg))' : 'var(--bg)',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <FolderKanban size={16} style={{ color: 'var(--accent)' }} aria-hidden="true" />
                    <span style={{ fontWeight: 510, fontSize: '14px' }}>{project.name}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`status-badge status-${project.status === 'active' ? 'progress' : project.status === 'planning' ? 'pending' : project.status}`}>
                      <span className="status-dot" aria-hidden="true"></span>
                      {project.stage}
                    </span>
                    <ChevronRight size={14} style={{ color: 'var(--fg-muted)' }} aria-hidden="true" />
                  </div>
                </div>
                {/* Progress Bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ flex: 1, height: '6px', background: 'var(--surface)', borderRadius: '3px', overflow: 'hidden' }} role="progressbar" aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${project.name}进度 ${project.progress}%`}>
                    <div style={{
                      width: `${project.progress}%`,
                      height: '100%',
                      background: 'var(--color-progress)',
                      borderRadius: '3px',
                      transition: 'width 0.5s ease'
                    }} />
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)', fontWeight: 510, minWidth: '36px' }} aria-hidden="true">
                    {project.progress}%
                  </span>
                </div>
                {/* Team Members */}
                <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }} aria-label={`团队成员：${project.members.join('、')}`}>
                  {project.members.map((member, j) => (
                    <div key={j} style={{
                      width: '24px', height: '24px', borderRadius: '50%',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '10px', fontWeight: 510, color: 'var(--fg-tertiary)'
                    }} aria-hidden="true">
                      {member.charAt(0)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {projects.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
                <FolderKanban size={32} style={{ opacity: 0.3, marginBottom: '8px' }} aria-hidden="true" />
                <div>还没有项目，点击右上角「新建项目」开始</div>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Activity + Quick Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {/* Quick Actions */}
          <div className="card">
            <div className="card-header">
              <h4 className="card-title">快捷操作</h4>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button className="btn btn-primary" style={{ justifyContent: 'center', padding: '12px' }} onClick={openCreateProject}>
                <Plus size={14} aria-hidden="true" /> 新建项目
              </button>
              <button className="btn btn-secondary" style={{ justifyContent: 'center', padding: '12px' }} onClick={openCreateRequirement}>
                <FileText size={14} aria-hidden="true" /> 新建需求
              </button>
            </div>
          </div>

          {/* Activity Feed */}
          <div className="card">
            <div className="card-header">
              <h4 className="card-title">最近活动</h4>
            </div>
            <div role="feed" aria-label="最近活动流">
              {activities.map((act, i) => {
                const iconDef = activityIcons[act.icon] || { icon: FileText, color: 'var(--fg-tertiary)' }
                const IconComp = iconDef.icon
                return (
                  <div key={i} className="activity-item" role="article" aria-setsize={activities.length} aria-posinset={i + 1}>
                    <div className="activity-icon" style={{ background: 'var(--surface)' }} aria-hidden="true">
                      <IconComp size={16} style={{ color: iconDef.color }} aria-hidden="true" />
                    </div>
                    <div>
                      <div className="activity-text">{act.text}</div>
                      <time className="activity-time">{act.time}</time>
                    </div>
                  </div>
                )
              })}
            </div>
            {activities.length > 0 && (
              <div style={{ padding: '8px 0 0', textAlign: 'center' }}>
                <button className="btn btn-ghost" style={{ fontSize: '12px' }} onClick={() => showToast('查看全部活动', 'info')}>
                  查看全部
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── 交付进度 ─────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 'var(--space-5)' }}>
        <div className="card-header">
          <h4 className="card-title">进行中的交付</h4>
          <button className="btn btn-ghost" style={{ fontSize: '12px' }} onClick={() => navigate('/pipeline')}>
            查看全部 <ChevronRight size={12} aria-hidden="true" />
          </button>
        </div>
        {projectDeliveries.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
            当前项目暂无交付中的需求，点击"新建需求"发起交付
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {projectDeliveries.map(d => {
              const stageName = stageNames[d.currentStageIndex] || '未知'
              const progress = Math.round((d.currentStageIndex / 8) * 100)
              const priorityColors = { P0: 'var(--color-error)', P1: 'var(--color-human-review)', P2: 'var(--color-progress)', P3: 'var(--fg-muted)' }
              return (
                <div
                  key={d.id}
                  className="delivery-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate('/pipeline')}
                  onKeyDown={e => { if (e.key === 'Enter') navigate('/pipeline') }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="delivery-priority-tag" style={{ background: priorityColors[d.priority] || 'var(--fg-muted)' }}>{d.priority}</span>
                      <span style={{ fontWeight: 510, fontSize: '14px' }}>{d.title}</span>
                    </div>
                    <span className="status-badge status-progress">
                      <span className="status-dot"></span>
                      {stageName}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ flex: 1, height: '6px', background: 'var(--surface)', borderRadius: '3px', overflow: 'hidden' }}
                      role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${d.title} 交付进度 ${progress}%`}>
                      <div style={{ width: `${progress}%`, height: '100%', background: 'var(--color-progress)', borderRadius: '3px', transition: 'width 0.5s ease' }} />
                    </div>
                    <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)', fontWeight: 510, minWidth: '36px' }}>{progress}%</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '6px' }}>
                    {d.assignee} · 创建于 {d.createdAt}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ─── 知识飞轮（Phase 6）────────────────── */}
      <FlywheelPanel />

      {/* ─── Create Project Dialog ────────────────────────────────── */}
      {showCreateProject && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowCreateProject(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '520px', maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="create-project-title" style={{ fontSize: '16px', fontWeight: 510, margin: 0 }}>新建项目</h3>
              <div
                role="button"
                tabIndex={0}
                aria-label="关闭对话框"
                onClick={() => setShowCreateProject(false)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowCreateProject(false) }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)' }}
              >
                <X size={18} aria-hidden="true" />
              </div>
            </div>
            {/* Form Fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* 项目名称 */}
              <div>
                <label htmlFor="cp-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  项目名称 <span style={{ color: 'var(--color-danger, #e53e3e)' }}>*</span>
                </label>
                <input
                  id="cp-name"
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="输入项目名称"
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  autoFocus
                />
              </div>
              {/* 项目阶段 */}
              <div>
                <label htmlFor="cp-stage" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>项目阶段</label>
                <select
                  id="cp-stage"
                  className="select"
                  style={{ width: '100%' }}
                  value={projectStage}
                  onChange={e => setProjectStage(e.target.value)}
                >
                  {['需求分析', 'BRD生成', 'PRD生成', '测试用例', '开发', 'Code Review', '自动化测试', '交付'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              {/* 项目描述 */}
              <div>
                <label htmlFor="cp-desc" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>项目描述</label>
                <textarea
                  id="cp-desc"
                  className="input"
                  style={{ width: '100%', minHeight: '80px', resize: 'vertical' }}
                  placeholder="简要描述项目目标和范围（可选）"
                  value={projectDesc}
                  onChange={e => setProjectDesc(e.target.value)}
                />
              </div>
              {/* 项目成员 */}
              <div>
                <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>项目成员</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {users.map(user => {
                    const checked = selectedMembers.includes(user.name)
                    return (
                      <label
                        key={user.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '6px',
                          padding: '6px 12px', borderRadius: '8px', cursor: 'pointer',
                          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                          background: checked ? 'color-mix(in srgb, var(--accent) 8%, var(--bg))' : 'var(--bg)',
                          fontSize: '13px', transition: 'border-color 0.15s, background 0.15s',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMember(user.name)}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        <span>{user.name}</span>
                        <span style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>{user.roleTag}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
            {/* Footer Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowCreateProject(false)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateProject}
                disabled={!projectName.trim()}
                style={{ opacity: projectName.trim() ? 1 : 0.5 }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Create Requirement Dialog ─────────────────────────────── */}
      {showCreateRequirement && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowCreateRequirement(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '520px', maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-req-title">
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="create-req-title" style={{ fontSize: '16px', fontWeight: 510, margin: 0 }}>新建需求</h3>
              <div
                role="button"
                tabIndex={0}
                aria-label="关闭对话框"
                onClick={() => setShowCreateRequirement(false)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowCreateRequirement(false) }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-tertiary)' }}
              >
                <X size={18} aria-hidden="true" />
              </div>
            </div>
            {/* Form Fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* 需求标题 */}
              <div>
                <label htmlFor="cr-title" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  需求标题 <span style={{ color: 'var(--color-danger, #e53e3e)' }}>*</span>
                </label>
                <input
                  id="cr-title"
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="输入需求标题"
                  value={reqTitle}
                  onChange={e => setReqTitle(e.target.value)}
                  autoFocus
                />
              </div>
              {/* 需求描述 */}
              <div>
                <label htmlFor="cr-desc" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>需求描述</label>
                <textarea
                  id="cr-desc"
                  className="input"
                  style={{ width: '100%', minHeight: '80px', resize: 'vertical' }}
                  placeholder="描述需求详情（可选）"
                  value={reqDesc}
                  onChange={e => setReqDesc(e.target.value)}
                />
              </div>
              {/* 优先级 */}
              <div>
                <label htmlFor="cr-priority" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>优先级</label>
                <select
                  id="cr-priority"
                  className="select"
                  style={{ width: '100%' }}
                  value={reqPriority}
                  onChange={e => setReqPriority(e.target.value)}
                >
                  <option value="P0">P0 - 紧急</option>
                  <option value="P1">P1 - 高</option>
                  <option value="P2">P2 - 中</option>
                  <option value="P3">P3 - 低</option>
                </select>
              </div>
              {/* 关联项目 */}
              <div>
                <label htmlFor="cr-project" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>关联项目</label>
                <select
                  id="cr-project"
                  className="select"
                  style={{ width: '100%' }}
                  value={reqProject}
                  onChange={e => setReqProject(e.target.value)}
                >
                  <option value="">未关联</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* Footer Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowCreateRequirement(false)}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateRequirement}
                disabled={!reqTitle.trim()}
                style={{ opacity: reqTitle.trim() ? 1 : 0.5 }}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Chat Panel */}
      <AiChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        projectName={currentProject?.name}
      />

      {/* Floating Chat Toggle Button */}
      {!chatOpen && (
        <button
          className="ai-chat-toggle-btn"
          onClick={() => setChatOpen(true)}
          aria-label="打开AI对话窗口"
          title="AI 助手"
        >
          <MessageSquare size={22} />
        </button>
      )}
    </div>
  )
}
