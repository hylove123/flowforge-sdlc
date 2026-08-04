import React, { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  Settings, Users, Bell, Code2, Shield,
  FileText, Plug, Plus, ChevronRight, Save,
  Monitor, ExternalLink, Cloud, Check, X, Key, Zap,
  CheckCircle, AlertCircle, Eye, EyeOff, Server, Download, Upload, Database, GitBranch,
  Copy, Loader2, Info, RefreshCw,
} from 'lucide-react'
import { useApp, EMPTY_WORKSPACE_PROJECT_ID } from '@/context/AppContext'
import { useSidecar } from '@/context/SidecarContext'
import { Toggle } from '@/components/ui/Toggle'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import { hasAPIKey, getActiveModel, getCustomModels } from '@/services/ai'
import { parseMcpServersJson, exportMcpServersJson, toMcpServerConfig } from '@/services/mcpConfig'
import {
  getGitCredentials, addGitCredential, updateGitCredential, deleteGitCredential,
  DEFAULT_GIT_USERNAME,
} from '@/services/gitCredentials'
import { exportAllData, importAllData } from '@/services/dataTransfer'
import { checkForUpdate, downloadAndInstall, describeUpdateError } from '@/services/appUpdater'

const notificationDefs = [
  { key: 'stageComplete', label: '阶段完成通知', desc: '每个阶段AI生成完成后发送通知' },
  { key: 'aiReviewComplete', label: 'AI评审完成通知', desc: 'AI评审完成后通知相关人员' },
  { key: 'humanReviewRequest', label: '人工评审请求', desc: '需要人工评审时发送请求' },
  { key: 'devComplete', label: '开发完成通知', desc: '开发环节完成时通知测试团队' },
  { key: 'deliverySuccess', label: '交付成功通知', desc: '成功交付时通知全团队' },
  { key: 'errorAlert', label: '错误告警', desc: '模型调用失败或流程异常时告警' },
]

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general')
  const {
    currentProject,
    projects,
    setCurrentProject,
    devMode,
    setDevMode,
    toggleProjectConfigItem,
    toggleNotification,
    showToast,
    addUser,
    removeUser,
    updateProjectConfig,
    users,
    currentUser,
  } = useApp()

  const skills = currentProject.skills || []
  const rules = currentProject.rules || []
  const mcpTools = currentProject.mcpTools || []
  const notifications = currentProject.notifications || {}

  // Placeholder workspace (no real project yet) is read-only: project-scoped
  // config writes are rejected by the reducer, so block them here with a hint.
  const isPlaceholderProject = currentProject.id === EMPTY_WORKSPACE_PROJECT_ID
  const guardProjectWrite = () => {
    if (isPlaceholderProject) {
      showToast('请先创建项目，再进行项目配置', 'error')
      return false
    }
    return true
  }

  const [showInviteMember, setShowInviteMember] = useState(false)
  const [showCreateSkill, setShowCreateSkill] = useState(false)
  const [showCreateRule, setShowCreateRule] = useState(false)
  const [showConfigMCP, setShowConfigMCP] = useState(false)

  // ── 关于与自动更新（tauri-plugin-updater） ──
  const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  const [appVersion, setAppVersion] = useState('')
  const [updateState, setUpdateState] = useState('idle') // idle|checking|available|latest|downloading|error
  const [updateInfo, setUpdateInfo] = useState(null)
  const [updateError, setUpdateError] = useState('')
  const [updateProgress, setUpdateProgress] = useState(0)

  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/app').then(({ getVersion }) => getVersion().then(setAppVersion)).catch(() => {})
  }, [isTauri])

  const handleCheckUpdate = async () => {
    setUpdateState('checking')
    setUpdateError('')
    try {
      const upd = await checkForUpdate()
      if (upd) {
        setUpdateInfo(upd)
        setUpdateState('available')
      } else {
        setUpdateState('latest')
      }
    } catch (e) {
      setUpdateError(describeUpdateError(e))
      setUpdateState('error')
    }
  }

  const handleInstallUpdate = async () => {
    setUpdateState('downloading')
    setUpdateProgress(0)
    try {
      await downloadAndInstall(({ percent }) => setUpdateProgress(percent))
      // relaunch 后不会走到这里
    } catch (e) {
      setUpdateError(describeUpdateError(e))
      setUpdateState('error')
    }
  }

  const [inviteForm, setInviteForm] = useState({ name: '', role: '产品经理', email: '' })
  const [skillForm, setSkillForm] = useState({ name: '', desc: '', stage: '需求分析' })
  const [ruleForm, setRuleForm] = useState({ name: '', desc: '', stage: '需求分析' })
  const [mcpForm, setMcpForm] = useState({ name: '', desc: '' })

  // ── MCP JSON 模式（标准 mcpServers 格式粘贴/导出） ──
  const sidecar = useSidecar()
  const [showJsonMcp, setShowJsonMcp] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonResult, setJsonResult] = useState(null)
  const [testingMcpName, setTestingMcpName] = useState(null)

  const openJsonMcp = () => {
    setJsonText(exportMcpServersJson(mcpTools))
    setJsonResult(null)
    setShowJsonMcp(true)
  }

  const handleParseJson = () => {
    setJsonResult(parseMcpServersJson(jsonText))
  }

  const handleImportJson = () => {
    const res = parseMcpServersJson(jsonText)
    setJsonResult(res)
    if (res.errors.length > 0 || res.entries.length === 0) return
    const merged = [...mcpTools]
    for (const entry of res.entries) {
      const idx = merged.findIndex(t => t.name === entry.name)
      if (idx >= 0) merged[idx] = { ...entry, enabled: merged[idx].enabled !== false }
      else merged.push(entry)
    }
    updateProjectConfig(currentProject.id, 'mcpTools', merged)
    showToast(`已导入 ${res.entries.length} 个 MCP 服务配置`, 'success')
    setShowJsonMcp(false)
  }

  const handleTestJsonMcp = async (entry) => {
    const cfg = toMcpServerConfig(entry)
    if (!cfg) return
    if (sidecar.mode !== 'tauri' || !sidecar.isReady) {
      showToast('测试连接需要 sidecar 就绪', 'info')
      return
    }
    setTestingMcpName(entry.name)
    try {
      const res = await sidecar.invoke('tools.connect_test', { server: cfg })
      if (res?.ok) {
        showToast(`「${cfg.name}」连接成功，发现 ${res.tools?.length ?? 0} 个工具`, 'success')
      } else {
        showToast(`「${cfg.name}」连接失败：${res?.error || '未知错误'}`, 'error')
      }
    } catch (e) {
      showToast(`连接测试失败：${e?.message || e}`, 'error')
    } finally {
      setTestingMcpName(null)
    }
  }

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText || exportMcpServersJson(mcpTools))
      showToast('JSON 已复制到剪贴板', 'success')
    } catch {
      showToast('复制失败，请手动选中文本复制', 'error')
    }
  }

  const stageOptions = ['需求分析', 'BRD生成', 'PRD生成', '测试用例', '开发方案', '开发', 'Code Review', '自动化测试', '交付']
  const roleOptions = ['产品经理', '开发工程师', '测试工程师', '架构师', '解决方案']

  // AI model status
  const activeModel = getActiveModel()
  const modelCount = getCustomModels().length

  // Git credentials (per-host token auth for clone/push)
  const [gitCreds, setGitCreds] = useState(() => getGitCredentials())
  const [gitCredForm, setGitCredForm] = useState({ host: '', username: '', token: '' })
  const [editingCredId, setEditingCredId] = useState(null)
  const [showCredToken, setShowCredToken] = useState(false)

  const resetGitCredForm = () => {
    setGitCredForm({ host: '', username: '', token: '' })
    setEditingCredId(null)
    setShowCredToken(false)
  }

  const handleSaveGitCred = () => {
    const host = gitCredForm.host.trim()
    const token = gitCredForm.token.trim()
    if (!host || !token) {
      showToast('请填写 Git 服务器地址和 Token', 'error')
      return
    }
    const payload = { host, username: gitCredForm.username.trim() || DEFAULT_GIT_USERNAME, token }
    if (editingCredId) {
      updateGitCredential(editingCredId, payload)
      showToast(`已更新「${host}」的 Git 凭证`, 'success')
    } else {
      addGitCredential(payload)
      showToast(`已添加「${host}」的 Git 凭证`, 'success')
    }
    setGitCreds(getGitCredentials())
    resetGitCredForm()
  }

  const handleEditGitCred = (cred) => {
    setEditingCredId(cred.id)
    setGitCredForm({ host: cred.host, username: cred.username || '', token: cred.token })
    setShowCredToken(false)
  }

  const handleDeleteGitCred = (cred) => {
    deleteGitCredential(cred.id)
    if (editingCredId === cred.id) resetGitCredForm()
    setGitCreds(getGitCredentials())
    showToast(`已删除「${cred.host}」的 Git 凭证`, 'success')
  }

  // Data export / import (Phase 2a backup tooling)
  const importInputRef = useRef(null)

  const handleExportData = () => {
    const payload = exportAllData()
    const keyCount = Object.keys(payload.data).length
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `flowforge-backup-${payload.exportedAt.slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast(`已导出 ${keyCount} 条数据`, 'success')
  }

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    try {
      const payload = JSON.parse(await file.text())
      const result = importAllData(payload)
      if (result.ok) {
        showToast(`已导入 ${result.keyCount} 条数据，刷新页面后生效`, 'success')
      } else {
        showToast(`导入失败：${result.error}`, 'error')
      }
    } catch (err) {
      showToast('导入失败：文件不是有效的 JSON', 'error')
    }
  }

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowInviteMember(false)
        setShowCreateSkill(false)
        setShowCreateRule(false)
        setShowConfigMCP(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div className="fade-in">
      <div className="page-header">
        <h2>系统设置</h2>
        <button className="btn btn-primary" onClick={() => showToast('设置已保存', 'success')}>
          <Save size={14} /> 保存更改
        </button>
      </div>

      <div className="tabs">
        {[
          { key: 'general', label: '全局配置', icon: Settings },
          { key: 'team', label: '团队成员', icon: Users },
          { key: 'skills', label: 'Skill管理', icon: Code2 },
          { key: 'rules', label: 'Rule管理', icon: Shield },
          { key: 'mcp', label: 'MCP工具', icon: Plug },
          { key: 'gitcreds', label: 'Git 凭证', icon: GitBranch },
          { key: 'notifications', label: '通知设置', icon: Bell },
          { key: 'devenv', label: '开发环境', icon: Monitor },
          { key: 'about', label: '关于与更新', icon: Info },
        ].map(tab => (
          <div key={tab.key}
            className={`tab-item ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}>
            <tab.icon size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            {tab.label}
          </div>
        ))}
      </div>

      {activeTab === 'general' && (
        <div>
          {/* AI Service Status */}
          <div className="card" style={{ maxWidth: '720px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'color-mix(in srgb, var(--color-ai-review) 12%, var(--bg))', color: 'var(--color-ai-review)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Zap size={16} />
              </div>
              <div>
                <h4 style={{ margin: 0 }}>AI 服务</h4>
                <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', margin: '2px 0 0' }}>
                  配置 AI 模型后方可使用对话、文档生成、AI 评审等功能
                </p>
              </div>
            </div>

            {/* Status */}
            <div style={{
              padding: '14px 16px',
              borderRadius: '8px',
              background: hasAPIKey() ? 'var(--surface-success)' : 'var(--surface-human-review)',
              border: `1px solid ${hasAPIKey() ? 'color-mix(in srgb, var(--color-success) 25%, transparent)' : 'color-mix(in srgb, var(--color-human-review) 25%, transparent)'}`,
              fontSize: '13px',
              color: hasAPIKey() ? 'var(--text-success)' : 'var(--text-human-review)',
              display: 'flex', alignItems: 'center', gap: '8px',
              marginBottom: '16px',
            }}>
              {hasAPIKey() ? (
                <>
                  <CheckCircle size={16} />
                  <div>
                    <span>AI 服务就绪</span>
                    {activeModel && (
                      <span style={{ color: 'var(--fg-secondary)', marginLeft: '8px' }}>
                        默认模型：<strong style={{ color: 'var(--fg)' }}>{activeModel.name}</strong>
                        <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', marginLeft: '6px', color: 'var(--fg-tertiary)' }}>{activeModel.modelId}</code>
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <AlertCircle size={16} />
                  <span>尚未配置可用模型，请前往「模型管理」添加</span>
                </>
              )}
            </div>

            {/* Model count summary */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', color: 'var(--fg-tertiary)' }}>
              <span>共 {modelCount} 个已配置模型</span>
              <Link to="/models" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--accent)', textDecoration: 'none', fontWeight: 510 }}>
                <Server size={12} /> 前往模型管理
                <ChevronRight size={12} />
              </Link>
            </div>
          </div>

          {/* Project Config */}
          <div className="card" style={{ maxWidth: '640px' }}>
            <h4 style={{ marginBottom: '20px' }}>项目默认配置</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  默认项目
                </label>
                <select className="select" style={{ width: '100%' }} value={currentProject.id} onChange={(e) => {
                  const proj = projects.find(p => p.id === e.target.value)
                  if (proj) setCurrentProject(proj)
                }}>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Data export / import */}
          <div className="card" style={{ maxWidth: '640px', marginTop: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Database size={16} style={{ color: 'var(--fg-tertiary)' }} />
              <h4 style={{ margin: 0 }}>数据管理</h4>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '16px' }}>
              导出全部 FlowForge 数据（模型配置、流程 DAG、知识图谱、对话记录等）为 JSON 备份文件，或从备份文件导入恢复。
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={handleExportData}>
                <Download size={12} /> 导出数据
              </button>
              <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={() => importInputRef.current?.click()}>
                <Upload size={12} /> 导入数据
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleImportFile}
                aria-label="选择备份文件"
              />
            </div>
          </div>
        </div>
      )}

      {activeTab === 'team' && (
        <div>
          <div className="card">
            <div className="card-header">
              <h4 className="card-title">团队成员 <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--fg-tertiary)', marginLeft: '6px' }}>{users.length} 位成员</span></h4>
              <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={() => setShowInviteMember(true)}>
                <Plus size={12}  /> 邀请成员
              </button>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '12px', padding: '0 4px' }}>
              团队成员为全局配置
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>角色</th>
                  <th>邮箱</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{
                          width: '28px', height: '28px', borderRadius: '50%',
                          background: 'var(--surface)', display: 'flex',
                          alignItems: 'center', justifyContent: 'center',
                          fontSize: '12px', fontWeight: 510, color: 'var(--fg-secondary)'
                        }}>
                          {user.avatarInitial}
                        </div>
                        <span style={{ fontWeight: 510 }}>{user.name}</span>
                      </div>
                    </td>
                    <td>{user.role}</td>
                    <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{user.email || '—'}</td>
                    <td>
                      <button className="btn btn-ghost" style={{ fontSize: '12px' }}>编辑</button>
                      {user.id !== currentUser.id && (
                        <button className="btn btn-ghost" style={{ fontSize: '12px', color: 'var(--color-error, #e53935)' }}
                          onClick={() => { removeUser(user.id); showToast(`已移除成员「${user.name}」`, 'success') }}>
                          移除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'skills' && (
        <div>
          <ConfigScopeBanner />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px', marginTop: '12px' }}>
            <button className="btn btn-primary" style={{ fontSize: '12px' }} onClick={() => { if (guardProjectWrite()) setShowCreateSkill(true) }}>
              <Plus size={12} /> 创建Skill
            </button>
          </div>
          <div className="grid-2">
            {skills.map((skill, i) => (
              <div key={i} className="card" style={{ cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{
                      fontWeight: 510, fontSize: '14px',
                      fontFamily: 'JetBrains Mono, monospace', marginBottom: '4px'
                    }}>
                      {skill.name}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '8px' }}>
                      {skill.desc}
                    </div>
                  </div>
                  <Toggle
                    checked={skill.enabled}
                    onChange={() => {
                      toggleProjectConfigItem(currentProject.id, 'skills', skill.name)
                      showToast(`${skill.name} ${skill.enabled ? '已禁用' : '已启用'}`, 'success')
                    }}
                    label={`启用 ${skill.name}`}
                  />
                </div>
                <span className="status-badge status-progress">
                  <span className="status-dot"></span>
                  {skill.stage}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'rules' && (
        <div>
          <ConfigScopeBanner />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px', marginTop: '12px' }}>
            <button className="btn btn-primary" style={{ fontSize: '12px' }} onClick={() => { if (guardProjectWrite()) setShowCreateRule(true) }}>
              <Plus size={12} /> 创建Rule
            </button>
          </div>
          <div className="card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>规则名称</th>
                  <th>描述</th>
                  <th>适用阶段</th>
                  <th>启用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 510 }}>{rule.name}</td>
                    <td style={{ fontSize: '12px' }}>{rule.desc}</td>
                    <td>
                      <span className="status-badge status-progress">
                        <span className="status-dot"></span>
                        {rule.stage}
                      </span>
                    </td>
                    <td>
                      <Toggle
                        checked={rule.enabled}
                        onChange={() => {
                          toggleProjectConfigItem(currentProject.id, 'rules', rule.name)
                          showToast(`${rule.name} ${rule.enabled ? '已禁用' : '已启用'}`, 'success')
                        }}
                        label={`启用 ${rule.name}`}
                      />
                    </td>
                    <td>
                      <button className="btn btn-ghost" style={{ fontSize: '12px' }}>编辑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'mcp' && (
        <div>
          <ConfigScopeBanner />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginBottom: '12px', marginTop: '12px' }}>
            <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={() => { if (guardProjectWrite()) openJsonMcp() }}>
              <Code2 size={12} /> JSON 模式
            </button>
            <button className="btn btn-primary" style={{ fontSize: '12px' }} onClick={() => { if (guardProjectWrite()) setShowConfigMCP(true) }}>
              <Plus size={12} /> 配置MCP
            </button>
          </div>
          <div className="grid-2">
            {mcpTools.map((tool, i) => (
              <div key={i} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <div style={{
                      width: '36px', height: '36px', borderRadius: '8px',
                      background: tool.enabled ? 'color-mix(in srgb, var(--color-success) 8%, var(--bg))' : 'var(--surface)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                      <Plug size={16} style={{
                        color: tool.enabled ? 'var(--color-success)' : 'var(--fg-muted)'
                      }} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 510, fontSize: '14px' }}>{tool.name}</div>
                      <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{tool.desc || tool.description}</div>
                      {tool.url && (
                        <code style={{
                          fontSize: '11px', color: 'var(--fg-muted)', display: 'block',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px'
                        }}>{tool.url}</code>
                      )}
                    </div>
                  </div>
                  <Toggle
                    checked={tool.enabled}
                    onChange={() => {
                      toggleProjectConfigItem(currentProject.id, 'mcpTools', tool.name)
                      showToast(`${tool.name} ${tool.enabled ? '已禁用' : '已启用'}`, 'success')
                    }}
                    label={`启用 ${tool.name}`}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'gitcreds' && (
        <div>
          <div className="card" style={{ maxWidth: '720px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Key size={16} style={{ color: 'var(--fg-tertiary)' }} />
              <h4 style={{ margin: 0 }}>Git 凭证</h4>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '16px', lineHeight: '1.7' }}>
              按 Git 服务器地址配置访问 Token（如 GitLab Personal Access Token），克隆与推送 HTTP(S) 仓库时自动使用。
              Token 仅保存在本机，不会写入仓库的 .git/config，也不会出现在日志与错误信息中。
              未配置的地址回退到系统 Git 凭证（credential helper / SSH）。
            </p>

            {gitCreds.length > 0 && (
              <table className="data-table" style={{ marginBottom: '20px' }}>
                <thead>
                  <tr>
                    <th>服务器地址</th>
                    <th>用户名</th>
                    <th>Token</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {gitCreds.map((cred) => (
                    <tr key={cred.id}>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{cred.host}</td>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{cred.username || DEFAULT_GIT_USERNAME}</td>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', color: 'var(--fg-muted)' }}>
                        ••••••••{String(cred.token || '').slice(-4)}
                      </td>
                      <td>
                        <button className="btn btn-ghost" style={{ fontSize: '12px' }} onClick={() => handleEditGitCred(cred)}>编辑</button>
                        <button className="btn btn-ghost" style={{ fontSize: '12px', color: 'var(--color-error, #e53935)' }}
                          onClick={() => handleDeleteGitCred(cred)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4 style={{ fontSize: '13px', marginBottom: '12px' }}>{editingCredId ? '编辑凭证' : '添加凭证'}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>Git 服务器地址</label>
                <input className="input" style={{ width: '100%' }} value={gitCredForm.host}
                  onChange={e => setGitCredForm(f => ({ ...f, host: e.target.value }))}
                  placeholder="例如 gitlab.example.com 或 172.16.162.150（仅主机名/IP，可带端口）" />
              </div>
              <div>
                <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>用户名（可选）</label>
                <input className="input" style={{ width: '100%' }} value={gitCredForm.username}
                  onChange={e => setGitCredForm(f => ({ ...f, username: e.target.value }))}
                  placeholder={`默认 ${DEFAULT_GIT_USERNAME}（GitLab PAT 无需修改）`} />
              </div>
              <div>
                <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>Token</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input className="input" style={{ flex: 1 }} type={showCredToken ? 'text' : 'password'}
                    value={gitCredForm.token}
                    onChange={e => setGitCredForm(f => ({ ...f, token: e.target.value }))}
                    placeholder="例如 glpat-xxxxxxxxxxxxxxxxxxxx"
                    aria-label="Git Token" />
                  <button className="btn btn-secondary" style={{ fontSize: '12px' }}
                    onClick={() => setShowCredToken(v => !v)}
                    aria-label={showCredToken ? '隐藏 Token' : '显示 Token'}>
                    {showCredToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                {editingCredId && (
                  <button className="btn btn-secondary" style={{ fontSize: '12px' }} onClick={resetGitCredForm}>取消编辑</button>
                )}
                <button className="btn btn-primary" style={{ fontSize: '12px' }} onClick={handleSaveGitCred}>
                  <Plus size={12} /> {editingCredId ? '保存修改' : '添加凭证'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'notifications' && (
        <div>
          <ConfigScopeBanner />
          <div className="card" style={{ maxWidth: '640px', marginTop: '12px' }}>
            <h4 style={{ marginBottom: '20px' }}>通知设置</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {notificationDefs.map((notif) => (
                <div key={notif.key} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px', border: '1px solid var(--border-subtle)', borderRadius: '6px'
                }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 510 }}>{notif.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{notif.desc}</div>
                  </div>
                  <Toggle
                    checked={!!notifications[notif.key]}
                    onChange={() => {
                      if (!guardProjectWrite()) return
                      toggleNotification(currentProject.id, notif.key)
                      showToast(`${notif.label} ${notifications[notif.key] ? '已关闭' : '已开启'}`, 'success')
                    }}
                    label={notif.label}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'devenv' && (
        <div>
          <p style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginBottom: '20px', padding: '0 4px' }}>
            开发环境是用户级偏好，适用于所有项目。每位用户可以根据自己的工具和工作习惯自行选择。
          </p>
          <div className="grid-3" style={{ gap: '16px' }}>
            {/* URI Scheme */}
            <div
              role="button"
              tabIndex={0}
              aria-pressed={devMode === 'uri-scheme'}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDevMode('uri-scheme'); showToast('已切换为本地IDE模式', 'success') } }}
              style={{
                padding: '20px', borderRadius: '10px', cursor: 'pointer',
                border: devMode === 'uri-scheme' ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: devMode === 'uri-scheme' ? 'color-mix(in srgb, var(--accent) 4%, var(--bg))' : 'var(--bg)',
                transition: 'all 0.15s'
              }}
              onClick={() => { setDevMode('uri-scheme'); showToast('已切换为本地IDE模式', 'success') }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <ExternalLink size={18} style={{ color: devMode === 'uri-scheme' ? 'var(--accent)' : 'var(--fg-tertiary)' }} />
                <span style={{ fontWeight: 510, fontSize: '15px' }}>本地IDE</span>
                <span style={{
                  fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
                  background: 'var(--surface)', color: 'var(--fg-tertiary)'
                }}>URI Scheme</span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: '1.7', marginBottom: '16px' }}>
                零安装，直接唤起已安装的IDE打开项目仓库。轻量快捷，适合日常编码。
              </p>
              <div style={{ fontSize: '12px', color: 'var(--fg-muted)', marginBottom: '12px' }}>支持的IDE：</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {['VS Code', 'Cursor'].map(ide => (
                  <span key={ide} style={{
                    padding: '3px 10px', background: 'color-mix(in srgb, var(--color-success) 8%, var(--bg))',
                    color: 'var(--color-success)',
                    borderRadius: '4px', fontSize: '11px', fontWeight: 510
                  }}>
                    <Check size={10} style={{ verticalAlign: 'middle', marginRight: '3px' }} />
                    {ide}
                  </span>
                ))}
              </div>
            </div>

            {/* Bridge Agent */}
            <div
              role="button"
              tabIndex={0}
              aria-pressed={devMode === 'bridge-agent'}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDevMode('bridge-agent'); showToast('已切换为Bridge Agent模式', 'success') } }}
              style={{
                padding: '20px', borderRadius: '10px', cursor: 'pointer',
                border: devMode === 'bridge-agent' ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: devMode === 'bridge-agent' ? 'color-mix(in srgb, var(--accent) 4%, var(--bg))' : 'var(--bg)',
                transition: 'all 0.15s', position: 'relative'
              }}
              onClick={() => { setDevMode('bridge-agent'); showToast('已切换为Bridge Agent模式', 'success') }}
            >
              <span style={{
                position: 'absolute', top: '12px', right: '12px',
                padding: '2px 8px', background: 'var(--accent)', color: 'white',
                borderRadius: '4px', fontSize: '10px', fontWeight: 600
              }}>推荐</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <Monitor size={18} style={{ color: devMode === 'bridge-agent' ? 'var(--accent)' : 'var(--fg-tertiary)' }} />
                <span style={{ fontWeight: 510, fontSize: '15px' }}>Bridge Agent</span>
                <span style={{
                  fontSize: '11px', padding: '1px 6px', borderRadius: '4px',
                  background: devMode === 'bridge-agent' ? 'color-mix(in srgb, var(--accent) 12%, var(--bg))' : 'var(--surface)',
                  color: devMode === 'bridge-agent' ? 'var(--accent)' : 'var(--fg-tertiary)'
                }}>深度集成</span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: '1.7', marginBottom: '16px' }}>
                安装Bridge Agent后，支持Git操作、分支管理、代码同步、终端命令等深度集成能力。
              </p>
              <div style={{ fontSize: '12px', color: 'var(--fg-muted)', marginBottom: '12px' }}>兼容工具：</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {['VS Code', 'Cursor', 'Trae', 'Qoder', 'Codex CLI'].map(ide => (
                  <span key={ide} style={{
                    padding: '3px 10px',
                    background: ['VS Code', 'Cursor'].includes(ide)
                      ? 'color-mix(in srgb, var(--color-success) 8%, var(--bg))'
                      : 'var(--surface)',
                    color: ['VS Code', 'Cursor'].includes(ide)
                      ? 'var(--color-success)' : 'var(--fg-tertiary)',
                    borderRadius: '4px', fontSize: '11px', fontWeight: 510
                  }}>
                    {ide}
                  </span>
                ))}
              </div>
            </div>

            {/* Cloud Dev */}
            <div
              role="button"
              tabIndex={0}
              aria-pressed={devMode === 'cloud'}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDevMode('cloud'); showToast('已切换为云端开发模式', 'success') } }}
              style={{
                padding: '20px', borderRadius: '10px', cursor: 'pointer',
                border: devMode === 'cloud' ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: devMode === 'cloud' ? 'color-mix(in srgb, var(--accent) 4%, var(--bg))' : 'var(--bg)',
                transition: 'all 0.15s'
              }}
              onClick={() => { setDevMode('cloud'); showToast('已切换为云端开发模式', 'success') }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <Cloud size={18} style={{ color: devMode === 'cloud' ? 'var(--accent)' : 'var(--fg-tertiary)' }} />
                <span style={{ fontWeight: 510, fontSize: '15px' }}>云端开发</span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: '1.7', marginBottom: '16px' }}>
                无需本地工具链，在浏览器内的云端IDE中直接编码。适合轻量修改、紧急Hotfix和远程协作场景。
              </p>
              <span style={{
                padding: '3px 10px', background: 'color-mix(in srgb, var(--color-progress) 8%, var(--bg))',
                color: 'var(--color-progress)',
                borderRadius: '4px', fontSize: '11px', fontWeight: 510
              }}>
                始终可用
              </span>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'about' && (
        <div>
          {/* 应用信息 */}
          <div className="card" style={{ maxWidth: '720px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent) 12%, var(--bg))', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Info size={16} />
              </div>
              <div>
                <h4 style={{ margin: 0 }}>FlowForge SDLC</h4>
                <p style={{ fontSize: '12px', color: 'var(--fg-tertiary)', margin: '2px 0 0' }}>
                  团队 AI 交付流程编排平台 · 纯客户端桌面应用{appVersion ? ` · v${appVersion}` : ''}
                </p>
              </div>
            </div>

            {/* 自动更新 */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '240px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 510 }}>自动更新</div>
                  <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginTop: '2px' }}>
                    {updateState === 'idle' && '检查是否有新版本；更新包经签名校验后自动安装并重启'}
                    {updateState === 'checking' && '正在检查更新…'}
                    {updateState === 'latest' && `当前已是最新版本${appVersion ? `（v${appVersion}）` : ''}`}
                    {updateState === 'available' && `发现新版本 v${updateInfo?.version}`}
                    {updateState === 'downloading' && `正在下载更新… ${updateProgress}%`}
                    {updateState === 'error' && updateError}
                  </div>
                  {updateState === 'available' && updateInfo?.body && (
                    <pre style={{ fontSize: '12px', color: 'var(--fg-secondary)', background: 'var(--surface)', padding: '10px 12px', borderRadius: '8px', marginTop: '8px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', maxHeight: '140px', overflowY: 'auto' }}>
                      {updateInfo.body}
                    </pre>
                  )}
                  {updateState === 'downloading' && (
                    <div style={{ marginTop: '10px', height: '6px', borderRadius: '3px', background: 'var(--surface)', overflow: 'hidden' }}>
                      <div style={{ width: `${updateProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {updateState === 'available' ? (
                    <button className="btn btn-primary" onClick={handleInstallUpdate}>
                      <Download size={14} /> 安装并重启
                    </button>
                  ) : (
                    <button
                      className="btn"
                      onClick={handleCheckUpdate}
                      disabled={!isTauri || updateState === 'checking' || updateState === 'downloading'}
                    >
                      {updateState === 'checking' ? <Loader2 size={14} className="ff-spin" /> : <RefreshCw size={14} />}
                      检查更新
                    </button>
                  )}
                </div>
              </div>
              {!isTauri && (
                <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '10px' }}>
                  自动更新仅在桌面客户端（Tauri）中可用
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Invite Member Dialog */}
      {showInviteMember && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowInviteMember(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '90vw', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="invite-member-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h4 id="invite-member-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>邀请成员</h4>
              <div role="button" tabIndex={0} onClick={() => setShowInviteMember(false)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowInviteMember(false) } }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <X size={16} />
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>成员姓名</label>
              <input className="input" style={{ width: '100%' }} value={inviteForm.name} onChange={e => setInviteForm(f => ({ ...f, name: e.target.value }))} placeholder="请输入成员姓名" />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>角色</label>
              <select className="select" style={{ width: '100%' }} value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}>
                {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>邮箱</label>
              <input className="input" type="email" style={{ width: '100%' }} value={inviteForm.email} onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))} placeholder="name@example.com" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn btn-secondary" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowInviteMember(false) } }}
                onClick={() => setShowInviteMember(false)}>取消</button>
              <button className="btn btn-primary" role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (inviteForm.name.trim()) { addUser({ id: 'u' + Date.now(), name: inviteForm.name, role: inviteForm.role, roleTag: inviteForm.role.slice(0, 2), avatarInitial: inviteForm.name.charAt(0), email: inviteForm.email }); showToast('已邀请「' + inviteForm.name + '」加入团队', 'success'); setInviteForm({ name: '', role: '产品经理', email: '' }); setShowInviteMember(false) } } }}
                onClick={() => { if (inviteForm.name.trim()) { addUser({ id: 'u' + Date.now(), name: inviteForm.name, role: inviteForm.role, roleTag: inviteForm.role.slice(0, 2), avatarInitial: inviteForm.name.charAt(0), email: inviteForm.email }); showToast('已邀请「' + inviteForm.name + '」加入团队', 'success'); setInviteForm({ name: '', role: '产品经理', email: '' }); setShowInviteMember(false) } }}>
                邀请
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Skill Dialog */}
      {showCreateSkill && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowCreateSkill(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '90vw', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-skill-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h4 id="create-skill-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>创建Skill</h4>
              <div role="button" tabIndex={0} onClick={() => setShowCreateSkill(false)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCreateSkill(false) } }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <X size={16} />
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>Skill名称</label>
              <input className="input" style={{ width: '100%' }} value={skillForm.name} onChange={e => setSkillForm(f => ({ ...f, name: e.target.value }))} placeholder="例如: PRD-Generator" />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>描述</label>
              <textarea className="input" style={{ width: '100%', minHeight: '80px', resize: 'vertical' }} value={skillForm.desc} onChange={e => setSkillForm(f => ({ ...f, desc: e.target.value }))} placeholder="请描述该Skill的功能" />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>适用阶段</label>
              <select className="select" style={{ width: '100%' }} value={skillForm.stage} onChange={e => setSkillForm(f => ({ ...f, stage: e.target.value }))}>
                {stageOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn btn-secondary" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCreateSkill(false) } }}
                onClick={() => setShowCreateSkill(false)}>取消</button>
              <button className="btn btn-primary" role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (skillForm.name.trim()) { const newSkills = [...(currentProject.skills || []), { name: skillForm.name, desc: skillForm.desc, stage: skillForm.stage, enabled: true }]; updateProjectConfig(currentProject.id, 'skills', newSkills); showToast('Skill「' + skillForm.name + '」已创建', 'success'); setSkillForm({ name: '', desc: '', stage: '需求分析' }); setShowCreateSkill(false) } } }}
                onClick={() => { if (skillForm.name.trim()) { const newSkills = [...(currentProject.skills || []), { name: skillForm.name, desc: skillForm.desc, stage: skillForm.stage, enabled: true }]; updateProjectConfig(currentProject.id, 'skills', newSkills); showToast('Skill「' + skillForm.name + '」已创建', 'success'); setSkillForm({ name: '', desc: '', stage: '需求分析' }); setShowCreateSkill(false) } }}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Rule Dialog */}
      {showCreateRule && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowCreateRule(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '90vw', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-rule-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h4 id="create-rule-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>创建Rule</h4>
              <div role="button" tabIndex={0} onClick={() => setShowCreateRule(false)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCreateRule(false) } }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <X size={16} />
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>规则名称</label>
              <input className="input" style={{ width: '100%' }} value={ruleForm.name} onChange={e => setRuleForm(f => ({ ...f, name: e.target.value }))} placeholder="请输入规则名称" />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>描述</label>
              <textarea className="input" style={{ width: '100%', minHeight: '80px', resize: 'vertical' }} value={ruleForm.desc} onChange={e => setRuleForm(f => ({ ...f, desc: e.target.value }))} placeholder="请描述该规则的内容" />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>适用阶段</label>
              <select className="select" style={{ width: '100%' }} value={ruleForm.stage} onChange={e => setRuleForm(f => ({ ...f, stage: e.target.value }))}>
                {stageOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn btn-secondary" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowCreateRule(false) } }}
                onClick={() => setShowCreateRule(false)}>取消</button>
              <button className="btn btn-primary" role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (ruleForm.name.trim()) { const newRules = [...(currentProject.rules || []), { name: ruleForm.name, desc: ruleForm.desc, stage: ruleForm.stage, enabled: true }]; updateProjectConfig(currentProject.id, 'rules', newRules); showToast('规则「' + ruleForm.name + '」已创建', 'success'); setRuleForm({ name: '', desc: '', stage: '需求分析' }); setShowCreateRule(false) } } }}
                onClick={() => { if (ruleForm.name.trim()) { const newRules = [...(currentProject.rules || []), { name: ruleForm.name, desc: ruleForm.desc, stage: ruleForm.stage, enabled: true }]; updateProjectConfig(currentProject.id, 'rules', newRules); showToast('规则「' + ruleForm.name + '」已创建', 'success'); setRuleForm({ name: '', desc: '', stage: '需求分析' }); setShowCreateRule(false) } }}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config MCP Dialog */}
      {showConfigMCP && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowConfigMCP(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '480px', maxWidth: '90vw', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="config-mcp-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h4 id="config-mcp-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>配置MCP</h4>
              <div role="button" tabIndex={0} onClick={() => setShowConfigMCP(false)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowConfigMCP(false) } }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <X size={16} />
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>MCP工具名称</label>
              <input className="input" style={{ width: '100%' }} value={mcpForm.name} onChange={e => setMcpForm(f => ({ ...f, name: e.target.value }))} placeholder="请输入MCP工具名称" />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>描述</label>
              <textarea className="input" style={{ width: '100%', minHeight: '80px', resize: 'vertical' }} value={mcpForm.desc} onChange={e => setMcpForm(f => ({ ...f, desc: e.target.value }))} placeholder="请描述该MCP工具的功能" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn btn-secondary" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowConfigMCP(false) } }}
                onClick={() => setShowConfigMCP(false)}>取消</button>
              <button className="btn btn-primary" role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (mcpForm.name.trim()) { const newMcpTools = [...(currentProject.mcpTools || []), { name: mcpForm.name, desc: mcpForm.desc, enabled: true }]; updateProjectConfig(currentProject.id, 'mcpTools', newMcpTools); showToast('MCP工具「' + mcpForm.name + '」已配置', 'success'); setMcpForm({ name: '', desc: '' }); setShowConfigMCP(false) } } }}
                onClick={() => { if (mcpForm.name.trim()) { const newMcpTools = [...(currentProject.mcpTools || []), { name: mcpForm.name, desc: mcpForm.desc, enabled: true }]; updateProjectConfig(currentProject.id, 'mcpTools', newMcpTools); showToast('MCP工具「' + mcpForm.name + '」已配置', 'success'); setMcpForm({ name: '', desc: '' }); setShowConfigMCP(false) } }}>
                配置
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MCP JSON 模式弹窗 */}
      {showJsonMcp && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowJsonMcp(false)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '640px', maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="json-mcp-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h4 id="json-mcp-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>MCP JSON 配置</h4>
              <div role="button" tabIndex={0} onClick={() => setShowJsonMcp(false)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowJsonMcp(false) } }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)' }}>
                <X size={16} />
              </div>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '10px', lineHeight: 1.6 }}>
              粘贴标准 mcpServers 格式：{`{ "mcpServers": { "名称": { "command": "npx", "args": [...], "env": {...} } 或 { "url": "http(s)://..." } } }`}。
              当前已有配置已导出在下方，可直接编辑后导入。
            </div>
            <textarea
              className="input"
              value={jsonText}
              onChange={e => setJsonText(e.target.value)}
              spellCheck={false}
              style={{ width: '100%', minHeight: '220px', resize: 'vertical', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', lineHeight: 1.6 }}
              placeholder='{"mcpServers": {"my-server": {"command": "npx", "args": ["-y", "my-mcp-server"]}}}'
            />

            {jsonResult?.errors?.length > 0 && (
              <div style={{
                marginTop: '10px', padding: '10px 12px', borderRadius: '8px',
                background: 'color-mix(in srgb, var(--color-error) 8%, var(--bg))',
                border: '1px solid color-mix(in srgb, var(--color-error) 25%, transparent)'
              }}>
                {jsonResult.errors.map((err, i) => (
                  <div key={i} style={{ fontSize: '12px', color: 'var(--color-error)', lineHeight: 1.8, display: 'flex', gap: '6px' }}>
                    <AlertCircle size={13} style={{ marginTop: '3px', flexShrink: 0 }} />
                    <span>第 {err.line} 行：{err.message}</span>
                  </div>
                ))}
              </div>
            )}

            {jsonResult && jsonResult.errors.length === 0 && jsonResult.entries.length > 0 && (
              <div style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '6px' }}>
                  解析成功，共 {jsonResult.entries.length} 个服务：
                </div>
                {jsonResult.entries.map(entry => (
                  <div key={entry.name} style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px',
                    border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '6px'
                  }}>
                    <Plug size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <span style={{ fontSize: '13px', fontWeight: 510 }}>{entry.name}</span>
                    <span style={{
                      fontSize: '10px', padding: '1px 8px', borderRadius: '9999px', fontWeight: 510,
                      background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)'
                    }}>{entry.type === 'http' ? 'HTTP/SSE' : 'stdio'}</span>
                    <code style={{
                      fontSize: '11px', color: 'var(--fg-muted)', flex: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                    }}>{entry.url}</code>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: '11px', flexShrink: 0 }}
                      onClick={() => handleTestJsonMcp(entry)}
                      disabled={testingMcpName !== null}
                    >
                      {testingMcpName === entry.name ? <Loader2 size={12} className="ff-spin" /> : <Zap size={12} />}
                      {testingMcpName === entry.name ? '测试中' : '测试连接'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button className="btn btn-ghost" onClick={handleCopyJson}>
                <Copy size={13} /> 复制 JSON
              </button>
              <button className="btn btn-secondary" onClick={handleParseJson}>解析校验</button>
              <button className="btn btn-secondary" onClick={() => setShowJsonMcp(false)}>取消</button>
              <button className="btn btn-primary" onClick={() => { if (guardProjectWrite()) handleImportJson() }}>解析并导入</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
