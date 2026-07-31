import React, { useState, useEffect, useCallback } from 'react'
import {
  Plus, X, Trash2, Edit3, Loader2, Eye, EyeOff,
  Check, AlertCircle, Server, Zap, Wifi
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import { Toggle } from '@/components/ui/Toggle'
import {
  getCustomModels, addCustomModel, updateCustomModel, deleteCustomModel,
  testModelConnection, getActiveModelId, setActiveModelId, hasAPIKey
} from '@/services/ai'

const EMPTY_FORM = {
  name: '',
  endpoint: '',
  apiKey: '',
  modelId: '',
}

export default function ModelConfig() {
  const { showToast } = useApp()
  const [models, setModels] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [showDialog, setShowDialog] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [showToken, setShowToken] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [cardTestingId, setCardTestingId] = useState(null)

  const refresh = useCallback(() => {
    setModels(getCustomModels())
    setActiveId(getActiveModelId())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowDialog(false)
        setTestResult(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleOpenAdd = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowToken(false)
    setTestResult(null)
    setShowDialog(true)
  }

  const handleOpenEdit = (model) => {
    setEditingId(model.id)
    setForm({
      name: model.name || '',
      endpoint: model.endpoint || '',
      apiKey: model.apiKey || '',
      modelId: model.modelId || '',
    })
    setShowToken(false)
    setTestResult(null)
    setShowDialog(true)
  }

  const handleSave = () => {
    if (!form.name.trim()) {
      showToast('请填写模型名称', 'error')
      return
    }
    if (!form.endpoint.trim()) {
      showToast('请填写 API 地址', 'error')
      return
    }
    if (!form.modelId.trim()) {
      showToast('请填写模型名称', 'error')
      return
    }

    if (editingId) {
      updateCustomModel(editingId, form)
      showToast('模型已更新', 'success')
    } else {
      const newModel = addCustomModel(form)
      // Auto-activate if it's the first model
      if (models.length === 0) {
        setActiveModelId(newModel.id)
      }
      showToast('模型已添加', 'success')
    }
    refresh()
    setShowDialog(false)
  }

  const handleDelete = (model) => {
    deleteCustomModel(model.id)
    showToast(`已删除「${model.name}」`, 'success')
    refresh()
  }

  const handleToggleEnabled = (model) => {
    updateCustomModel(model.id, { enabled: !model.enabled })
    refresh()
    showToast(`${model.name} ${model.enabled ? '已禁用' : '已启用'}`, 'info')
  }

  const handleSetActive = (model) => {
    setActiveModelId(model.id)
    setActiveId(model.id)
    showToast(`已设为默认模型：${model.name}`, 'success')
  }

  const handleCardTest = async (model) => {
    setCardTestingId(model.id)
    const result = await testModelConnection(model)
    setCardTestingId(null)
    showToast(`${model.name}：${result.message}`, result.success ? 'success' : 'error')
  }

  const handleTest = async () => {
    if (!form.endpoint || !form.modelId) {
      showToast('请先填写 API 地址和模型名称', 'error')
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await testModelConnection(form)
    setTestResult(result)
    setTesting(false)
    showToast(result.message, result.success ? 'success' : 'error')
  }

  const enabledCount = models.filter(m => m.enabled).length

  return (
    <div className="fade-in">
      <ConfigScopeBanner />

      {/* Header */}
      <div className="page-header">
        <div>
          <h2>模型管理</h2>
          <p style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginTop: '4px' }}>
            配置自定义 AI 模型，支持任意 OpenAI 兼容 API（腾讯云、DeepSeek、通义千问等）
          </p>
        </div>
        <button className="btn btn-primary" onClick={handleOpenAdd}>
          <Plus size={14} /> 添加模型
        </button>
      </div>

      {/* Status Bar */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
        <div className="card" style={{ flex: 1, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '10px',
            background: hasAPIKey() ? 'color-mix(in srgb, var(--color-success) 12%, var(--bg))' : 'color-mix(in srgb, var(--color-error) 12%, var(--bg))',
            color: hasAPIKey() ? 'var(--color-success)' : 'var(--color-error)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            {hasAPIKey() ? <Check size={18} /> : <AlertCircle size={18} />}
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg)' }}>
              {hasAPIKey() ? 'AI 服务就绪' : '未配置可用模型'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>
              共 {models.length} 个模型，{enabledCount} 个已启用
            </div>
          </div>
        </div>
      </div>

      {/* Model List */}
      {models.length === 0 ? (
        <div className="card" style={{ padding: '60px 24px', textAlign: 'center' }}>
          <Server size={40} style={{ color: 'var(--fg-muted)', marginBottom: '16px', opacity: 0.4 }} />
          <div style={{ fontSize: '15px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
            还没有配置模型
          </div>
          <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginBottom: '20px' }}>
            添加一个自定义模型即可开始使用 AI 对话和文档生成
          </div>
          <button className="btn btn-primary" onClick={handleOpenAdd}>
            <Plus size={14} /> 添加第一个模型
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {models.map(model => {
            const isActive = model.id === activeId
            return (
              <div
                key={model.id}
                className="card"
                style={{
                  padding: '18px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px',
                  border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: isActive ? 'color-mix(in srgb, var(--accent) 3%, var(--bg))' : 'var(--bg)',
                  opacity: model.enabled ? 1 : 0.5,
                  transition: 'all 0.15s ease',
                }}
              >
                {/* Left: Icon + Active indicator */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                  <div style={{
                    width: '40px', height: '40px', borderRadius: '10px',
                    background: isActive ? 'color-mix(in srgb, var(--accent) 12%, var(--bg))' : 'var(--surface)',
                    color: isActive ? 'var(--accent)' : 'var(--fg-tertiary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    <Server size={18} />
                  </div>
                </div>

                {/* Middle: Model info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 590, color: 'var(--fg)' }}>{model.name}</span>
                    {isActive && (
                      <span style={{
                        fontSize: '10px', fontWeight: 510, color: 'var(--accent)',
                        padding: '1px 6px', borderRadius: '9999px',
                        background: 'color-mix(in srgb, var(--accent) 10%, transparent)'
                      }}>
                        默认
                      </span>
                    )}
                    {!model.enabled && (
                      <span style={{
                        fontSize: '10px', fontWeight: 510, color: 'var(--fg-muted)',
                        padding: '1px 6px', borderRadius: '9999px',
                        background: 'var(--surface)'
                      }}>
                        已禁用
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Zap size={11} />
                      <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--fg-secondary)' }}>{model.modelId}</code>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Wifi size={11} />
                      <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--fg-secondary)' }}>{model.endpoint}</code>
                    </span>
                  </div>
                </div>

                {/* Right: Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  {!isActive && model.enabled && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '12px' }}
                      onClick={() => handleSetActive(model)}
                    >
                      设为默认
                    </button>
                  )}
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '12px', padding: '5px 10px' }}
                    onClick={() => handleCardTest(model)}
                    disabled={cardTestingId === model.id}
                    title="测试连接"
                    aria-label={`测试 ${model.name} 连接`}
                  >
                    {cardTestingId === model.id ? <Loader2 size={12} className="ff-spin" /> : <Wifi size={12} />}
                    {cardTestingId === model.id ? '测试中' : '测试'}
                  </button>
                  <Toggle
                    checked={model.enabled}
                    onChange={() => handleToggleEnabled(model)}
                    label={`${model.enabled ? '禁用' : '启用'} ${model.name}`}
                    size="sm"
                  />
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '6px' }}
                    onClick={() => handleOpenEdit(model)}
                    title="编辑"
                    aria-label={`编辑 ${model.name}`}
                  >
                    <Edit3 size={14} />
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: '6px', color: 'var(--fg-muted)' }}
                    onClick={() => handleDelete(model)}
                    title="删除"
                    aria-label={`删除 ${model.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Help text */}
      <div style={{ marginTop: '24px', padding: '16px 20px', background: 'var(--surface)', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '8px' }}>
          配置说明
        </div>
        <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: 1.7 }}>
          支持任何 OpenAI 兼容的 API 接口。填写 API 地址（如 `https://api.lkeap.cloud.tencent.com/v1`）、Token 和模型名称（如 `hunyuan-pro`）即可。
          常见服务商：腾讯云知识引擎、DeepSeek、通义千问、Moonshot、SiliconFlow、OpenAI 等。
          标记为「默认」的模型将用于 AI 对话和文档生成。
        </div>
      </div>

      {/* Add/Edit Dialog */}
      {showDialog && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowDialog(false)}
          role="presentation"
        >
          <div
            style={{
              background: 'var(--bg)', borderRadius: '14px', padding: '28px',
              width: '500px', maxWidth: '90vw',
              border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.15)'
            }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-dialog-title"
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
              <h3 id="model-dialog-title" style={{ fontSize: '16px', fontWeight: 590, margin: 0 }}>
                {editingId ? '编辑模型' : '添加模型'}
              </h3>
              <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setShowDialog(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* Name */}
              <div>
                <label htmlFor="model-name" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  模型名称 <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>（用于显示和选择）</span>
                </label>
                <input
                  id="model-name"
                  className="input"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="如：腾讯云混元 Pro"
                  style={{ width: '100%' }}
                />
              </div>

              {/* Endpoint */}
              <div>
                <label htmlFor="model-endpoint" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  API 地址
                </label>
                <input
                  id="model-endpoint"
                  className="input"
                  value={form.endpoint}
                  onChange={e => setForm({ ...form, endpoint: e.target.value })}
                  placeholder="https://api.lkeap.cloud.tencent.com/v1"
                  style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                />
                <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '4px' }}>
                  OpenAI 兼容的 API base URL，不含 `/chat/completions`
                </div>
              </div>

              {/* API Key */}
              <div>
                <label htmlFor="model-apikey" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  Token <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>（API Key）</span>
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="model-apikey"
                    className="input"
                    type={showToken ? 'text' : 'password'}
                    value={form.apiKey}
                    onChange={e => setForm({ ...form, apiKey: e.target.value })}
                    placeholder="sk-xxxxxxxxxxxxxxxx"
                    style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                  />
                  <button
                    className="btn btn-ghost"
                    onClick={() => setShowToken(!showToken)}
                    style={{ flexShrink: 0 }}
                    title={showToken ? '隐藏' : '显示'}
                    aria-label={showToken ? '隐藏 Token' : '显示 Token'}
                  >
                    {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {/* Model ID */}
              <div>
                <label htmlFor="model-modelid" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px', color: 'var(--fg-secondary)' }}>
                  模型 ID <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>（发送给 API 的模型标识）</span>
                </label>
                <input
                  id="model-modelid"
                  className="input"
                  value={form.modelId}
                  onChange={e => setForm({ ...form, modelId: e.target.value })}
                  placeholder="如：hunyuan-pro、deepseek-chat、gpt-4o"
                  style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                />
              </div>

              {/* Test Result */}
              {testResult && (
                <div style={{
                  padding: '10px 14px', borderRadius: '8px', fontSize: '12px',
                  background: testResult.success ? 'color-mix(in srgb, var(--color-success) 8%, var(--bg))' : 'color-mix(in srgb, var(--color-error) 8%, var(--bg))',
                  border: `1px solid ${testResult.success ? 'color-mix(in srgb, var(--color-success) 25%, transparent)' : 'color-mix(in srgb, var(--color-error) 25%, transparent)'}`,
                  color: testResult.success ? 'var(--text-success)' : 'var(--text-error)',
                  display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  {testResult.success ? <Check size={14} /> : <AlertCircle size={14} />}
                  {testResult.message}
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginTop: '28px' }}>
              <button
                className="btn btn-secondary"
                onClick={handleTest}
                disabled={testing || !form.endpoint || !form.modelId}
              >
                {testing ? <Loader2 size={14} className="ff-spin" /> : <Wifi size={14} />}
                {testing ? '测试中...' : '测试连接'}
              </button>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={() => setShowDialog(false)}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleSave}>
                  {editingId ? '保存' : '添加'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Spin animation */}
      <style>{`
        @keyframes ff-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .ff-spin { animation: ff-spin 0.8s linear infinite; }
      `}</style>
    </div>
  )
}
