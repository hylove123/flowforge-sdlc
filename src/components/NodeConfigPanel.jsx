import { useState } from 'react'
import {
  X, Plus, Trash2, ChevronDown, ChevronRight,
  Zap, Shield, Brain, FileText, ToggleLeft, ToggleRight
} from 'lucide-react'

const MODELS = ['GPT-4o', 'Claude 3.5 Sonnet', 'DeepSeek V3', 'Qwen-Max', '本地模型 (Ollama)']

export default function NodeConfigPanel({ node, allNodes, onUpdate, onUpdateConfig, onClose }) {
  const [expandedSection, setExpandedSection] = useState('basic')
  const [newSkill, setNewSkill] = useState('')
  const [newRule, setNewRule] = useState('')
  const [newMcp, setNewMcp] = useState('')

  const toggleSection = (section) => {
    setExpandedSection(prev => prev === section ? null : section)
  }

  const config = node.config

  // ─── Skill handlers ─────────────────────────────────────────
  const toggleSkill = (idx) => {
    const skills = [...config.skills]
    skills[idx] = { ...skills[idx], enabled: !skills[idx].enabled }
    onUpdateConfig({ skills })
  }

  const removeSkill = (idx) => {
    onUpdateConfig({ skills: config.skills.filter((_, i) => i !== idx) })
  }

  const addSkill = () => {
    if (!newSkill.trim()) return
    onUpdateConfig({ skills: [...config.skills, { name: newSkill.trim(), desc: '', enabled: true }] })
    setNewSkill('')
  }

  // ─── Rule handlers ──────────────────────────────────────────
  const toggleRule = (idx) => {
    const rules = [...config.rules]
    rules[idx] = { ...rules[idx], enabled: !rules[idx].enabled }
    onUpdateConfig({ rules })
  }

  const removeRule = (idx) => {
    onUpdateConfig({ rules: config.rules.filter((_, i) => i !== idx) })
  }

  const addRule = () => {
    if (!newRule.trim()) return
    onUpdateConfig({ rules: [...config.rules, { name: newRule.trim(), desc: '', enabled: true }] })
    setNewRule('')
  }

  // ─── MCP handlers ───────────────────────────────────────────
  const toggleMcp = (idx) => {
    const mcps = [...config.mcps]
    mcps[idx] = { ...mcps[idx], enabled: !mcps[idx].enabled }
    onUpdateConfig({ mcps })
  }

  const removeMcp = (idx) => {
    onUpdateConfig({ mcps: config.mcps.filter((_, i) => i !== idx) })
  }

  const addMcp = () => {
    if (!newMcp.trim()) return
    onUpdateConfig({ mcps: [...config.mcps, { name: newMcp.trim(), desc: '', enabled: true }] })
    setNewMcp('')
  }

  // ─── Gate handlers ──────────────────────────────────────────
  const updateGate = (key, value) => {
    onUpdateConfig({ gate: { ...config.gate, [key]: value } })
  }

  const Section = ({ id, icon: Icon, title, count }) => (
    <button
      onClick={() => toggleSection(id)}
      className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-[var(--fg)] hover:bg-[var(--bg-secondary)] transition-colors"
    >
      {expandedSection === id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <Icon size={14} className="text-[var(--fg-muted)]" />
      <span className="flex-1 text-left">{title}</span>
      {count !== undefined && (
        <span className="px-1.5 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[10px] text-[var(--fg-muted)]">{count}</span>
      )}
    </button>
  )

  return (
    <div className="w-80 border-l border-[var(--border)] bg-[var(--bg)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div>
          <h3 className="text-sm font-semibold text-[var(--fg)]">节点配置</h3>
          <p className="text-[10px] text-[var(--fg-muted)] mt-0.5">{node.label}</p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--fg-muted)]">
          <X size={16} />
        </button>
      </div>

      {/* Scrollable config sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Basic */}
        <Section id="basic" icon={FileText} title="基本信息" />
        {expandedSection === 'basic' && (
          <div className="px-3 pb-3 space-y-3">
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">节点名称</label>
              <input
                value={node.label}
                onChange={e => onUpdate({ label: e.target.value })}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">本体概念</label>
              <select
                value={node.concept}
                onChange={e => onUpdate({ concept: e.target.value })}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]"
              >
                <option value="Deliverable">Deliverable（交付物）</option>
                <option value="TestCase">TestCase（测试用例）</option>
                <option value="CodeModule">CodeModule（代码模块）</option>
                <option value="Review">Review（评审）</option>
                <option value="Requirement">Requirement（需求）</option>
                <option value="KnowledgeAsset">KnowledgeAsset（知识资产）</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">交付物</label>
              <input
                value={config.deliverables.join(', ')}
                onChange={e => onUpdateConfig({ deliverables: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]"
                placeholder="逗号分隔，如：PRD文档, 用户故事"
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-[var(--fg-muted)]">支持 AI 生成</label>
              <button onClick={() => onUpdateConfig({ generatable: !config.generatable })}>
                {config.generatable
                  ? <ToggleRight size={20} className="text-[var(--accent)]" />
                  : <ToggleLeft size={20} className="text-[var(--fg-muted)]" />
                }
              </button>
            </div>
          </div>
        )}

        {/* Model & Agent */}
        <Section id="model" icon={Brain} title="模型与智能体" />
        {expandedSection === 'model' && (
          <div className="px-3 pb-3 space-y-3">
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">模型</label>
              <select
                value={config.model}
                onChange={e => onUpdateConfig({ model: e.target.value })}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]"
              >
                {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">Temperature: {config.temperature}</label>
              <input
                type="range" min="0" max="1" step="0.1"
                value={config.temperature}
                onChange={e => onUpdateConfig({ temperature: parseFloat(e.target.value) })}
                className="w-full h-1.5 rounded-full appearance-none bg-[var(--border)] cursor-pointer"
              />
              <div className="flex justify-between text-[9px] text-[var(--fg-muted)]">
                <span>精确 (0)</span><span>创意 (1)</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">绑定智能体 ID</label>
              <input
                value={config.agentId || ''}
                onChange={e => onUpdateConfig({ agentId: e.target.value || null })}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]"
                placeholder="如 a1, a2... 留空则不绑定"
              />
            </div>
          </div>
        )}

        {/* Skills */}
        <Section id="skills" icon={Zap} title="Skills" count={config.skills.filter(s => s.enabled).length} />
        {expandedSection === 'skills' && (
          <div className="px-3 pb-3 space-y-1.5">
            {config.skills.map((skill, idx) => (
              <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-secondary)] group">
                <button onClick={() => toggleSkill(idx)} className="shrink-0">
                  {skill.enabled
                    ? <ToggleRight size={16} className="text-[var(--accent)]" />
                    : <ToggleLeft size={16} className="text-[var(--fg-muted)]" />
                  }
                </button>
                <span className={`text-xs flex-1 truncate ${skill.enabled ? 'text-[var(--fg)]' : 'text-[var(--fg-muted)] line-through'}`}>
                  {skill.name}
                </span>
                <button
                  onClick={() => removeSkill(idx)}
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1 mt-2">
              <input
                value={newSkill}
                onChange={e => setNewSkill(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSkill()}
                placeholder="添加 Skill..."
                className="flex-1 text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
              />
              <button onClick={addSkill} className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--accent)]">
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Rules */}
        <Section id="rules" icon={Shield} title="规则" count={config.rules.filter(r => r.enabled).length} />
        {expandedSection === 'rules' && (
          <div className="px-3 pb-3 space-y-1.5">
            {config.rules.map((rule, idx) => (
              <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-secondary)] group">
                <button onClick={() => toggleRule(idx)} className="shrink-0">
                  {rule.enabled
                    ? <ToggleRight size={16} className="text-[var(--accent)]" />
                    : <ToggleLeft size={16} className="text-[var(--fg-muted)]" />
                  }
                </button>
                <span className={`text-xs flex-1 truncate ${rule.enabled ? 'text-[var(--fg)]' : 'text-[var(--fg-muted)] line-through'}`}>
                  {rule.name}
                </span>
                <button
                  onClick={() => removeRule(idx)}
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1 mt-2">
              <input
                value={newRule}
                onChange={e => setNewRule(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addRule()}
                placeholder="添加规则..."
                className="flex-1 text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
              />
              <button onClick={addRule} className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--accent)]">
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}

        {/* MCPs */}
        <Section id="mcps" icon={Zap} title="MCP 工具" count={config.mcps.filter(m => m.enabled).length} />
        {expandedSection === 'mcps' && (
          <div className="px-3 pb-3 space-y-1.5">
            {config.mcps.map((mcp, idx) => (
              <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--bg-secondary)] group">
                <button onClick={() => toggleMcp(idx)} className="shrink-0">
                  {mcp.enabled
                    ? <ToggleRight size={16} className="text-[var(--accent)]" />
                    : <ToggleLeft size={16} className="text-[var(--fg-muted)]" />
                  }
                </button>
                <span className={`text-xs flex-1 truncate ${mcp.enabled ? 'text-[var(--fg)]' : 'text-[var(--fg-muted)] line-through'}`}>
                  {mcp.name}
                </span>
                <button
                  onClick={() => removeMcp(idx)}
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 transition-opacity"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1 mt-2">
              <input
                value={newMcp}
                onChange={e => setNewMcp(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addMcp()}
                placeholder="添加 MCP 工具..."
                className="flex-1 text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
              />
              <button onClick={addMcp} className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--accent)]">
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Gate */}
        <Section id="gate" icon={Shield} title="门禁配置" />
        {expandedSection === 'gate' && (
          <div className="px-3 pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-[var(--fg)]">AI 评审</label>
              <button onClick={() => updateGate('aiReview', !config.gate.aiReview)}>
                {config.gate.aiReview
                  ? <ToggleRight size={20} className="text-[var(--accent)]" />
                  : <ToggleLeft size={20} className="text-[var(--fg-muted)]" />
                }
              </button>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-[var(--fg)]">人工评审</label>
              <button onClick={() => updateGate('humanReview', !config.gate.humanReview)}>
                {config.gate.humanReview
                  ? <ToggleRight size={20} className="text-[var(--accent)]" />
                  : <ToggleLeft size={20} className="text-[var(--fg-muted)]" />
                }
              </button>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-[var(--fg)]">手动触发</label>
              <button onClick={() => updateGate('manualTrigger', !config.gate.manualTrigger)}>
                {config.gate.manualTrigger
                  ? <ToggleRight size={20} className="text-[var(--accent)]" />
                  : <ToggleLeft size={20} className="text-[var(--fg-muted)]" />
                }
              </button>
            </div>
            {config.gate.aiReview && (
              <div>
                <label className="text-[10px] text-[var(--fg-muted)] block mb-1">通过阈值: {config.gate.threshold} 分</label>
                <input
                  type="range" min="0" max="100" step="5"
                  value={config.gate.threshold}
                  onChange={e => updateGate('threshold', parseInt(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none bg-[var(--border)] cursor-pointer"
                />
              </div>
            )}
          </div>
        )}

        {/* Guidance */}
        <Section id="guidance" icon={FileText} title="指引与模板" />
        {expandedSection === 'guidance' && (
          <div className="px-3 pb-3 space-y-3">
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">阶段目标</label>
              <input
                value={config.guidance.goal}
                onChange={e => onUpdateConfig({ guidance: { ...config.guidance, goal: e.target.value } })}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)]"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">质量检查清单（每行一条）</label>
              <textarea
                value={config.guidance.qualityChecklist.join('\n')}
                onChange={e => onUpdateConfig({ guidance: { ...config.guidance, qualityChecklist: e.target.value.split('\n').filter(Boolean) } })}
                rows={4}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)] resize-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--fg-muted)] block mb-1">生成模板 (Prompt)</label>
              <textarea
                value={config.guidance.template}
                onChange={e => onUpdateConfig({ guidance: { ...config.guidance, template: e.target.value } })}
                rows={5}
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)] resize-none font-mono"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
