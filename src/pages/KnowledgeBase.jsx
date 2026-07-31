import React, { useState, useEffect } from 'react'
import {
  Send, BookOpen, RefreshCw,
  GitBranch, FolderTree, ChevronDown, Search, Code2, Database, FileCode, Loader2,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { useSidecar } from '@/context/SidecarContext'
import ConfigScopeBanner from '@/components/ConfigScopeBanner'
import {
  getIndexes, hasProjectIndex, getProjectIndexStats, searchCodebase,
  isTauriCodeIndex, getCodeIndexStats, rebuildCodeIndex,
  watchCodeIndex, unwatchCodeIndex, onCodeIndexUpdated,
} from '@/services/codebaseIndex'
import { getRepositories } from '@/services/repository'
import { searchGraph as searchGraphLocal, getGraphStats as getGraphStatsLocal } from '@/services/graph'

// ISO 时间 → 本地可读时间；无索引时显示「未索引」
function formatIndexTime(iso) {
  if (!iso) return '未索引'
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '未索引' }
}

const WEB_INDEX_STATUS_META = {
  ready: { label: '已索引', badge: 'status-complete' },
  indexing: { label: '索引中', badge: 'status-progress' },
  error: { label: '索引失败', badge: 'status-pending' },
  none: { label: '未索引', badge: 'status-pending' },
}

export default function KnowledgeBase() {
  const [inputValue, setInputValue] = useState('')
  const [activeTab, setActiveTab] = useState('chat')
  const { currentProject, currentUser, showToast } = useApp()
  const { mode: sidecarMode, isReady: sidecarReady, invoke: sidecarInvoke } = useSidecar()

  // 智能问答对话记录 — 尚未接入真实问答能力，初始为空（空态引导），
  // 不再展示任何演示性预置问答
  const [chatHistory] = useState([])

  // Knowledge graph state — tauri mode reads the sidecar knowledge layer,
  // web mode keeps the localStorage-backed graph.js behavior
  const [kgQuery, setKgQuery] = useState('')
  const [kgResults, setKgResults] = useState(null)
  const [kgSearching, setKgSearching] = useState(false)
  const [kgStats, setKgStats] = useState(null)
  const useSidecarKnowledge = sidecarMode === 'tauri' && sidecarReady

  // Codebase search state
  const [codeQuery, setCodeQuery] = useState('')
  const [codeResults, setCodeResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [indexStats, setIndexStats] = useState(null)
  const [indexReady, setIndexReady] = useState(false)
  const [projectIndexes, setProjectIndexes] = useState([]) // real per-repo index records

  // Real code-index management state (tauri mode only)
  const useTauriIndex = isTauriCodeIndex()
  const [repoIndexRows, setRepoIndexRows] = useState([]) // [{repo, stats}]
  const [rebuilding, setRebuilding] = useState(false)
  const [watched, setWatched] = useState({}) // repoPath -> bool
  const [idxRefreshTick, setIdxRefreshTick] = useState(0)

  useEffect(() => {
    if (!useTauriIndex || activeTab !== 'index' || !currentProject) return undefined
    let cancelled = false
    const load = async () => {
      const repos = getRepositories(currentProject.id).filter(r => r.path)
      const rows = await Promise.all(repos.map(async (repo) => {
        try {
          return { repo, stats: await getCodeIndexStats(repo.path) }
        } catch {
          return { repo, stats: null }
        }
      }))
      if (!cancelled) setRepoIndexRows(rows)
    }
    load()
    // auto-incremental reindex (commit watcher) → refresh the stats
    const off = onCodeIndexUpdated(() => setIdxRefreshTick(t => t + 1))
    return () => { cancelled = true; off() }
  }, [useTauriIndex, activeTab, currentProject, idxRefreshTick])

  const handleRebuildIndex = async () => {
    const repos = repoIndexRows.map(r => r.repo)
    if (repos.length === 0) {
      showToast('请先在「项目配置」中添加含本地路径的仓库', 'error')
      return
    }
    setRebuilding(true)
    try {
      for (const repo of repos) {
        const summary = await rebuildCodeIndex(repo.path)
        showToast(`${repo.name}：${summary.files} 文件 / ${summary.symbols} 符号 · ${summary.durationMs}ms`, 'success')
      }
      setIdxRefreshTick(t => t + 1)
    } catch (e) {
      showToast(`重建索引失败：${e?.message || e}`, 'error')
    }
    setRebuilding(false)
  }

  // CommandPalette 快捷动作「重建索引」→ 切到索引页签并触发重建
  useEffect(() => {
    const onRebuild = () => {
      if (!useTauriIndex) return
      setActiveTab('index')
      handleRebuildIndex()
    }
    window.addEventListener('flowforge:rebuild-index', onRebuild)
    return () => window.removeEventListener('flowforge:rebuild-index', onRebuild)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useTauriIndex, repoIndexRows])

  const handleToggleWatch = async (repoPath) => {
    try {
      if (watched[repoPath]) {
        await unwatchCodeIndex(repoPath)
        setWatched(w => ({ ...w, [repoPath]: false }))
        showToast('已停止增量监听', 'info')
      } else {
        await watchCodeIndex(repoPath)
        setWatched(w => ({ ...w, [repoPath]: true }))
        showToast('已开启 commit 监听，变更后自动增量索引', 'success')
      }
    } catch (e) {
      showToast(`监听切换失败：${e?.message || e}`, 'error')
    }
  }

  useEffect(() => {
    if (currentProject) {
      setIndexReady(hasProjectIndex(currentProject.id))
      setIndexStats(getProjectIndexStats(currentProject.id))
      setProjectIndexes(getIndexes(currentProject.id))
    }
  }, [currentProject, activeTab])

  useEffect(() => {
    if (!currentProject || activeTab !== 'graph') return undefined
    let cancelled = false
    const load = async () => {
      try {
        const stats = useSidecarKnowledge
          ? await sidecarInvoke('knowledge.stats', { projectId: currentProject.id })
          : getGraphStatsLocal(currentProject.id)
        if (!cancelled) setKgStats(stats)
      } catch {
        if (!cancelled) setKgStats(null) // knowledge layer unavailable — show placeholder
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentProject, activeTab, useSidecarKnowledge, sidecarInvoke])

  const handleKgSearch = async () => {
    if (!kgQuery.trim() || !currentProject) return
    setKgSearching(true)
    setKgResults(null)
    try {
      if (useSidecarKnowledge) {
        const res = await sidecarInvoke('knowledge.search', { projectId: currentProject.id, query: kgQuery })
        setKgResults((res?.results ?? []).map(r => ({
          id: r.entityId, label: r.label, type: r.type, stageId: r.stageId,
          snippet: r.snippet, relationCount: r.relationCount, score: r.score,
        })))
      } else {
        const res = searchGraphLocal(kgQuery, currentProject.id)
        setKgResults(res.map(r => ({
          id: r.entity.id, label: r.entity.label, type: r.entity.concept, stageId: r.entity.stage,
          snippet: String(r.entity.properties?.content ?? '').slice(0, 300),
          relationCount: r.relationCount, score: null,
        })))
      }
    } catch (e) {
      showToast(`图谱搜索失败：${e?.message || e}`, 'error')
      setKgResults([])
    }
    setKgSearching(false)
  }

  const handleSend = () => {
    if (inputValue.trim()) {
      // 诚实提示：智能问答尚未接入真实模型，不伪造回答
      showToast('智能问答能力建设中，请先使用「代码图谱」与「代码搜索」检索项目知识', 'info')
      setInputValue('')
    }
  }

  const handleCodeSearch = async () => {
    if (!codeQuery.trim()) return
    if (!indexReady) {
      showToast('请先在「项目配置 → 代码索引」中建立索引', 'error')
      return
    }
    setSearching(true)
    setCodeResults(null)
    const results = await searchCodebase(currentProject.id, codeQuery)
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
        <div className={`tab-item ${activeTab === 'index' ? 'active' : ''}`}
          onClick={() => setActiveTab('index')}>
          索引管理
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
                    智能问答能力建设中，可先使用「代码图谱」与「代码搜索」检索项目知识，
                    <br />或从右侧常见问题快速开始
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
              <button className="btn btn-primary" onClick={handleSend} aria-label="发送">
                <Send size={14} />
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
                  尚未建立索引，请前往「项目配置 → 代码索引」建立
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'graph' && (
        <div>
          {/* Graph stats — real data from sidecar (tauri) or graph.js (web) */}
          <div className="card" style={{ padding: '16px 20px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <GitBranch size={18} style={{ color: 'var(--color-ai-review)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 510 }}>「{currentProject.name}」知识图谱</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>
                {useSidecarKnowledge
                  ? `sidecar 知识层 · 检索后端：${kgStats?.backend === 'vector' ? '向量' : 'BM25'}${kgStats ? ` · ${kgStats.chunks ?? 0} 个知识块` : ''}`
                  : '浏览器本地图谱（localStorage）'}
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

      {activeTab === 'index' && useTauriIndex && (
        <div className="card">
          <div className="card-header">
            <h4 className="card-title">索引管理（tree-sitter 真实索引）</h4>
            <button className="btn btn-secondary" onClick={handleRebuildIndex} disabled={rebuilding}>
              {rebuilding ? <Loader2 size={14} className="ff-spin" /> : <RefreshCw size={14} />}
              {rebuilding ? '索引中…' : '重建索引'}
            </button>
          </div>
          {repoIndexRows.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', fontSize: '13px', color: 'var(--fg-tertiary)' }}>
              当前项目没有配置本地路径仓库，请先在「项目配置 → 代码仓库」添加
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>仓库</th>
                  <th>文件数</th>
                  <th>符号数</th>
                  <th>关系数</th>
                  <th>语言</th>
                  <th>最近索引</th>
                  <th>增量监听</th>
                </tr>
              </thead>
              <tbody>
                {repoIndexRows.map(({ repo, stats }) => (
                  <tr key={repo.id}>
                    <td style={{ fontWeight: 510, fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{repo.name}</td>
                    <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{stats?.exists ? stats.files : '—'}</td>
                    <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{stats?.exists ? stats.symbols : '—'}</td>
                    <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{stats?.exists ? stats.relations : '—'}</td>
                    <td style={{ fontSize: '12px' }}>{stats?.exists ? (stats.languages ?? []).join(', ') : '—'}</td>
                    <td style={{ fontSize: '12px' }}>
                      {stats?.lastIndexedAt ? new Date(stats.lastIndexedAt).toLocaleString() : '未索引'}
                    </td>
                    <td>
                      <button
                        className={`btn ${watched[repo.path] ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '2px 10px', fontSize: '12px' }}
                        onClick={() => handleToggleWatch(repo.path)}
                      >
                        {watched[repo.path] ? '监听中' : '开启'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'index' && !useTauriIndex && (
        <div className="card">
          <div className="card-header">
            <h4 className="card-title">索引管理</h4>
            <button className="btn btn-secondary" onClick={() => showToast('浏览器模式请前往「项目配置 → 代码索引」重建索引', 'info')}>
              <RefreshCw size={14} /> 重新索引
            </button>
          </div>
          {projectIndexes.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', fontSize: '13px', color: 'var(--fg-tertiary)' }}>
              尚未建立索引，请前往「项目配置 → 代码索引」为仓库建立索引
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
                <div className="kpi-card">
                  <div className="kpi-label">索引状态</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`status-badge ${projectIndexes.every(i => i.status === 'ready') ? 'status-complete' : 'status-progress'}`}>
                      <span className="status-dot"></span>
                      {projectIndexes.every(i => i.status === 'ready')
                        ? '全部就绪'
                        : `${projectIndexes.filter(i => i.status === 'ready').length}/${projectIndexes.length} 就绪`}
                    </span>
                  </div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">索引范围</div>
                  <div style={{ fontSize: '14px', fontWeight: 510 }}>{projectIndexes.length} 个仓库</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">最后索引</div>
                  <div style={{ fontSize: '14px', fontWeight: 510, fontFamily: 'JetBrains Mono, monospace' }}>
                    {formatIndexTime(indexStats?.lastIndexed)}
                  </div>
                </div>
              </div>
              <h5 style={{ marginBottom: '12px' }}>仓库索引详情</h5>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>仓库</th>
                    <th>文件数</th>
                    <th>代码块</th>
                    <th>最后索引</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {projectIndexes.map((idx) => {
                    const meta = WEB_INDEX_STATUS_META[idx.status] || WEB_INDEX_STATUS_META.none
                    return (
                      <tr key={idx.id}>
                        <td style={{ fontWeight: 510, fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{idx.repoName}</td>
                        <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{idx.fileCount}</td>
                        <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{idx.chunks}</td>
                        <td style={{ fontSize: '12px' }}>{formatIndexTime(idx.lastIndexed)}</td>
                        <td>
                          <span className={`status-badge ${meta.badge}`}>
                            <span className="status-dot"></span>
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
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
                  : '请前往「项目配置 → 代码索引」建立索引后使用代码搜索'
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
                基于已建立的代码索引，支持函数名、文件路径、代码片段搜索
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
