import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Bot, Plus, Edit3, Trash2, Power, Settings, Cpu, Sliders,
  Zap, Link2, Shield, Check, X, AlertCircle, ChevronRight,
  Download, Upload, FileJson, Globe, File as FileIcon, Copy,
  Plug, Loader2,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { useSidecar } from '@/context/SidecarContext'
import { toMcpServerConfig } from '@/services/mcpConfig'
import { getModelOptions } from '@/services/ai'

// ─── Helpers: normalize legacy string arrays to object arrays ───
function normalizeItems(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map(item => {
    if (typeof item === 'string') return { name: item, type: 'link', url: '', description: '' }
    return { name: item.name || '', type: item.type || 'link', url: item.url || '', description: item.description || '' }
  })
}

function itemsToLegacy(items) {
  return items.map(i => i.name)
}

const EMPTY_FORM = {
  name: '',
  description: '',
  model: '',
  systemPrompt: '',
  temperature: 0.7,
  skills: [],
  mcpTools: [],
  rules: [],
}

export default function Agents() {
  const {
    agents,
    projects,
    addAgent,
    updateAgent,
    deleteAgent,
    showToast,
    getFlowConfig,
  } = useApp()

  const [showFormModal, setShowFormModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [expandedRefs, setExpandedRefs] = useState({})
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletingAgent, setDeletingAgent] = useState(null)
  const [showImportModal, setShowImportModal] = useState(false)
  const [importText, setImportText] = useState('')
  const fileInputRef = useRef(null)

  // ── MCP connect test (Phase 4, tauri + sidecar only) ──
  const sidecarApi = useSidecar()
  const [testingMcp, setTestingMcp] = useState(null)
  const handleTestMcp = useCallback(async (item, idx) => {
    const cfg = toMcpServerConfig(item)
    if (!cfg) {
      showToast('请先填写名称与启动命令（或 http(s) URL）', 'error')
      return
    }
    if (sidecarApi.mode !== 'tauri' || !sidecarApi.isReady) {
      showToast('测试连接需要桌面版（sidecar 未就绪）', 'info')
      return
    }
    setTestingMcp(idx)
    try {
      const res = await sidecarApi.invoke('tools.connect_test', { server: cfg })
      if (res?.ok) {
        const names = (res.tools || []).map(t => t.name).slice(0, 5).join(', ')
        showToast(`「${cfg.name}」连接成功，发现 ${res.tools?.length ?? 0} 个工具${names ? `：${names}` : ''}`, 'success')
      } else {
        showToast(`「${cfg.name}」连接失败：${res?.error || '未知错误'}`, 'error')
      }
    } catch (e) {
      showToast(`连接测试失败：${e?.message || e}`, 'error')
    } finally {
      setTestingMcp(null)
    }
  }, [sidecarApi, showToast])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return
      if (showDeleteConfirm) setShowDeleteConfirm(false)
      else if (showImportModal) setShowImportModal(false)
      else if (showFormModal) setShowFormModal(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showFormModal, showDeleteConfirm, showImportModal])

  // ── Create / Edit ──
  const openCreate = useCallback(() => {
    setEditingAgent(null)
    setForm({ ...EMPTY_FORM, skills: [], mcpTools: [], rules: [] })
    setShowFormModal(true)
  }, [])

  const openEdit = useCallback((agent) => {
    setEditingAgent(agent)
    setForm({
      name: agent.name || '',
      description: agent.description || '',
      model: agent.model || '',
      systemPrompt: agent.systemPrompt || '',
      temperature: typeof agent.temperature === 'number' ? agent.temperature : 0.7,
      skills: normalizeItems(agent.skills),
      mcpTools: normalizeItems(agent.mcpTools),
      rules: normalizeItems(agent.rules),
    })
    setShowFormModal(true)
  }, [])

  const handleSaveForm = useCallback(() => {
    const name = form.name.trim()
    if (!name) {
      showToast('请填写智能体名称', 'error')
      return
    }

    const data = {
      name,
      description: form.description.trim(),
      model: form.model,
      systemPrompt: form.systemPrompt.trim(),
      temperature: Number(form.temperature),
      skills: form.skills.filter(s => s.name.trim()),
      mcpTools: form.mcpTools.filter(s => s.name.trim()),
      rules: form.rules.filter(s => s.name.trim()),
    }

    if (editingAgent) {
      updateAgent(editingAgent.id, data)
      showToast(`智能体「${name}」已更新`, 'success')
    } else {
      const newAgent = {
        id: `a${Date.now()}`,
        ...data,
        enabled: true,
        createdAt: new Date().toISOString().slice(0, 10),
        assignedStages: [],
      }
      addAgent(newAgent)
      showToast(`智能体「${name}」创建成功`, 'success')
    }
    setShowFormModal(false)
  }, [form, editingAgent, addAgent, updateAgent, showToast])

  const handleToggleEnabled = useCallback((agent) => {
    const next = !agent.enabled
    updateAgent(agent.id, { enabled: next })
    showToast(`「${agent.name}」已${next ? '启用' : '停用'}`, next ? 'success' : 'info')
  }, [updateAgent, showToast])

  const openDeleteConfirm = useCallback((agent) => {
    setDeletingAgent(agent)
    setShowDeleteConfirm(true)
  }, [])

  const handleConfirmDelete = useCallback(() => {
    if (!deletingAgent) return
    deleteAgent(deletingAgent.id)
    showToast(`「${deletingAgent.name}」已删除`, 'success')
    setShowDeleteConfirm(false)
    setDeletingAgent(null)
  }, [deletingAgent, deleteAgent, showToast])

  // ── Reference lookup ──
  const getAgentReferences = useCallback((agentId) => {
    const refs = []
    projects.forEach(project => {
      const flowConfig = getFlowConfig(project)
      flowConfig.forEach(node => {
        if (node.agentId === agentId) {
          refs.push({ projectId: project.id, projectName: project.name, stageId: node.stage, stageLabel: node.label })
        }
      })
    })
    return refs
  }, [projects, getFlowConfig])

  const toggleRefExpansion = useCallback((agentId) => {
    setExpandedRefs(prev => ({ ...prev, [agentId]: !prev[agentId] }))
  }, [])

  // ── Export single agent config ──
  const handleExportAgent = useCallback((agent) => {
    const exportData = {
      version: '1.0',
      type: 'flowforge-agent',
      exportedAt: new Date().toISOString(),
      agent: {
        name: agent.name,
        description: agent.description,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        temperature: agent.temperature,
        skills: normalizeItems(agent.skills),
        mcpTools: normalizeItems(agent.mcpTools),
        rules: normalizeItems(agent.rules),
      },
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${agent.name.replace(/\s+/g, '-')}-agent.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showToast(`「${agent.name}」配置已导出`, 'success')
  }, [showToast])

  // ── Export all agents ──
  const handleExportAll = useCallback(() => {
    const exportData = {
      version: '1.0',
      type: 'flowforge-agent-pack',
      exportedAt: new Date().toISOString(),
      agents: agents.map(a => ({
        name: a.name,
        description: a.description,
        model: a.model,
        systemPrompt: a.systemPrompt,
        temperature: a.temperature,
        skills: normalizeItems(a.skills),
        mcpTools: normalizeItems(a.mcpTools),
        rules: normalizeItems(a.rules),
      })),
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `flowforge-agents-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showToast(`已导出 ${agents.length} 个智能体配置`, 'success')
  }, [agents, showToast])

  // ── Import agents from JSON ──
  const handleImportFile = useCallback((e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result)
        const agentList = data.type === 'flowforge-agent-pack' ? data.agents : (data.type === 'flowforge-agent' ? [data.agent] : data)
        if (!Array.isArray(agentList)) {
          showToast('配置文件格式不正确', 'error')
          return
        }
        let count = 0
        agentList.forEach(a => {
          if (!a.name) return
          addAgent({
            id: `a${Date.now()}_${count}`,
            name: a.name,
            description: a.description || '',
            model: a.model || '',
            systemPrompt: a.systemPrompt || '',
            temperature: typeof a.temperature === 'number' ? a.temperature : 0.7,
            skills: normalizeItems(a.skills),
            mcpTools: normalizeItems(a.mcpTools),
            rules: normalizeItems(a.rules),
            enabled: true,
            createdAt: new Date().toISOString().slice(0, 10),
            assignedStages: [],
          })
          count++
        })
        showToast(`成功导入 ${count} 个智能体`, 'success')
        setShowImportModal(false)
      } catch (err) {
        showToast('文件解析失败：' + err.message, 'error')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }, [addAgent, showToast])

  const handleImportText = useCallback(() => {
    try {
      const data = JSON.parse(importText)
      const agentList = data.type === 'flowforge-agent-pack' ? data.agents : (data.type === 'flowforge-agent' ? [data.agent] : data)
      if (!Array.isArray(agentList)) {
        showToast('配置格式不正确', 'error')
        return
      }
      let count = 0
      agentList.forEach(a => {
        if (!a.name) return
        addAgent({
          id: `a${Date.now()}_${count}`,
          name: a.name,
          description: a.description || '',
          model: a.model || '',
          systemPrompt: a.systemPrompt || '',
          temperature: typeof a.temperature === 'number' ? a.temperature : 0.7,
          skills: normalizeItems(a.skills),
          mcpTools: normalizeItems(a.mcpTools),
          rules: normalizeItems(a.rules),
          enabled: true,
          createdAt: new Date().toISOString().slice(0, 10),
          assignedStages: [],
        })
        count++
      })
      showToast(`成功导入 ${count} 个智能体`, 'success')
      setShowImportModal(false)
      setImportText('')
    } catch (err) {
      showToast('解析失败：' + err.message, 'error')
    }
  }, [importText, addAgent, showToast])

  // ── Form item helpers (skills/mcpTools/rules as object arrays) ──
  const addFormItem = useCallback((field) => {
    setForm(prev => ({
      ...prev,
      [field]: [...prev[field], { name: '', type: 'link', url: '', description: '' }],
    }))
  }, [])

  const updateFormItem = useCallback((field, index, key, value) => {
    setForm(prev => {
      const items = [...prev[field]]
      items[index] = { ...items[index], [key]: value }
      return { ...prev, [field]: items }
    })
  }, [])

  const removeFormItem = useCallback((field, index) => {
    setForm(prev => ({
      ...prev,
      [field]: prev[field].filter((_, i) => i !== index),
    }))
  }, [])

  const enabledCount = agents.filter(a => a.enabled).length

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h2>智能体管理</h2>
          <p style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginTop: '4px' }}>
            创建和管理 AI 智能体，在交付流编排中为节点绑定智能体
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={() => setShowImportModal(true)}>
            <Upload size={14} /> 导入
          </button>
          <button className="btn btn-secondary" onClick={handleExportAll} disabled={agents.length === 0}>
            <Download size={14} /> 导出全部
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <Bot size={14} /> 新建智能体
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
        <div className="card" style={{ flex: 1, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '10px',
            background: 'color-mix(in srgb, var(--accent) 12%, var(--bg))',
            color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Bot size={18} />
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg)' }}>智能体总览</div>
            <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>
              共 {agents.length} 个智能体，{enabledCount} 个已启用
            </div>
          </div>
        </div>
      </div>

      {/* Agent cards grid */}
      {agents.length === 0 ? (
        <div className="card" style={{ padding: '60px 24px', textAlign: 'center' }}>
          <Bot size={40} style={{ color: 'var(--fg-muted)', marginBottom: '16px', opacity: 0.4 }} />
          <div style={{ fontSize: '15px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
            还没有创建智能体
          </div>
          <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginBottom: '20px' }}>
            创建一个智能体，或导入团队共享的配置文件
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            <button className="btn btn-secondary" onClick={() => setShowImportModal(true)}>
              <Upload size={14} /> 导入配置
            </button>
            <button className="btn btn-primary" onClick={openCreate}>
              <Plus size={14} /> 新建智能体
            </button>
          </div>
        </div>
      ) : (
        <div className="agent-grid">
          {agents.map(agent => {
            const skills = normalizeItems(agent.skills)
            const mcps = normalizeItems(agent.mcpTools)
            const rules = normalizeItems(agent.rules)
            const refs = getAgentReferences(agent.id)
            const isRefExpanded = !!expandedRefs[agent.id]
            return (
              <div
                key={agent.id}
                className="card agent-card"
                style={{
                  opacity: agent.enabled ? 1 : 0.6,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <div style={{
                      width: '34px', height: '34px', borderRadius: '8px', flexShrink: 0,
                      background: agent.enabled
                        ? 'color-mix(in srgb, var(--accent) 12%, var(--bg))'
                        : 'var(--surface)',
                      color: agent.enabled ? 'var(--accent)' : 'var(--fg-muted)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Bot size={18} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 590, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {agent.name}
                      </div>
                    </div>
                  </div>
                  <span className={`status-badge ${agent.enabled ? 'status-progress' : 'status-pending'}`}>
                    <span className="status-dot"></span>
                    {agent.enabled ? '启用' : '停用'}
                  </span>
                </div>

                {/* Description */}
                <div className="agent-card-desc">
                  {agent.description || '暂无描述'}
                </div>

                {/* Meta tags */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
                  <span className="agent-tag" title="模型">
                    <Cpu size={11} /> {agent.model || '未指定'}
                  </span>
                  <span className="agent-tag" title="温度">
                    <Sliders size={11} /> T={typeof agent.temperature === 'number' ? agent.temperature.toFixed(1) : '—'}
                  </span>
                </div>

                {/* Counts */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                  <span className="agent-count-tag" title="技能">
                    <Zap size={11} /> Skills {skills.length}
                  </span>
                  <span className="agent-count-tag" title="MCP">
                    <Link2 size={11} /> MCP {mcps.length}
                  </span>
                  <span className="agent-count-tag" title="规则">
                    <Shield size={11} /> Rules {rules.length}
                  </span>
                </div>

                {/* Skills detail (compact) */}
                {skills.length > 0 && (
                  <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {skills.map((s, i) => (
                      <span key={i} style={{
                        fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                        background: 'var(--surface)', color: 'var(--fg-tertiary)',
                        display: 'flex', alignItems: 'center', gap: '3px',
                      }} title={s.description || s.name}>
                        {s.type === 'file' ? <FileIcon size={9} /> : <Globe size={9} />}
                        {s.name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Reference info */}
                <div
                  style={{
                    marginTop: '10px', padding: '8px 10px', borderRadius: '8px',
                    background: refs.length > 0
                      ? 'color-mix(in srgb, var(--accent) 6%, var(--bg))'
                      : 'var(--surface)',
                    border: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }}
                  onClick={() => toggleRefExpansion(agent.id)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isRefExpanded}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRefExpansion(agent.id) } }}
                >
                  <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Settings size={12} />
                    {refs.length > 0 ? `被 ${refs.length} 个项目引用` : '未被任何项目引用'}
                    <ChevronRight size={12} style={{ marginLeft: 'auto', transition: 'transform 0.2s ease', transform: isRefExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }} />
                  </div>
                  {isRefExpanded && refs.length > 0 && (
                    <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {refs.map((ref, i) => (
                        <div key={`${ref.projectId}-${ref.stageId}-${i}`} style={{
                          fontSize: '11px', color: 'var(--fg-secondary)',
                          display: 'flex', alignItems: 'center', gap: '6px',
                          padding: '3px 6px', borderRadius: '4px', background: 'var(--bg)',
                        }}>
                          <span style={{ fontWeight: 510 }}>{ref.projectName}</span>
                          <ChevronRight size={10} style={{ color: 'var(--fg-muted)' }} />
                          <span>{ref.stageLabel}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="agent-card-actions">
                  <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '5px 10px' }} onClick={() => openEdit(agent)} aria-label={`编辑 ${agent.name}`}>
                    <Edit3 size={12} /> 编辑
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '5px 8px' }} onClick={() => handleExportAgent(agent)} aria-label={`导出 ${agent.name}`} title="导出配置">
                    <Download size={13} />
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: '12px', padding: '5px 8px', color: agent.enabled ? 'var(--text-human-review)' : 'var(--text-success)' }}
                    onClick={() => handleToggleEnabled(agent)}
                    aria-label={`${agent.enabled ? '停用' : '启用'} ${agent.name}`}
                    title={agent.enabled ? '停用' : '启用'}
                  >
                    <Power size={13} /> {agent.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: '12px', padding: '5px 8px', color: 'var(--fg-muted)' }}
                    onClick={() => openDeleteConfirm(agent)}
                    aria-label={`删除 ${agent.name}`}
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ─── Create / Edit Modal ─── */}
      {showFormModal && (
        <div className="agent-modal-overlay" onClick={() => setShowFormModal(false)} role="presentation">
          <div className="agent-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="agent-form-title">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h3 id="agent-form-title" style={{ fontSize: '16px', fontWeight: 590, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Bot size={18} style={{ color: 'var(--accent)' }} />
                {editingAgent ? '编辑智能体' : '新建智能体'}
              </h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowFormModal(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="agent-form-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {/* Name */}
              <div className="agent-form-row">
                <label className="agent-form-label">智能体名称 <span style={{ color: 'var(--color-error)' }}>*</span></label>
                <input className="input" type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如：BRD-Writer" style={{ width: '100%' }} autoFocus />
              </div>

              {/* Description */}
              <div className="agent-form-row">
                <label className="agent-form-label">描述</label>
                <textarea className="input agent-textarea" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="简要描述智能体的职责和能力" rows={2} />
              </div>

              {/* Model + Temperature */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div className="agent-form-row">
                  <label className="agent-form-label">模型</label>
                  <select className="select" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} style={{ width: '100%' }}>
                    <option value="">使用默认模型</option>
                    {getModelOptions().map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div className="agent-form-row">
                  <label className="agent-form-label">
                    温度 <span style={{ color: 'var(--accent)', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{Number(form.temperature).toFixed(1)}</span>
                  </label>
                  <input type="range" min="0" max="1" step="0.1" value={form.temperature} onChange={e => setForm({ ...form, temperature: Number(e.target.value) })} className="agent-range" />
                </div>
              </div>

              {/* System Prompt */}
              <div className="agent-form-row">
                <label className="agent-form-label">系统提示词</label>
                <textarea className="input agent-textarea agent-textarea-lg" value={form.systemPrompt} onChange={e => setForm({ ...form, systemPrompt: e.target.value })} placeholder="定义智能体的角色、行为边界和输出要求..." rows={4} />
              </div>

              {/* Configurable item lists: skills, mcpTools, rules */}
              {[
                { field: 'skills', label: '技能 (Skills)', icon: <Zap size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />, color: 'var(--accent)' },
                { field: 'mcpTools', label: 'MCP 工具', icon: <Link2 size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />, color: 'var(--color-info)' },
                { field: 'rules', label: '规则 (Rules)', icon: <Shield size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />, color: 'var(--color-warning)' },
              ].map(({ field, label, icon, color }) => (
                <div key={field} className="agent-form-row" style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <label className="agent-form-label" style={{ marginBottom: 0 }}>{icon}{label}</label>
                    <button type="button" className="btn btn-ghost" style={{ fontSize: '11px', padding: '2px 8px', color }} onClick={() => addFormItem(field)}>
                      <Plus size={11} /> 添加
                    </button>
                  </div>
                  {form[field].length === 0 ? (
                    <div style={{ fontSize: '11px', color: 'var(--fg-muted)', padding: '8px 0' }}>暂无配置，点击"添加"</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {form[field].map((item, idx) => (
                        <div key={idx} style={{
                          display: 'flex', alignItems: 'flex-start', gap: '6px',
                          padding: '8px', borderRadius: '8px',
                          background: 'var(--surface)', border: '1px solid var(--border-subtle)',
                        }}>
                          {/* Name */}
                          <input
                            className="input" type="text" placeholder="名称"
                            value={item.name}
                            onChange={e => updateFormItem(field, idx, 'name', e.target.value)}
                            style={{ flex: '1 1 30%', minWidth: '80px', fontSize: '12px', padding: '4px 8px' }}
                          />
                          {/* Type toggle */}
                          <select
                            className="select"
                            value={item.type}
                            onChange={e => updateFormItem(field, idx, 'type', e.target.value)}
                            style={{ width: 'auto', fontSize: '11px', padding: '4px 6px' }}
                          >
                            <option value="link">链接</option>
                            <option value="file">文件</option>
                          </select>
                          {/* URL or File path */}
                          <input
                            className="input" type="text"
                            placeholder={field === 'mcpTools' ? (item.type === 'link' ? '服务 URL（http/https）' : '启动命令（如 npx -y @xx/mcp）') : (item.type === 'link' ? '下载链接 URL' : '文件路径')}
                            value={item.url}
                            onChange={e => updateFormItem(field, idx, 'url', e.target.value)}
                            style={{ flex: '1 1 35%', minWidth: '80px', fontSize: '12px', padding: '4px 8px' }}
                          />
                          {/* MCP connectivity probe (tools.connect_test) */}
                          {field === 'mcpTools' && (
                            <button
                              type="button" className="btn btn-ghost"
                              style={{ padding: '4px 6px', fontSize: '11px', color: 'var(--color-info)', flexShrink: 0, whiteSpace: 'nowrap' }}
                              onClick={() => handleTestMcp(item, idx)}
                              disabled={testingMcp === idx}
                              title="测试连接（stdio 命令或 http(s) URL）"
                            >
                              {testingMcp === idx ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />} 测试连接
                            </button>
                          )}
                          {/* Remove */}
                          <button type="button" className="btn btn-ghost" style={{ padding: '4px', color: 'var(--fg-muted)' }} onClick={() => removeFormItem(field, idx)} aria-label="移除">
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="btn btn-secondary" onClick={() => setShowFormModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveForm}>
                <Check size={14} /> {editingAgent ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Import Modal ─── */}
      {showImportModal && (
        <div className="agent-modal-overlay" onClick={() => setShowImportModal(false)} role="presentation">
          <div className="agent-modal agent-modal-sm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="agent-import-title">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 id="agent-import-title" style={{ fontSize: '15px', fontWeight: 590, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={18} style={{ color: 'var(--accent)' }} />
                导入智能体配置
              </h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowImportModal(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            {/* File upload */}
            <div
              style={{
                border: '2px dashed var(--border-subtle)', borderRadius: '10px',
                padding: '24px', textAlign: 'center', marginBottom: '12px',
                cursor: 'pointer', transition: 'border-color 0.2s',
              }}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
              role="button"
              tabIndex={0}
            >
              <FileJson size={32} style={{ color: 'var(--fg-muted)', marginBottom: '8px', opacity: 0.5 }} />
              <div style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '4px' }}>
                点击选择 JSON 配置文件
              </div>
              <div style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                支持单个智能体或批量配置包
              </div>
              <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleImportFile} style={{ display: 'none' }} />
            </div>

            {/* Or paste JSON */}
            <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '6px' }}>或粘贴 JSON 配置文本</div>
            <textarea
              className="input agent-textarea"
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder='{"type":"flowforge-agent","agent":{"name":"...", ...}}'
              rows={4}
              style={{ fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button className="btn btn-secondary" onClick={() => setShowImportModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleImportText} disabled={!importText.trim()}>
                <Upload size={14} /> 导入
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete Confirmation Modal ─── */}
      {showDeleteConfirm && deletingAgent && (
        <div className="agent-modal-overlay" onClick={() => setShowDeleteConfirm(false)} role="presentation">
          <div className="agent-modal agent-modal-sm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="agent-delete-title">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginBottom: '20px' }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '10px', flexShrink: 0,
                background: 'color-mix(in srgb, var(--color-error) 12%, var(--bg))',
                color: 'var(--color-error)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <AlertCircle size={20} />
              </div>
              <div>
                <h3 id="agent-delete-title" style={{ fontSize: '15px', fontWeight: 590, margin: '0 0 6px 0' }}>
                  确认删除智能体
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--fg-tertiary)', margin: 0, lineHeight: 1.6 }}>
                  确定要删除「<strong style={{ color: 'var(--fg)' }}>{deletingAgent.name}</strong>」吗？
                  删除后该智能体将停用并取消所有阶段分配，此操作可被重新启用恢复。
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>取消</button>
              <button className="btn btn-primary" style={{ background: 'var(--color-error)', borderColor: 'var(--color-error)' }} onClick={handleConfirmDelete}>
                <Trash2 size={14} /> 确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
