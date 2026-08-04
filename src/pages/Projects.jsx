import React, { useState, useEffect } from 'react'
import { FolderKanban, Plus, X, Trash2 } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import ProjectConfig from '@/pages/ProjectConfig'
import { removeRepositoriesForProject } from '@/services/repository'
import { removeIndexesForProject } from '@/services/codebaseIndex'

const projectStages = ['需求分析', 'BRD生成', 'PRD生成', '测试用例', '开发', 'Code Review', '自动化测试', '交付']

/**
 * 统一项目中心（合并自原 Projects 页 + 原配置中心）：
 * 左侧项目列表（新建 / 切换 / 移除），右侧为所选项目的配置视图
 * （仓库管理 / 交付流编排 / 索引管理 / 成员管理，见 ProjectConfig embedded 模式）。
 */
export default function Projects() {
  const [selectedProjectIndex, setSelectedProjectIndex] = useState(0)
  const { projects, currentProject, setCurrentProject, showToast, addProject, deleteProject, users } = useApp()

  // Create Project dialog state
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectStage, setProjectStage] = useState('需求分析')
  const [selectedMembers, setSelectedMembers] = useState([])

  const handleSelectProject = (i) => {
    setSelectedProjectIndex(i)
    setCurrentProject(projects[i])
    showToast(`已切换到「${projects[i].name}」`, 'success')
  }

  // 移除项目：二次确认后级联清理仓库记录、索引元数据，再删项目本身
  // （deliveries / stageDeliverables 由 AppContext 的 DELETE_PROJECT 级联删除）
  const handleDeleteProject = (project) => {
    const ok = window.confirm(
      `确定要移除项目「${project.name}」吗？\n\n该项目的仓库记录、代码索引元数据与全部交付流需求将被一并删除，此操作不可撤销。`
    )
    if (!ok) return
    removeRepositoriesForProject(project.id)
    removeIndexesForProject(project.id)
    deleteProject(project.id)
    setSelectedProjectIndex(0)
    showToast(`已移除项目「${project.name}」及其关联数据`, 'success')
  }

  // Escape key closes any open dialog
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && showCreateProject) setShowCreateProject(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showCreateProject])

  // ── Create Project handlers ──
  const openCreateProject = () => {
    setProjectName('')
    setProjectStage('需求分析')
    setSelectedMembers([])
    setShowCreateProject(true)
  }

  const handleCreateProject = () => {
    if (!projectName.trim()) {
      showToast('请输入项目名称', 'info')
      return
    }
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
      modelMatrix: [],
      reviewGates: [],
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
    showToast(`项目「${projectName.trim()}」创建成功`, 'success')
    setShowCreateProject(false)
  }

  const toggleMember = (memberName) => {
    setSelectedMembers(prev =>
      prev.includes(memberName)
        ? prev.filter(m => m !== memberName)
        : [...prev, memberName]
    )
  }

  // Shared Create Project dialog (rendered in both empty state and normal view)
  const renderCreateProjectDialog = () => (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
    }} onClick={() => setShowCreateProject(false)} role="presentation">
      <div style={{
        background: 'var(--bg)', borderRadius: '12px', padding: '24px',
        width: '520px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
        border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)'
      }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-project-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 id="create-project-title">新建项目</h3>
          <button className="btn btn-ghost" onClick={() => setShowCreateProject(false)} aria-label="关闭对话框">
            <X size={18} />
          </button>
        </div>

        {/* 项目名称 */}
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="project-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
            项目名称 <span style={{ color: 'var(--color-danger, #e53e3e)' }}>*</span>
          </label>
          <input
            id="project-name"
            className="input"
            type="text"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            placeholder="请输入项目名称"
            style={{ width: '100%' }}
            autoFocus
          />
        </div>

        {/* 项目阶段 */}
        <div style={{ marginBottom: '16px' }}>
          <label htmlFor="project-stage" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
            项目阶段
          </label>
          <select
            id="project-stage"
            className="select"
            value={projectStage}
            onChange={e => setProjectStage(e.target.value)}
            style={{ width: '100%' }}
          >
            {projectStages.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* 项目成员 */}
        <div style={{ marginBottom: '24px' }}>
          <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '8px' }}>
            项目成员
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {users.map(user => (
              <label
                key={user.id}
                htmlFor={`member-${user.id}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                  border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
                  fontSize: '13px',
                  background: selectedMembers.includes(user.name) ? 'color-mix(in srgb, var(--accent) 6%, var(--bg))' : 'transparent',
                  borderColor: selectedMembers.includes(user.name) ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <input
                  type="checkbox"
                  id={`member-${user.id}`}
                  checked={selectedMembers.includes(user.name)}
                  onChange={() => toggleMember(user.name)}
                />
                <span style={{ fontWeight: 510 }}>{user.name}</span>
                <span style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>{user.role} · {user.roleTag}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={() => setShowCreateProject(false)}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleCreateProject}>
            创建
          </button>
        </div>
      </div>
    </div>
  )

  const selectedProject = projects[selectedProjectIndex] || projects[0] || null

  // ── Empty state: no project yet (clean first run on desktop) ──
  if (!selectedProject) {
    return (
      <div className="fade-in">
        <ConfigScopeBanner />
        <div className="page-header">
          <h2>项目中心</h2>
          <button className="btn btn-primary" onClick={openCreateProject} aria-haspopup="dialog">
            <Plus size={14} /> 新建项目
          </button>
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '64px 24px', color: 'var(--fg-tertiary)' }}>
          <FolderKanban size={40} style={{ opacity: 0.3, marginBottom: '12px' }} />
          <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg)' }}>还没有项目</div>
          <div style={{ fontSize: '13px', marginTop: '6px' }}>点击右上角「新建项目」开始你的第一个交付流程</div>
        </div>
        {showCreateProject && renderCreateProjectDialog()}
      </div>
    )
  }

  return (
    <div className="fade-in">
      <ConfigScopeBanner />

      <div className="page-header">
        <h2>项目中心</h2>
        <button className="btn btn-primary" onClick={openCreateProject} aria-haspopup="dialog">
          <Plus size={14} /> 新建项目
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '20px', alignItems: 'start' }}>
        {/* Project List */}
        <div>
          {projects.map((project, i) => (
            <div key={project.id}
              className="card"
              role="button"
              tabIndex={0}
              aria-label={`选择项目 ${project.name}`}
              onClick={() => handleSelectProject(i)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectProject(i) } }}
              style={{
                marginBottom: '8px', cursor: 'pointer',
                borderColor: selectedProject.id === project.id ? 'var(--accent)' : 'var(--border)',
                background: selectedProject.id === project.id ? 'color-mix(in srgb, var(--accent) 4%, var(--bg))' : 'var(--bg)'
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', minWidth: 0 }}>
                  <FolderKanban size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 510, fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginTop: '2px' }}>
                      {project.stage} · 进度 {project.progress}%
                    </div>
                  </div>
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '4px', color: 'var(--fg-muted)', flexShrink: 0 }}
                  onClick={(e) => { e.stopPropagation(); handleDeleteProject(project) }}
                  title="移除项目"
                  aria-label={`移除项目 ${project.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '12px', fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                <span>{(project.agents || []).length} 个智能体</span>
                <span>{(project.skills || []).length} 个Skill</span>
                <span>{project.members.length} 位成员</span>
              </div>
            </div>
          ))}
        </div>

        {/* Project config view (仓库管理 / 交付流编排 / 索引管理 / 成员管理) */}
        <div style={{ minWidth: 0 }}>
          <ProjectConfig embedded />
        </div>
      </div>

      {/* ─── Create Project Dialog ─── */}
      {showCreateProject && renderCreateProjectDialog()}
    </div>
  )
}
