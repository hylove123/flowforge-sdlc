import React, { useState, useEffect } from 'react'
import {
  Send, BookOpen,
  GitBranch, FolderTree, ChevronDown, Search, Code2, Database, FileCode, Loader2,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import {
  hasProjectIndex, getProjectIndexStats, searchCodebase,
} from '@/services/codebaseIndex'
import { searchKnowledge, getKnowledgeStats } from '@/services/knowledge'
import { streamChat, hasAPIKey, getActiveModel } from '@/services/ai'

// ISO 时间 → 本地可读时间；无索引时显示「未索引」
function formatIndexTime(iso) {
  if (!iso) return '未索引'
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '未索引' }
}

export default function KnowledgeBase() {
  const [inputValue, setInputValue] = useState('')
  const [activeTab, setActiveTab] = useState('chat')
  const { currentProject, currentUser, showToast } = useApp()

  // 智能问答对话记录 — 已接入 RAG：知识图谱实体 + 代码检索命中 → LLM 流式回答
  const [chatHistory, setChatHistory] = useState([])
  const [asking, setAsking] = useState(false)

  // Knowledge graph state — 纯客户端：统一走 sidecar 知识层（SQLite WAL + 向量检索）
  const [kgQuery, setKgQuery] = useState('')
  const [kgResults, setKgResults] = useState(null)
  const [kgSearching, setKgSearching] = useState(false)
  const [kgStats, setKgStats] = useState(null)

  // Codebase search state (index management itself lives in 项目中心 → 索引管理)
  const [codeQuery, setCodeQuery] = useState('')
  const [codeResults, setCodeResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [indexStats, setIndexStats] = useState(null)
  const [indexReady, setIndexReady] = useState(false)

  useEffect(() => {
    if (currentProject) {
      setIndexReady(hasProjectIndex(currentProject.id))
      setIndexStats(getProjectIndexStats(currentProject.id))
    }
  }, [currentProject, activeTab])

  useEffect(() => {
    if (!currentProject || activeTab !== 'graph') return undefined
    let cancelled = false
    const load = async () => {
      try {
        const stats = await getKnowledgeStats(currentProject.id)
        if (!cancelled) setKgStats(stats)
      } catch (e) {
        if (!cancelled) {
          setKgStats(null)
          showToast(`知识层加载失败：${e?.message || e}`, 'error')
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentProject, activeTab])

  const handleKgSearch = async (override) => {
    const q = (override ?? kgQuery).trim()
    if (!q || !currentProject) return
    if (override !== undefined) setKgQuery(override)
    setKgSearching(true)
    setKgResults(null)
    try {
      setKgResults(await searchKnowledge(q, currentProject.id))
    } catch (e) {
      showToast(`图谱搜索失败：${e?.message || e}`, 'error')
      setKgResults([])
    }
    setKgSearching(false)
  }

  /** 组装 RAG 上下文：知识图谱实体 + 代码检索命中（均尽力而为，失败不阻断）。 */
  const gatherRagContext = async (q) => {
    const sections = []
    try {
      const kg = await searchKnowledge(q, currentProject.id)
      const entities = (kg || []).slice(0, 5)
      if (entities.length > 0) {
        sections.push('【项目知识图谱实体】\n' + entities.map(e =>
          `- ${e.label}（${e.type}${e.stageId ? `，阶段 ${e.stageId}` : ''}）：${(e.snippet || '').slice(0, 200)}`
        ).join('\n'))
      }
    } catch { /* 知识层不可用 → 跳过 */ }
    try {
      if (hasProjectIndex(currentProject.id)) {
        const code = await searchCodebase(currentProject.id, q)
        const hits = (code?.results || []).slice(0, 5)
        if (hits.length > 0) {
          sections.push('【代码检索命中】\n' + hits.map(h =>
            `- \`${h.file}:${h.line}\`（${h.repo}）：${(h.snippet || '').slice(0, 150)}`
          ).join('\n'))
        }
      }
    } catch { /* 代码检索不可用 → 跳过 */ }
    return sections
  }

  const handleSend = async (override) => {
    const q = (override ?? inputValue).trim()
    if (!q || asking) return
    if (!hasAPIKey() || !getActiveModel()) {
      showToast('请先在「模型管理」中添加并启用一个自定义模型', 'error')
      return
    }
    setAsking(true)
    setInputValue('')
    const userMsg = { role: 'user', content: q }
    const aiMsg = { role: 'ai', content: '' }
    setChatHistory(prev => [...prev, userMsg, aiMsg])
    const appendToLast = (patch) => setChatHistory(prev => {
      const next = [...prev]
      next[next.length - 1] = { ...next[next.length - 1], ...patch }
      return next
    })
    try {
      // RAG 上下文（尽力而为）
      const sections = await gatherRagContext(q)
      const contextBlock = sections.length > 0
        ? `\n\n【项目上下文（检索自本项目知识库与代码索引，回答请优先基于以下事实）】\n${sections.join('\n\n')}`
        : ''
      const messages = [
        {
          role: 'system',
          content: `你是 FlowForge 项目知识库问答助手，基于当前项目的知识图谱与代码索引回答问题。要求：回答专业、结构清晰（markdown）；引用代码时给出文件路径；上下文中没有的信息请如实说明。${contextBlock}`,
        },
        // 携带最近 6 轮历史
        ...chatHistory.slice(-12).map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
        { role: 'user', content: q },
      ]
      for await (const chunk of streamChat(messages, { temperature: 0.4 })) {
        if (chunk.error) throw new Error(chunk.error)
        if (chunk.content) {
          setChatHistory(prev => {
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, content: last.content + chunk.content }
            return next
          })
        }
      }
    } catch (e) {
      appendToLast({ content: `回答失败：${e?.message || e}` })
      showToast(`智能问答失败：${e?.message || e}`, 'error')
    } finally {
      setAsking(false)
    }
  }

  const handleCodeSearch = async (override) => {
    const q = (override ?? codeQuery).trim()
    if (!q) return
    if (!indexReady) {
      showToast('请先在「项目中心 → 索引管理」中建立索引', 'error')
      return
    }
    if (override !== undefined) setCodeQuery(override)
    setSearching(true)
    setCodeResults(null)
    const results = await searchCodebase(currentProject.id, q)
    setCodeResults(results)
    setSearching(false)
  }

  return (
    <div className="fade-in">
      <ConfigScopeBanner />

      <div className="page-header">
        <h2>知识库</h2>
      </div>

      <div className="tabs">
        <div className={`tab-item ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}>
          智能问答
        </div>
        <div className={`tab-item ${activeTab === 'graph' ? 'active' : ''}`}
          onClick={() => setActiveTab('graph')}>
          代码图谱
        </div>
        <div className={`tab-item ${activeTab === 'code-search' ? 'active' : ''}`}
          onClick={() => setActiveTab('code-search')}>
          <Search size={12} style={{ verticalAlign: 'middle', marginRight: '2px' }} /> 代码搜索
        </div>
      </div>

      {activeTab === 'chat' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '20px', height: 'calc(100vh - 220px)' }}>
          {/* Chat Area */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
              {chatHistory.length === 0 && (
                <div style={{
                  height: '100%', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px'
                }}>
                  <BookOpen size={36} style={{ color: 'var(--fg-muted)', opacity: 0.3, marginBottom: '12px' }} />
                  <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
                    向项目知识库提问
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: 1.7 }}>
                    基于项目知识图谱与代码索引的 RAG 问答，
                    <br />使用前请先在「模型管理」中配置并启用模型
                  </div>
                </div>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} style={{
                  display: 'flex', gap: '12px', padding: '12px 0',
                  borderBottom: i < chatHistory.length - 1 ? '1px solid var(--border-subtle)' : 'none'
                }}>
                  <div style={{
                    width: '28px', height: '28px', borderRadius: '6px',
                    background: msg.role === 'user' ? 'var(--surface)' : 'color-mix(in srgb, var(--color-ai-review) 8%, var(--bg))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    {msg.role === 'user' ? (
                      <span style={{ fontSize: '12px', fontWeight: 510 }}>{currentUser.avatarInitial}</span>
                    ) : (
                      <BookOpen size={14} style={{ color: 'var(--color-ai-review)' }} />
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: '13px', fontWeight: 510, marginBottom: '6px',
                      color: msg.role === 'user' ? 'var(--fg)' : 'var(--color-ai-review)'
                    }}>
                      {msg.role === 'user' ? currentUser.name : 'FlowForge AI'}
                    </div>
                    <div style={{
                      fontSize: '13px', lineHeight: '1.7', color: 'var(--fg-secondary)',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {msg.content}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{
              display: 'flex', gap: '8px', padding: '12px 0 0',
              borderTop: '1px solid var(--border)'
            }}>
              <input
                className="input"
                placeholder="输入你的问题，例如：这个模块的依赖关系是什么？"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary" onClick={() => handleSend()} disabled={asking || !inputValue.trim()} aria-label="发送">
                {asking ? <Loader2 size={14} className="ff-spin" /> : <Send size={14} />}
              </button>
            </div>
          </div>

          {/* Quick Actions */}
          <div>
            <div className="card" style={{ marginBottom: '12px' }}>
              <h5 style={{ fontSize: '13px', marginBottom: '12px' }}>常见问题</h5>
              {[
                '项目整体架构是什么？',
                '核心模块的依赖关系图',
                '最近的代码变更影响范围',
                'API接口文档汇总',
                '数据库表结构说明',
              ].map((q, i) => (
                <div key={i}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setInputValue(q); showToast(`已填入问题：${q}`, 'info') } }}
                  style={{
                    padding: '8px 10px', borderRadius: '6px', cursor: 'pointer',
                    fontSize: '12px', color: 'var(--fg-secondary)',
                    border: '1px solid var(--border-subtle)', marginBottom: '6px',
                    transition: 'all 0.15s'
                  }}
                  onClick={() => {
                    setInputValue(q)
                    showToast(`已填入问题：${q}`, 'info')
                  }}
                >
                  {q}
                </div>
              ))}
            </div>
            <div className="card">
              <h5 style={{ fontSize: '13px', marginBottom: '12px' }}>索引统计</h5>
              {indexReady && indexStats ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: 'var(--fg-tertiary)' }}>仓库数</span>
                    <span style={{ fontWeight: 510, fontFamily: 'JetBrains Mono, monospace' }}>{indexStats.repoCount.toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: 'var(--fg-tertiary)' }}>文件数</span>
                    <span style={{ fontWeight: 510, fontFamily: 'JetBrains Mono, monospace' }}>{indexStats.totalFiles.toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: 'var(--fg-tertiary)' }}>代码块</span>
                    <span style={{ fontWeight: 510, fontFamily: 'JetBrains Mono, monospace' }}>{indexStats.totalChunks.toLocaleString()}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                    <span style={{ color: 'var(--fg-tertiary)' }}>最后索引</span>
                    <span style={{ fontWeight: 510 }}>{formatIndexTime(indexStats.lastIndexed)}</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: 1.7 }}>
                  尚未建立索引，请前往「项目中心 → 索引管理」建立
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'graph' && (
        <div>
          {/* Graph stats — sidecar 知识层（SQLite WAL + 向量检索） */}
          <div className="card" style={{ padding: '16px 20px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <GitBranch size={18} style={{ color: 'var(--color-ai-review)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 510 }}>「{currentProject.name}」知识图谱</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                {`sidecar 知识层 · 检索后端：${kgStats?.backend === 'vector' ? '向量' : 'BM25'}${kgStats ? ` · ${kgStats.chunks ?? 0} 个知识块` : ''}`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px' }}>
              {[
                { label: '实体', count: kgStats?.totalEntities ?? 0, color: 'var(--accent)' },
                { label: '关系', count: kgStats?.totalEdges ?? 0, color: 'var(--color-progress)' },
                { label: '追溯边', count: kgStats?.traceabilityEdges ?? 0, color: 'var(--color-success)' },
              ].map(item => (
                <div key={item.label} style={{ textAlign: 'center', padding: '4px 12px' }}>
                  <div style={{ fontSize: '18px', fontWeight: 590, color: item.color, fontFamily: 'JetBrains Mono, monospace' }}>{item.count}</div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)' }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Graph search */}
          <div className="card" style={{ padding: '16px 20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="input"
                placeholder="搜索图谱实体，例如：需求文档 / 架构设计"
                value={kgQuery}
                onChange={e => setKgQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleKgSearch() }}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary" onClick={handleKgSearch} disabled={kgSearching || !kgQuery.trim()}>
                {kgSearching ? <Loader2 size={14} className="ff-spin" /> : <Search size={14} />}
                {kgSearching ? '搜索中' : '搜索'}
              </button>
            </div>
          </div>

          {/* Search results */}
          {kgResults && (
            <div>
              <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginBottom: '12px' }}>
                命中 {kgResults.length} 个实体
              </div>
              {kgResults.map(r => (
                <div key={r.id} className="card" style={{ padding: '14px 20px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: r.snippet ? '8px' : 0 }}>
                    <span style={{
                      fontSize: '10px', padding: '1px 8px', borderRadius: '9999px', fontWeight: 510,
                      background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)'
                    }}>{r.type}</span>
                    <span style={{ fontSize: '13px', fontWeight: 510 }}>{r.label}</span>
                    {r.stageId && <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>阶段：{r.stageId}</span>}
                    <span style={{ fontSize: '11px', color: 'var(--fg-muted)', marginLeft: 'auto' }}>{r.relationCount} 条关系</span>
                  </div>
                  {r.snippet && (
                    <div style={{ fontSize: '12px', lineHeight: 1.6, color: 'var(--fg-secondary)', whiteSpace: 'pre-wrap' }}>
                      {r.snippet}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!kgResults && !kgSearching && (
            <div className="card" style={{ padding: '48px 24px', textAlign: 'center' }}>
              <FolderTree size={36} style={{ color: 'var(--fg-muted)', opacity: 0.3, marginBottom: '12px' }} />
              <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
                搜索知识图谱实体
              </div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                交付流程产生的需求、设计、代码、测试等交付物会自动注册到图谱中
              </div>
            </div>
          )}
        </div>
      )}


      {/* Codebase Search Tab */}
      {activeTab === 'code-search' && (
        <div>
          {/* Index Status Banner */}
          <div className="card" style={{ padding: '16px 20px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '36px', height: '36px', borderRadius: '10px',
              background: indexReady ? 'color-mix(in srgb, var(--color-success) 12%, var(--bg))' : 'color-mix(in srgb, var(--color-error) 12%, var(--bg))',
              color: indexReady ? 'var(--color-success)' : 'var(--color-error)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
            }}>
              {indexReady ? <Database size={18} /> : <Database size={18} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg)' }}>
                {indexReady ? '代码索引就绪' : '代码索引未建立'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                {indexReady && indexStats
                  ? `已索引 ${indexStats.repoCount} 个仓库，共 ${indexStats.totalFiles} 个文件，${indexStats.totalChunks} 个代码块 · 语言：${indexStats.languages.join(', ')}`
                  : '请前往「项目中心 → 索引管理」建立索引后使用代码搜索'
                }
              </div>
            </div>
          </div>

          {/* Search Input */}
          <div className="card" style={{ padding: '16px 20px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="input"
                placeholder="搜索代码，例如：getUserById 的实现"
                value={codeQuery}
                onChange={e => setCodeQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCodeSearch() }}
                style={{ flex: 1 }}
                disabled={!indexReady}
              />
              <button
                className="btn btn-primary"
                onClick={handleCodeSearch}
                disabled={searching || !codeQuery.trim() || !indexReady}
              >
                {searching ? <Loader2 size={14} className="ff-spin" /> : <Search size={14} />}
                {searching ? '搜索中' : '搜索'}
              </button>
            </div>
          </div>

          {/* Search Results */}
          {codeResults && (
            <div>
              <div style={{ fontSize: '13px', color: 'var(--fg-tertiary)', marginBottom: '12px' }}>
                {codeResults.message}
              </div>
              {codeResults.results.map((result, i) => (
                <div key={i} className="card" style={{ padding: '16px 20px', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <FileCode size={14} style={{ color: 'var(--color-ai-review)' }} />
                    <code style={{ fontSize: '12px', fontWeight: 510, color: 'var(--fg)' }}>{result.file}</code>
                    <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>:{result.line}</span>
                    {/* 双引擎来源标注（t3：fts-vector = 引擎A，graph = 引擎B） */}
                    {(result.sources || []).map(src => (
                      <span key={src} style={{
                        fontSize: '10px', padding: '1px 6px', borderRadius: '9999px', fontWeight: 510,
                        background: src === 'graph'
                          ? 'color-mix(in srgb, var(--color-ai-review) 10%, transparent)'
                          : 'color-mix(in srgb, var(--color-progress) 10%, transparent)',
                        color: src === 'graph' ? 'var(--color-ai-review)' : 'var(--color-progress)'
                      }}>
                        {src === 'graph' ? '图谱' : 'FTS/向量'}
                      </span>
                    ))}
                    {result.trace && (
                      <span style={{ fontSize: '10px', color: 'var(--fg-muted)' }}>{result.trace}</span>
                    )}
                    <span style={{
                      fontSize: '10px', padding: '1px 6px', borderRadius: '9999px',
                      background: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
                      color: 'var(--color-success)', fontWeight: 510, marginLeft: 'auto'
                    }}>
                      相关度 {Math.round(result.relevance * 100)}%
                    </span>
                  </div>
                  <pre style={{
                    fontSize: '12px', lineHeight: 1.6, color: 'var(--fg-secondary)',
                    background: 'var(--surface)', padding: '12px', borderRadius: '8px',
                    overflowX: 'auto', fontFamily: 'JetBrains Mono, monospace', margin: 0
                  }}>
                    {result.snippet}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {/* Empty State */}
          {!codeResults && !searching && indexReady && (
            <div className="card" style={{ padding: '48px 24px', textAlign: 'center' }}>
              <Code2 size={36} style={{ color: 'var(--fg-muted)', opacity: 0.3, marginBottom: '12px' }} />
              <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
                输入关键词搜索代码
              </div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                基于双引擎代码索引（FTS/向量 + 图谱结构）的 RRF 融合检索，支持函数名、文件路径、代码片段搜索；
                也可在「代码图谱」Tab 中查看调用关系与跨服务依赖
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
