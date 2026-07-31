import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, X, Bot, User, Sparkles,
  Lightbulb, RefreshCw, AlertCircle, Database
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { streamStageChat, hasAPIKey } from '@/services/ai'
import { hasProjectIndex } from '@/services/codebaseIndex'
import { getAIContext } from '@/services/graph'
import { storage } from '@/adapters/StorageService'

// ─── Chat session persistence (Phase 2a) ──────────────────────
// Sessions live under one KV key (goes into SQLite kv_store in tauri
// mode via StorageService), keyed by project + delivery + stage so the
// history matches the existing per-context reset behavior.
const CHAT_SESSIONS_KEY = 'flowforge_chat_sessions'
const MAX_PERSISTED_SESSIONS = 50

function loadChatSessions() {
  return storage.getJSON(CHAT_SESSIONS_KEY, {})
}

function saveChatSession(sessionId, session) {
  const sessions = loadChatSessions()
  sessions[sessionId] = session
  // cap stored sessions: evict the oldest by updatedAt
  const ids = Object.keys(sessions)
  if (ids.length > MAX_PERSISTED_SESSIONS) {
    ids
      .sort((a, b) => String(sessions[a].updatedAt).localeCompare(String(sessions[b].updatedAt)))
      .slice(0, ids.length - MAX_PERSISTED_SESSIONS)
      .forEach((id) => { delete sessions[id] })
  }
  storage.setJSON(CHAT_SESSIONS_KEY, sessions)
}

function removeChatSession(sessionId) {
  const sessions = loadChatSessions()
  if (sessions[sessionId]) {
    delete sessions[sessionId]
    storage.setJSON(CHAT_SESSIONS_KEY, sessions)
  }
}

// Stage-aware quick prompts
const STAGE_PROMPTS = {
  'req': [
    '这个需求的核心用户场景是什么？',
    '帮我梳理功能优先级',
    '有哪些技术约束需要考虑？',
    '生成用户故事地图',
  ],
  'brd': [
    '帮我分析商业目标和成功指标',
    '竞品分析的关键维度有哪些？',
    'ROI 评估模型怎么建？',
    '生成BRD文档大纲',
  ],
  'prd': [
    '补充交互细节和异常流程',
    '定义验收标准和成功指标',
    '生成功能优先级矩阵',
    '画出核心用户流程图',
  ],
  'test': [
    '根据PRD生成测试用例',
    '补充边界场景和异常流程',
    '生成自动化测试脚本',
    '测试覆盖率要达到多少？',
  ],
  'dev-plan': [
    '推荐技术架构方案',
    '设计数据库表结构',
    '定义API接口规范',
    '评估技术风险和依赖',
  ],
  'dev': [
    '帮我review这段代码',
    '这个功能的实现方案有什么建议？',
    '生成单元测试',
    '性能优化建议',
  ],
  'review': [
    '检查代码规范和质量',
    '安全漏洞扫描',
    '依赖版本检查',
    '生成Code Review报告',
  ],
  'auto-test': [
    '运行自动化测试套件',
    '分析测试失败原因',
    '补充测试覆盖率',
    '生成测试报告',
  ],
  'deploy': [
    '生成部署检查清单',
    '回滚方案怎么设计？',
    '监控告警配置建议',
    '生成Release Notes',
  ],
}

const DEFAULT_PROMPTS = [
  '介绍一下FlowForge的工作流',
  '如何创建一个新项目？',
  '什么是AI评审门禁？',
  '如何配置开发模式？',
]

export default function AiChatPanel({ open, onClose, currentStage, projectName, deliveryTitle, embedded = false, modelOverride = null, projectId = null, flowConfig = null }) {
  const { showToast } = useApp()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [error, setError] = useState(null)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  const [showSuggestions, setShowSuggestions] = useState(true)
  const codebaseReady = projectId ? hasProjectIndex(projectId) : false

  // Stable identity for the persisted session of this chat context
  const sessionId = [projectId || projectName || 'global', deliveryTitle || '-', currentStage?.id || '-'].join('::')

  // Build welcome message
  const buildWelcome = useCallback(() => ({
    role: 'ai',
    content: `你好！我是 **FlowForge AI** 助手 👋\n\n当前项目：**${projectName}**${deliveryTitle ? `\n交付需求：**${deliveryTitle}**` : ''}${currentStage ? `\n当前阶段：**${currentStage.name}**` : ''}\n\n我可以帮你完成需求分析、文档生成、代码实现、测试等任务。请随时提问！${!hasAPIKey() ? '\n\n⚠️ **未配置 AI 模型**，请先在「模型管理」中添加自定义模型。' : ''}`,
    timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  }), [projectName, deliveryTitle, currentStage])

  // Init: restore the persisted session for this context, else welcome
  useEffect(() => {
    if (open && projectName) {
      const saved = loadChatSessions()[sessionId]
      if (saved?.messages?.length > 1) {
        setMessages(saved.messages)
        setShowSuggestions(false)
      } else {
        setMessages([buildWelcome()])
        setShowSuggestions(true)
      }
      setError(null)
    }
  }, [open, projectName, deliveryTitle, currentStage?.id, buildWelcome, sessionId])

  // Persist the session whenever a full exchange settles (not while streaming)
  useEffect(() => {
    if (isTyping || messages.length <= 1) return
    saveChatSession(sessionId, {
      id: sessionId,
      projectId: projectId || null,
      projectName,
      deliveryTitle: deliveryTitle || null,
      stageId: currentStage?.id || null,
      messages,
      updatedAt: new Date().toISOString(),
    })
  }, [messages, isTyping, sessionId, projectId, projectName, deliveryTitle, currentStage?.id])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  const getStagePrompts = () => {
    if (!currentStage) return DEFAULT_PROMPTS
    return STAGE_PROMPTS[currentStage.id] || DEFAULT_PROMPTS
  }

  // Convert internal messages to API format
  const buildApiHistory = useCallback(() => {
    return messages.slice(0, -1).filter(m => m.role === 'user' || m.role === 'ai')
  }, [messages])

  const sendMessage = useCallback(async (text) => {
    const msgText = (text || input.trim()).trim()
    if (!msgText || isTyping) return

    setError(null)
    setShowSuggestions(false)
    setIsTyping(true)

    const userMsg = {
      role: 'user',
      content: msgText,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')

    // Build AI response placeholder
    const aiMsg = {
      role: 'ai',
      content: '',
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    }
    setMessages([...newMessages, aiMsg])

    const apiHistory = messages
      .filter(m => m.role === 'user' || m.role === 'ai')
      .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }))

    try {
      // ─── Knowledge graph context injection ───
      let graphContext = null
      if (projectId && currentStage?.id) {
        graphContext = getAIContext(projectId, currentStage.id, null, flowConfig)
      }

      const stream = streamStageChat(msgText, apiHistory, currentStage?.id, modelOverride, graphContext)
      let fullContent = ''

      for await (const chunk of stream) {
        if (chunk.error) {
          setError(chunk.error)
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = { ...updated[updated.length - 1], content: `❌ 错误：${chunk.error}` }
            return updated
          })
          break
        }
        if (chunk.content) {
          fullContent += chunk.content
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = { ...updated[updated.length - 1], content: fullContent }
            return updated
          })
        }
      }
    } catch (err) {
      const errMsg = err.message || '未知错误'
      setError(errMsg)
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { ...updated[updated.length - 1], content: `❌ 错误：${errMsg}` }
        return updated
      })
    } finally {
      setIsTyping(false)
    }
  }, [input, isTyping, messages, currentStage, showToast, modelOverride])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Render markdown-like content
  const renderContent = (content) => {
    if (!content) return null
    const lines = content.split('\n')
    return lines.map((line, i) => {
      let html = line
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.*?)`/g, '<code class="inline-code">$1</code>')
      // Simple header detection
      if (/^### /.test(html)) {
        html = html.replace(/^### (.*)/, '<h5 style="margin:8px 0 4px;font-weight:590">$1</h5>')
      } else if (/^## /.test(html)) {
        html = html.replace(/^## (.*)/, '<h4 style="margin:10px 0 4px;font-weight:590">$1</h4>')
      } else if (/^# /.test(html)) {
        html = html.replace(/^# (.*)/, '<h3 style="margin:10px 0 4px;font-weight:590">$1</h3>')
      } else if (/^- /.test(html)) {
        html = html.replace(/^- (.*)/, '<div style="padding-left:8px">• $1</div>')
      } else if (/^\d+\.\s/.test(html)) {
        html = html.replace(/^(\d+)\.\s(.*)/, '<div style="padding-left:8px">$1. $2</div>')
      }
      return <div key={i} dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
    })
  }

  if (!embedded && !open) return null

  const hasKey = hasAPIKey()

  const panelContent = (
    <>
      {/* Header */}
      <div className="ai-chat-header">
        <div className="ai-chat-header-left">
          <div className="ai-chat-header-icon">
            <Sparkles size={16} />
          </div>
          <div>
            <div className="ai-chat-header-title">
              FlowForge AI
              {codebaseReady && (
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '3px',
                    fontSize: '9px', fontWeight: 510, marginLeft: '6px',
                    padding: '1px 5px', borderRadius: '9999px',
                    background: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
                    color: 'var(--color-success)', verticalAlign: 'middle'
                  }}
                  title="项目代码库已建立索引，AI 可引用代码上下文"
                >
                  <Database size={9} /> 代码库已索引
                </span>
              )}
            </div>
            {currentStage && (
              <div className="ai-chat-header-subtitle">
                {currentStage.name} · {projectName}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={() => {
              removeChatSession(sessionId)
              setMessages([buildWelcome()])
              setShowSuggestions(true)
              setError(null)
              showToast('对话已重置', 'info')
            }}
            title="重置对话"
          >
            <RefreshCw size={14} />
          </button>
          {!embedded && (
            <button
              className="btn btn-ghost"
              style={{ padding: '6px' }}
              onClick={onClose}
              aria-label="关闭对话窗口"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* API Key Warning */}
      {!hasKey && (
        <div className="ai-chat-warning">
          <AlertCircle size={14} />
          <span>未配置 AI API Key，请在 <strong>设置 → 全局配置</strong> 中配置后即可使用真实 AI 对话</span>
        </div>
      )}

      {/* Messages */}
      <div className="ai-chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`ai-chat-message ${msg.role === 'user' ? 'user' : 'ai'}`}>
            <div className="ai-chat-avatar">
              {msg.role === 'ai' ? <Bot size={16} /> : <User size={16} />}
            </div>
            <div className="ai-chat-bubble">
              <div className="ai-chat-bubble-content">
                {renderContent(msg.content)}
              </div>
              {msg.timestamp && <div className="ai-chat-time">{msg.timestamp}</div>}
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="ai-chat-message ai">
            <div className="ai-chat-avatar"><Bot size={16} /></div>
            <div className="ai-chat-bubble">
              <div className="ai-chat-typing">
                <span className="ai-chat-typing-dot" />
                <span className="ai-chat-typing-dot" />
                <span className="ai-chat-typing-dot" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggestions */}
      {showSuggestions && messages.length <= 1 && (
        <div className="ai-chat-suggestions">
          <div className="ai-chat-suggestions-label">
            <Lightbulb size={12} />
            {hasKey ? '试试这些问题' : '配置 API Key 后即可使用 AI 对话'}
          </div>
          <div className="ai-chat-suggestions-list">
            {getStagePrompts().map((prompt, i) => (
              <button
                key={i}
                className="ai-chat-suggestion-chip"
                onClick={() => sendMessage(prompt)}
                disabled={!hasKey}
                style={!hasKey ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="ai-chat-input-area">
        <textarea
          ref={inputRef}
          className="ai-chat-input"
          placeholder={hasKey
            ? (currentStage ? `在「${currentStage.name}」阶段，我能帮你什么？` : '输入你的问题...')
            : '请先在设置中配置 AI API Key...'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          aria-label="输入消息"
          disabled={!hasKey}
        />
        <button
          className="ai-chat-send-btn"
          onClick={() => sendMessage()}
          disabled={!input.trim() || isTyping || !hasKey}
          aria-label="发送消息"
        >
          <Send size={16} />
        </button>
      </div>
    </>
  )

  if (embedded) {
    return (
      <div className="ai-chat-panel ai-chat-panel--embedded" role="region" aria-label="AI 对话工作区">
        {panelContent}
      </div>
    )
  }

  return (
    <>
      <div className="ai-chat-overlay" onClick={onClose} role="presentation" />
      <div className="ai-chat-panel" role="dialog" aria-label="AI 对话窗口" aria-modal="true">
        {panelContent}
      </div>
    </>
  )
}