/**
 * DelegatePanel — three execution modes for a pipeline stage (Phase 4)
 *
 *   builtin  内置 AI   → existing LangGraph run (handled by the parent)
 *   delegate 外派      → context package → written to {repo}/.flowforge/delegate-context.md
 *                        + local AI client (Qoder/Trae/Cursor) opened with the file
 *                        → produce in the tool → watch recycle dir or multi-file import
 *                        → preview → confirm import
 *   manual   手动导入   → paste text / pick a file → import
 *
 * Imported deliverables resume the graph via graph.continue (the stage node
 * registers them with DERIVED_FROM traceability); without a live thread the
 * panel calls knowledge.register directly and saves to the local store.
 *
 * Tauri-only: web mode renders a hint (external dispatch needs the desktop shell).
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  Send, Bot, Clipboard, FileUp, Loader2, CheckCircle2, XCircle,
  ExternalLink, FolderOpen, Eye, X,
} from 'lucide-react'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { getRepositories } from '@/services/repository'

const TARGET_TOOLS = [
  { id: 'qoder', label: 'Qoder' },
  { id: 'trae', label: 'Trae' },
  { id: 'cursor', label: 'Cursor' },
]

const MODES = [
  { id: 'builtin', label: '内置 AI', icon: Bot },
  { id: 'delegate', label: '外派', icon: ExternalLink },
  { id: 'manual', label: '手动导入', icon: FileUp },
]

export default function DelegatePanel({
  available,               // tauri + sidecar ready
  sidecar,                 // useSidecar() value ({ invoke })
  graphRt,                 // createGraphRuntime facade
  graphExec,               // { threadId, status, ... } | null
  project, delivery, stage,
  upstreamDeliverables,    // { [stageId]: { content } } — completed stages
  mcpServers, allowedTools,
  modelConfig, dag,
  onStartBuiltin,          // () => void — existing graph advance
  onImported,              // (content, meta) => void — local store save
  showToast,
}) {
  const [mode, setMode] = useState('builtin')
  const [target, setTarget] = useState('qoder')
  const [busy, setBusy] = useState(false)
  // { delegationId, watchDir, status: 'waiting'|'received'|'timeout', files }
  const [delegation, setDelegation] = useState(null)
  const [preview, setPreview] = useState(null)   // { content, name }
  const [manualText, setManualText] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const manualFileRef = useRef(null)
  const delegationRef = useRef(null)
  delegationRef.current = delegation

  // recycle events from the Rust watcher
  useEffect(() => {
    if (!available) return undefined
    const offs = []
    tauriListen('delegate://received', (event) => {
      const p = event.payload || {}
      if (p.delegationId !== delegationRef.current?.delegationId) return
      const files = Array.isArray(p.files) ? p.files : []
      setDelegation(prev => (prev ? { ...prev, status: 'received', files } : prev))
      const first = files.find(f => typeof f.content === 'string') || files[0]
      if (first) setPreview({ content: first.content || '', name: first.name })
      showToast('外派产出已回收，请预览确认', 'success')
    }).then(un => offs.push(un)).catch(() => {})
    tauriListen('delegate://timeout', (event) => {
      if (event.payload?.delegationId !== delegationRef.current?.delegationId) return
      setDelegation(prev => (prev ? { ...prev, status: 'timeout' } : prev))
      showToast('外派回收超时，监听已停止', 'info')
    }).then(un => offs.push(un)).catch(() => {})
    return () => offs.forEach(un => { try { un() } catch { /* noop */ } })
  }, [available, showToast])

  if (!available) {
    return (
      <div style={{ padding: '8px 12px', borderRadius: '8px', background: 'var(--bg-secondary)', fontSize: '12px', color: 'var(--fg-tertiary)' }}>
        <ExternalLink size={12} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
        外派与 MCP 工具执行需要桌面版（Tauri）——当前为 Web 模式
      </div>
    )
  }

  const stageId = stage?.id

  // ensure a delegate/manual-mode thread exists (interrupts awaiting injection)
  const ensureThread = async (execMode) => {
    if (graphExec?.threadId && (graphExec.status === 'interrupted' || graphExec.status === 'running')) {
      return graphExec.threadId
    }
    const res = await graphRt.startDelivery({
      projectId: project.id,
      deliveryId: delivery.id,
      projectName: project.name,
      requirement: delivery.description || delivery.title,
      dag,
      executionMode: execMode,
      modelConfig: modelConfig || { endpoint: 'http://127.0.0.1:1', apiKey: '', modelId: 'external' },
      mcpServers,
      allowedTools,
    })
    return res?.threadId
  }

  // ─── delegate: dispatch (context → 写入项目 + 打开本地 AI 客户端，then watch) ───
  const handleDispatch = async () => {
    const repoPath = getRepositories(project.id).find(r => r.path)?.path || null
    if (!repoPath) {
      showToast('项目未配置本地仓库路径，无法外派，请先在项目中心添加仓库', 'error')
      return
    }
    setBusy(true)
    try {
      // structured context package assembled by the sidecar context engine
      const pack = await sidecar.invoke('context.build_package', {
        projectId: project.id,
        deliveryId: delivery.id,
        stageId,
        projectName: project.name,
        requirement: delivery.description || delivery.title,
        deliverables: upstreamDeliverables,
        repoPath,
      })
      const context = pack?.markdown
        || `# 上下文包\n\n（内容过大，已落盘：${pack?.filePath || '未知路径'}）`

      await ensureThread('delegate')

      // Rust 侧将上下文写入 {repo}/.flowforge/delegate-context.md 并打开工具
      const res = await tauriInvoke('delegate_dispatch', {
        payload: { context, toolId: target, repoPath },
      })
      setDelegation({ delegationId: res.delegationId, watchDir: res.watchDir, status: 'waiting', files: [] })
      setPreview(null)
      const toolLabel = TARGET_TOOLS.find(t => t.id === target)?.label || target
      showToast(`已打开 ${toolLabel} 并带入上下文，产出后请导入交付物或放入回收目录`, 'success')
      // harness：代码智能降级时不阻断外派，但提示用户可提升上下文质量
      if (typeof pack?.markdown === 'string' && pack.markdown.includes('> 说明：')) {
        showToast('本次代码索引未命中或引擎不可用（已在上下文中降级标注），可在项目配置中完成代码索引提升质量', 'info')
      }
    } catch (e) {
      showToast(`外派失败：${e?.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  // ─── 多文件导入交付物：在其它工具产出后选择多个文件导入 ───
  const handleImportFiles = async () => {
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: '选择交付物文件',
        filters: [
          { name: '文档', extensions: ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'ts', 'js', 'tsx', 'jsx', 'py', 'java', 'go', 'rs'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return

      const files = await Promise.all(
        paths.map(async p => ({
          name: p.split('/').pop(),
          path: p,
          content: await readTextFile(p),
        }))
      )
      const failed = files.filter(f => typeof f.content !== 'string')
      if (failed.length > 0) {
        showToast(`以下文件无法读取为文本：${failed.map(f => f.name).join('、')}`, 'error')
        return
      }
      const combined = files.length === 1
        ? files[0].content
        : files.map(f => `## 文件: ${f.name}\n\n${f.content}`).join('\n\n---\n\n')
      await importContent(combined, 'delegate-import')
    } catch (e) {
      showToast(`导入交付物失败：${e?.message || e}`, 'error')
    }
  }

  const handleCancelDelegation = async () => {
    if (!delegation) return
    try {
      await tauriInvoke('delegate_cancel', { delegationId: delegation.delegationId })
    } catch { /* watcher may have already stopped */ }
    setDelegation(null)
    setPreview(null)
    showToast('已取消本次外派回收', 'info')
  }

  // ─── shared import: graph.continue injection + traceability ───
  const waitForInterrupt = async (threadId, tries = 10) => {
    for (let i = 0; i < tries; i += 1) {
      try {
        const st = await graphRt.getState(threadId)
        if (st && (st.interrupts?.length || st.next?.length || st.status === 'interrupted')) return true
      } catch { /* keep polling */ }
      await new Promise(r => setTimeout(r, 300))
    }
    return false
  }

  const importContent = async (content, source) => {
    if (!content || !content.trim()) {
      showToast('产出内容为空，无法导入', 'error')
      return
    }
    setBusy(true)
    try {
      // prefer the interrupt/resume path: an already-parked thread, or a
      // freshly started delegate/manual thread once its interrupt is set
      let threadId = graphExec?.status === 'interrupted' ? graphExec.threadId : null
      if (!threadId) {
        try {
          const tid = await ensureThread(source)
          if (tid && await waitForInterrupt(tid)) threadId = tid
        } catch { /* fall back to direct register */ }
      }
      let injected = false
      if (threadId) {
        // resume the parked stage node — it registers the deliverable and
        // builds the DERIVED_FROM chain via the knowledge layer
        await graphRt.continueDelivery(threadId, { content, source })
        injected = true
      } else {
        // no live thread: register traceability directly
        try {
          await sidecar.invoke('knowledge.register', {
            projectId: project.id,
            deliveryId: delivery.id,
            stage: stageId,
            content,
            source,
          })
        } catch { /* knowledge layer optional — local save still proceeds */ }
      }
      onImported?.(content, { source, injected })
      setDelegation(null)
      setPreview(null)
      setManualText('')
      showToast(injected ? '产出已注入执行引擎（断点恢复）' : '产出已导入并登记追溯', 'success')
    } catch (e) {
      showToast(`导入失败：${e?.message || e}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const handleManualFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setManualText(String(ev.target.result || ''))
    reader.readAsText(file)
    e.target.value = ''
  }

  // HTML5 drag-drop 导入（tauri.conf.json 已关 dragDropEnabled，WebView 内可直接收到 drop）
  const readDroppedFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setManualText(String(ev.target.result || ''))
    reader.onerror = () => showToast('读取拖入文件失败', 'error')
    reader.readAsText(file)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) {
      readDroppedFile(file)
      showToast(`已读入文件「${file.name}」`, 'success')
      return
    }
    // plain-text drag (e.g. selected text from another window)
    const text = e.dataTransfer?.getData('text/plain')
    if (text) setManualText(text)
  }

  const btnSm = { fontSize: '12px', padding: '4px 10px' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-secondary)', fontSize: '12px' }}>
      {/* mode switch */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ color: 'var(--fg-tertiary)' }}>执行方式：</span>
        {MODES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={mode === id ? 'btn btn-primary' : 'btn btn-secondary'}
            style={btnSm}
            onClick={() => setMode(id)}
          >
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      {/* builtin */}
      {mode === 'builtin' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--fg-secondary)' }}>
          <span style={{ flex: 1 }}>由内置 AI（LangGraph + MCP 工具）生成本阶段交付物</span>
          <button className="btn btn-secondary" style={btnSm} onClick={onStartBuiltin} disabled={busy || graphExec?.status === 'running'}>
            <Bot size={12} /> 启动内置执行
          </button>
        </div>
      )}

      {/* delegate */}
      {mode === 'delegate' && !delegation && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--fg-tertiary)' }}>外派工具：</span>
          <select className="select" value={target} onChange={e => setTarget(e.target.value)} style={{ width: 'auto', fontSize: '12px', padding: '4px 6px' }}>
            {TARGET_TOOLS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <button className="btn btn-primary" style={btnSm} onClick={handleDispatch} disabled={busy}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 派发
          </button>
          <button className="btn btn-secondary" style={btnSm} onClick={handleImportFiles} disabled={busy}>
            <FileUp size={12} /> 导入交付物
          </button>
          <span style={{ color: 'var(--fg-muted)', fontSize: '11px' }}>将打开所选 AI 客户端并带入上下文；产出可多文件导入或放入回收目录自动回收</span>
        </div>
      )}

      {mode === 'delegate' && delegation && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {delegation.status === 'waiting' && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--color-progress)' }} />}
            {delegation.status === 'received' && <CheckCircle2 size={13} style={{ color: 'var(--color-success)' }} />}
            {delegation.status === 'timeout' && <XCircle size={13} style={{ color: 'var(--color-error)' }} />}
            <span style={{ color: 'var(--fg-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {delegation.status === 'waiting' && '等待回收 · 请将产出文件保存到：'}
              {delegation.status === 'received' && `已回收 ${delegation.files.length} 个文件`}
              {delegation.status === 'timeout' && '回收超时（30 分钟），可重新派发'}
            </span>
            <button className="btn btn-ghost" style={btnSm} onClick={handleCancelDelegation}>
              <X size={12} /> 取消
            </button>
          </div>
          <code
            style={{ fontSize: '11px', color: 'var(--fg-tertiary)', wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: '4px' }}
            title={delegation.watchDir}
          >
            <FolderOpen size={11} style={{ flexShrink: 0 }} /> {delegation.watchDir}
          </code>
          {delegation.status === 'received' && preview && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--fg-tertiary)' }}>
                <Eye size={12} /> 产出预览（{preview.name}）
              </div>
              <pre style={{ maxHeight: '140px', overflow: 'auto', margin: 0, padding: '8px', borderRadius: '6px', background: 'var(--bg)', fontSize: '11px', whiteSpace: 'pre-wrap' }}>
                {(preview.content || '').slice(0, 4000) || '（文件不可预览，仍可导入原文件内容）'}
              </pre>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
                <button className="btn btn-primary" style={btnSm} onClick={() => importContent(preview.content, 'delegate')} disabled={busy}>
                  <CheckCircle2 size={12} /> 确认导入
                </button>
              </div>
            </div>
          )}
          {delegation.status === 'waiting' && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" style={btnSm} onClick={handleImportFiles} disabled={busy}>
                <FileUp size={12} /> 导入交付物
              </button>
            </div>
          )}
        </div>
      )}

      {/* manual */}
      {mode === 'manual' && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
          onDrop={handleDrop}
          data-testid="manual-drop-zone"
        >
          <textarea
            className="input"
            rows={4}
            placeholder="粘贴外部工具的产出内容（Markdown）…也可直接拖入文本文件"
            value={manualText}
            onChange={e => setManualText(e.target.value)}
            style={{
              fontSize: '12px', fontFamily: 'JetBrains Mono, monospace',
              outline: dragOver ? '2px dashed var(--color-progress)' : 'none', outlineOffset: '-2px',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button className="btn btn-secondary" style={btnSm} onClick={() => manualFileRef.current?.click()}>
              <FileUp size={12} /> 选择文件
            </button>
            <input ref={manualFileRef} type="file" accept=".md,.markdown,.txt,text/*" onChange={handleManualFile} style={{ display: 'none' }} />
            <span style={{ flex: 1 }} />
            <button
              className="btn btn-primary"
              style={btnSm}
              onClick={() => importContent(manualText, 'manual')}
              disabled={busy || !manualText.trim()}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Clipboard size={12} />} 导入产出
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
