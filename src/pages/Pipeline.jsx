import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  FileText, FileCheck, ClipboardList, Code2, GitMerge,
  TestTube2, Rocket, Loader2,
  Eye, Bot, ChevronRight, Send, X,
  ExternalLink, Check, MessageSquare,
  Download, Copy, Settings, Sparkles, Target,
  ListChecks, FileCode, Plug, Shield, Zap,
  Trash2, Plus, User, CheckCircle2, XCircle,
  Link2, GitFork, ArrowDown, CircleDot, Pencil, Archive,
  Upload, FolderOpen, FileUp, Clipboard, AlertCircle,
  LayoutTemplate,
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { useSidecar } from '@/context/SidecarContext'
import { getRepositories, createBranch, pushBranch, buildFeatureBranchName, supportsGitOps } from '@/services/repository'
import { getIndexes } from '@/services/codebaseIndex'
import { createGraphRuntime } from '@/services/graphRuntime'
import { getProjectDAG } from '@/data/flowEngine'
import AiChatPanel from '@/components/AiChatPanel'
import DelegatePanel from '@/components/DelegatePanel'
import { collectAgentMcpServers, collectAllowedTools, findStageAgent } from '@/services/mcpConfig'
import { generateDeliverable, chatWithStage, aiReview as aiReviewService, hasAPIKey, getCustomModels, getActiveModel } from '@/services/ai'
import { getStageDefinition } from '@/data/stages'
import { Toggle } from '@/components/ui/Toggle'
import { getUpstreamContext, getTraceabilityChain, registerDeliverable, registerReview, evaluateChainRules } from '@/services/knowledge'
import { generatePrototype, savePrototype, loadPrototype, getPrototypePath } from '@/services/prototype'

// ─── Priority color mapping (P0 red / P1 orange / P2 blue) ───
const priorityColors = {
  P0: 'var(--color-error)',
  P1: 'var(--color-human-review)',
  P2: 'var(--color-progress)',
  P3: 'var(--fg-muted)',
}

const iconMap = {
  FileText, FileCheck, ClipboardList, Code2, GitMerge,
  TestTube2, Rocket, Eye,
}

function getStageIcon(iconName) {
  return iconMap[iconName] || FileText
}

export default function Pipeline() {
  const [isGenerating, setIsGenerating] = useState(false)
  const [isReviewing, setIsReviewing] = useState(false)
  const [generatingProgress, setGeneratingProgress] = useState('')
  const [viewDeliverable, setViewDeliverable] = useState(null)
  const [detailTab, setDetailTab] = useState('current')
  const [traceabilityData, setTraceabilityData] = useState(null)
  const [editContent, setEditContent] = useState('')
  const [chatOpen, setChatOpen] = useState(false)
  // Tracks the inline "add user override" form: { type, name, desc }
  const [addOverride, setAddOverride] = useState({ type: null, name: '', desc: '' })

  // ─── Interactive chat state (per-stage conversation before generation) ───
  const [stageChat, setStageChat] = useState([])  // [{ role: 'user'|'assistant', content }]
  const [chatInput, setChatInput] = useState('')
  const [isChatting, setIsChatting] = useState(false)
  const [showChat, setShowChat] = useState(false)

  // ─── Import deliverable state ───
  const [showImportModal, setShowImportModal] = useState(false)
  const [importMode, setImportMode] = useState('file')  // 'file' | 'paste' | 'path'
  const [importText, setImportText] = useState('')
  const [importPath, setImportPath] = useState('')
  const importFileRef = useRef(null)

  // New delivery dialog state
  const [showCreateDelivery, setShowCreateDelivery] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newPriority, setNewPriority] = useState('P1')
  const [newAssignee, setNewAssignee] = useState('')
  // Edit mode reuses the create dialog; null = creating, id = editing that delivery
  const [editingDeliveryId, setEditingDeliveryId] = useState(null)
  // Show archived deliveries in the left list
  const [showArchived, setShowArchived] = useState(false)

  const {
    currentProject, showToast, currentUser,
    deliveries, stageNames, agents, createDelivery,
    updateDelivery, deleteDelivery, archiveDelivery,
    stageDeliverables, saveStageDeliverable, saveStageReview,
    getStageConfig, toggleStageConfigItem, updateStageConfig,
    getEffectiveStageConfig, addDeliveryStageOverride,
    removeDeliveryStageOverride, setDeliveryStageModel, setDeliveryStagePrompt,
    getProjectStageList, getFlowConfig,
    getFlowNode, getStageGate,
  } = useApp()

  // ─── Dynamic stage list based on project's custom flow ───
  const projectStages = getProjectStageList(currentProject)
  const flowConfig = getFlowConfig(currentProject)
  const totalStages = projectStages.length

  const projectDeliveries = deliveries
    .filter(d => d.projectId === currentProject.id)
    .filter(d => showArchived || !d.archived)
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(
    projectDeliveries.length > 0 ? projectDeliveries[0].id : ''
  )
  const selectedDelivery = projectDeliveries.find(d => d.id === selectedDeliveryId) || null

  // Default to current stage of selected delivery
  const [activeStageIndex, setActiveStageIndex] = useState(
    selectedDelivery ? selectedDelivery.currentStageIndex : 0
  )

  // Reset selection when project changes
  useEffect(() => {
    const list = deliveries.filter(d => d.projectId === currentProject.id && !d.archived)
    if (list.length > 0) {
      setSelectedDeliveryId(list[0].id)
    } else {
      setSelectedDeliveryId('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject.id])

  // Update active stage when delivery changes
  useEffect(() => {
    if (selectedDelivery) {
      setActiveStageIndex(selectedDelivery.currentStageIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeliveryId])

  // Sync editable content when stage / delivery changes
  const activeStage = projectStages[activeStageIndex] || projectStages[0]
  const activeDeliverableData = useMemo(() => {
    if (!selectedDelivery) return null
    const deliveryData = stageDeliverables[selectedDelivery.id]
    return deliveryData?.[activeStage?.id] || null
  }, [selectedDelivery, activeStage, stageDeliverables])

  useEffect(() => {
    setEditContent(activeDeliverableData?.content || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStage?.id, selectedDeliveryId])

  // ─── HTML 原型（PRD 阶段，t5） ───
  const [prototypeBusy, setPrototypeBusy] = useState(false)
  const [prototypeReady, setPrototypeReady] = useState(false)
  const [prototypePreview, setPrototypePreview] = useState(null)

  // 切换需求时探测本地是否已有原型文件（支持重新生成覆盖）
  useEffect(() => {
    let cancelled = false
    setPrototypeReady(false)
    setPrototypePreview(null)
    if (selectedDelivery && currentProject) {
      loadPrototype(currentProject.id, selectedDelivery.id).then(html => {
        if (!cancelled) setPrototypeReady(!!html)
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDelivery?.id, currentProject?.id])

  const handleGeneratePrototype = async () => {
    const prdContent = activeDeliverableData?.content
    if (!prdContent) {
      showToast('请先生成 PRD 交付物，再生成原型', 'error')
      return
    }
    setPrototypeBusy(true)
    showToast('AI 正在生成 HTML 原型...', 'info')
    try {
      const html = await generatePrototype(prdContent, currentProject.name, selectedDelivery.description || selectedDelivery.title)
      const path = await savePrototype(currentProject.id, selectedDelivery.id, html)
      setPrototypeReady(true)
      setPrototypePreview({ html, path })
      showToast('原型已生成并保存到本地', 'success')
    } catch (e) {
      showToast(`原型生成失败：${e?.message || e}`, 'error')
    }
    setPrototypeBusy(false)
  }

  const handleViewPrototype = async () => {
    const html = await loadPrototype(currentProject.id, selectedDelivery.id)
    if (!html) {
      setPrototypeReady(false)
      showToast('未找到已保存的原型，请重新生成', 'error')
      return
    }
    const path = await getPrototypePath(currentProject.id, selectedDelivery.id)
    setPrototypePreview({ html, path })
  }

  // Get stage config for active stage (effective = admin + user overrides)
  const stageConfig = selectedDelivery
    ? getEffectiveStageConfig(currentProject.id, activeStage.id, selectedDelivery.id)
    : getStageConfig(currentProject.id, activeStage.id)

  // Bound agent for the active stage (from flow node's agentId)
  const flowNode = useMemo(() => {
    return getFlowNode(currentProject.id, activeStage?.id)
  }, [getFlowNode, currentProject.id, activeStage?.id])

  const stageAgent = useMemo(() => {
    if (!flowNode?.agentId) return null
    return agents.find(a => a.id === flowNode.agentId && a.enabled) || null
  }, [agents, flowNode])

  // Gate config for the active stage (from flow node's gate)
  const stageGate = useMemo(() => {
    return getStageGate(currentProject.id, activeStage?.id)
  }, [getStageGate, currentProject.id, activeStage?.id])

  const hasHumanReviewGate = stageGate?.humanReview === true

  // ─── Progress helpers ───
  const getDeliveryProgress = (delivery) => {
    if (!delivery || totalStages === 0) return 0
    return Math.round(((delivery.currentStageIndex + 1) / totalStages) * 100)
  }

  const getDeliveryStatus = (delivery) => {
    if (!delivery) return 'pending'
    if (delivery.currentStageIndex >= totalStages - 1) return 'delivered'
    const hasContent = stageDeliverables[delivery.id]?.[projectStages[0]?.id]?.content
    if (delivery.currentStageIndex === 0 && !hasContent) return 'pending'
    return 'progress'
  }

  const statusLabels = {
    pending: '待开始',
    progress: '进行中',
    delivered: '已交付',
  }

  // Get stored deliverable for a stage
  const getDeliverableData = (stageId) => {
    if (!selectedDelivery) return null
    const deliveryData = stageDeliverables[selectedDelivery.id]
    return deliveryData?.[stageId] || null
  }

  // Get previous stage content (for context in generation)
  const getPreviousDeliverableContent = (stageIndex) => {
    if (!selectedDelivery || stageIndex <= 0) return ''
    const prevStage = projectStages[stageIndex - 1]
    const data = getDeliverableData(prevStage.id)
    return data?.content || ''
  }

  // Close dialog on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showImportModal) setShowImportModal(false)
        if (showCreateDelivery) { setShowCreateDelivery(false); setEditingDeliveryId(null) }
        if (viewDeliverable) setViewDeliverable(null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showCreateDelivery, viewDeliverable, showImportModal])

  // ─── Traceability Chain ────────────────────────────────────────
  const refreshTraceability = useCallback(async () => {
    if (!currentProject) return
    try {
      const chain = await getTraceabilityChain(currentProject.id, selectedDelivery?.id, flowConfig)
      setTraceabilityData(chain)
    } catch (err) {
      showToast(`追溯链加载失败：${err?.message || err}`, 'error')
      setTraceabilityData([])
    }
  }, [currentProject, selectedDelivery, flowConfig])

  useEffect(() => {
    if (detailTab === 'traceability') {
      refreshTraceability()
    }
  }, [detailTab, currentProject, selectedDelivery, refreshTraceability])

  // ─── Interactive Chat: converse with AI before generating ─────────
  const handleStageChat = async () => {
    const msg = chatInput.trim()
    if (!msg) return
    if (!hasAPIKey()) {
      showToast('请先在「设置 → 全局配置」中配置 AI API Key', 'error')
      return
    }
    if (!selectedDelivery) {
      showToast('请先选择一个交付需求', 'info')
      return
    }

    const userMsg = { role: 'user', content: msg }
    setStageChat(prev => [...prev, userMsg])
    setChatInput('')
    setIsChatting(true)

    try {
      const stage = activeStage
      const node = getFlowNode(currentProject.id, stage.id)
      const agent = node?.agentId ? agents.find(a => a.id === node.agentId) : null
      const graphContext = currentProject
        ? await getUpstreamContext(currentProject.id, stage.id, selectedDelivery.id, flowConfig)
        : null

      const response = await chatWithStage(
        stage.id,
        msg,
        stageChat,
        graphContext,
        agent?.model || stageConfig.model || null,
        agent ? { systemPrompt: agent.systemPrompt, temperature: agent.temperature, model: agent.model } : null,
      )

      setStageChat(prev => [...prev, { role: 'assistant', content: response }])
    } catch (err) {
      setStageChat(prev => [...prev, { role: 'assistant', content: `⚠️ 对话失败：${err.message}` }])
    } finally {
      setIsChatting(false)
    }
  }

  const handleChatKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleStageChat()
    }
  }

  const clearStageChat = () => {
    setStageChat([])
  }

  // ─── Generate deliverable with chat context ──────────────────────
  const handleGenerateWithChat = async (stage) => {
    if (!selectedDelivery) {
      showToast('请先选择一个交付需求', 'info')
      return
    }
    if (!hasAPIKey()) {
      showToast('请先在「设置 → 全局配置」中配置 AI API Key', 'error')
      return
    }

    setIsGenerating(true)
    setGeneratingProgress('正在连接 AI 服务...')
    showToast(`AI 正在生成「${stage.name}」交付物...`, 'info')

    try {
      const stageIndex = projectStages.findIndex(s => s.id === stage.id)
      const prevContent = getPreviousDeliverableContent(stageIndex)

      const node = getFlowNode(currentProject.id, stage.id)
      const agent = node?.agentId ? agents.find(a => a.id === node.agentId) : null
      const genConfig = {
        model: agent?.model || stageConfig.model || null,
        temperature: agent?.temperature ?? stageConfig.temperature ?? 0.7,
        prompt: agent?.systemPrompt || stageConfig.prompt || stage.guidance?.template || '',
      }

      const graphContext = currentProject
        ? await getUpstreamContext(currentProject.id, stage.id, selectedDelivery.id, flowConfig)
        : null
      if (graphContext && graphContext.context.length > 0) {
        setGeneratingProgress(`正在生成 ${stage.name}（已引用 ${graphContext.context.length} 个上游交付物）...`)
      } else {
        setGeneratingProgress(`正在生成 ${stage.name}...`)
      }

      // Extract user requirements from chat history
      const chatSummary = stageChat.length > 0
        ? stageChat.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n')
        : null

      const content = await generateDeliverable(
        stage.id,
        currentProject.name,
        selectedDelivery.title,
        prevContent,
        genConfig.model,
        graphContext,
        chatSummary,
        stageChat.length > 0 ? stageChat : null,
      )

      saveStageDeliverable(selectedDelivery.id, stage.id, content)
      setEditContent(content)

      if (currentProject) {
        await registerDeliverable({
          projectId: currentProject.id,
          deliveryId: selectedDelivery.id,
          stageId: stage.id,
          label: `${stage.shortName}-${selectedDelivery.title}`,
          content,
          author: 'AI',
          flowConfig,
        })
      }

      setGeneratingProgress('')
      showToast(`「${stage.name}」交付物生成完成！`, 'success')

      if (detailTab === 'traceability') {
        refreshTraceability()
      }
    } catch (err) {
      setGeneratingProgress('')
      showToast(`生成失败：${err.message}`, 'error')
    } finally {
      setIsGenerating(false)
    }
  }

  // ─── Import deliverable from external tools ─────────────────────
  const handleImportFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target.result
      saveStageDeliverable(selectedDelivery.id, activeStage.id, content)
      setEditContent(content)
      registerImportedDeliverable(content, file.name)
      setShowImportModal(false)
      setImportText('')
      setImportPath('')
      showToast(`已导入文件「${file.name}」`, 'success')
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleImportPath = () => {
    if (!importPath.trim()) {
      showToast('请输入文件路径', 'error')
      return
    }
    // In browser environment, we can't read arbitrary file paths.
    // We store the path reference and use it as the deliverable content marker.
    const content = `【本地文件引用】\n文件路径：${importPath.trim()}\n\n此交付物引用了本地文件，请在该路径下查看完整内容。`
    saveStageDeliverable(selectedDelivery.id, activeStage.id, content)
    setEditContent(content)
    registerImportedDeliverable(content, importPath.trim())
    setShowImportModal(false)
    setImportPath('')
    showToast(`已关联本地文件：${importPath.trim()}`, 'success')
  }

  const handleImportText = () => {
    if (!importText.trim()) {
      showToast('请粘贴交付物内容', 'error')
      return
    }
    saveStageDeliverable(selectedDelivery.id, activeStage.id, importText.trim())
    setEditContent(importText.trim())
    registerImportedDeliverable(importText.trim(), null)
    setShowImportModal(false)
    setImportText('')
    showToast('已导入粘贴的内容', 'success')
  }

  const registerImportedDeliverable = (content, sourceName) => {
    if (!currentProject || !activeStage) return
    registerDeliverable({
      projectId: currentProject.id,
      deliveryId: selectedDelivery.id,
      stageId: activeStage.id,
      label: `${activeStage.shortName}-${selectedDelivery.title}`,
      content,
      author: sourceName || '手动导入',
      flowConfig,
    })
  }

  const openImportModal = () => {
    setImportMode('file')
    setImportText('')
    setImportPath('')
    setShowImportModal(true)
  }

  // ─── Real AI Generate ──────────────────────────────────────────
  const handleGenerate = async (stage) => {
    // 双系统收敛：生成统一走 sidecar LangGraph 执行引擎（含上下文包/
    // 知识召回/评审/反思），前端直调 LLM 的路径已移除
    if (!selectedDelivery) {
      showToast('请先选择一个交付需求', 'info')
      return
    }
    if (!graphRt.available) {
      showToast('执行引擎不可用：sidecar 未就绪，请重启应用后重试', 'error')
      return
    }
    await handleGraphAdvance()
  }

  // ─── Real AI Review ────────────────────────────────────────────
  const handleReview = async (stage) => {
    if (!selectedDelivery) {
      showToast('请先选择一个交付需求', 'info')
      return
    }
    if (!hasAPIKey()) {
      showToast('请先在「设置 → 全局配置」中配置 AI API Key', 'error')
      return
    }

    const deliverableData = getDeliverableData(stage.id)
    if (!deliverableData?.content) {
      showToast('请先生成交付物再进行AI评审', 'error')
      return
    }

    setIsReviewing(true)
    showToast(`AI 正在评审「${stage.name}」...`, 'info')

    try {
      const review = await aiReviewService(deliverableData.content, stage.name)
      // Preserve existing human review if present
      const existingReview = deliverableData.review || {}
      const mergedReview = { ...review, humanReview: existingReview.humanReview || null }
      saveStageReview(selectedDelivery.id, stage.id, mergedReview)

      // ─── Knowledge graph: register review（sidecar 会 upsert 交付物质量分并创建 Review 实体）───
      if (currentProject) {
        await registerReview({
          projectId: currentProject.id,
          deliveryId: selectedDelivery.id,
          stageId: stage.id,
          content: deliverableData.content,
          review,
          flowConfig,
        })
      }

      showToast(
        `评审完成：${review.totalScore}/100 分，${review.passed ? '通过' : '需改进'}`,
        review.passed ? 'success' : 'info'
      )

      // Refresh traceability if visible
      if (detailTab === 'traceability') {
        refreshTraceability()
      }
    } catch (err) {
      showToast(`评审失败：${err.message}`, 'error')
    } finally {
      setIsReviewing(false)
    }
  }

  // ─── Human Review Action ───
  const handleHumanReview = (passed) => {
    if (!selectedDelivery) return
    const existingReview = activeDeliverableData?.review || {}
    const updatedReview = {
      ...existingReview,
      humanReview: {
        passed,
        reviewer: currentUser?.name || '当前用户',
        at: new Date().toISOString(),
      },
    }
    saveStageReview(selectedDelivery.id, activeStage.id, updatedReview)
    showToast(passed ? '人工评审已通过' : '人工评审已驳回', passed ? 'success' : 'info')
  }

  // ─── Sidecar graph runtime (harness backbone, tauri-only) ───
  const sidecarApi = useSidecar()
  const graphRt = useMemo(() => createGraphRuntime(sidecarApi), [sidecarApi])
  // { threadId, status: 'running'|'interrupted'|'completed'|'error', stage, streamText, error }
  const [graphExec, setGraphExec] = useState(null)
  // Agent 工具调用轨迹（graph/tool_call 事件序列，供执行面板展示）
  const [toolLog, setToolLog] = useState([])
  // review 驳回通知（graph/review_rejected）：得分/阈值/重试次数
  const [reviewRejection, setReviewRejection] = useState(null)

  // refs：事件回调在 useEffect 闭包中需要最新上下文，避免 stale closure
  const graphExecRef = useRef(null)
  useEffect(() => { graphExecRef.current = graphExec }, [graphExec])
  const deliveryCtxRef = useRef({})
  deliveryCtxRef.current = {
    deliveryId: selectedDelivery?.id,
    activeStageId: activeStage?.id,
    lastStageIndex: totalStages - 1,
  }

  useEffect(() => {
    if (!graphRt.available) return undefined
    return graphRt.onGraphEvent(({ method, params }) => {
      const prev = graphExecRef.current
      // ignore events from other threads once one is being tracked
      if (prev?.threadId && params?.threadId && params.threadId !== prev.threadId) return
      switch (method) {
        case 'graph/stage_start':
          setGraphExec({ ...(prev || {}), threadId: params.threadId, status: 'running', stage: params.stage, streamText: '' })
          break
        case 'graph/stream':
          if (prev) setGraphExec({ ...prev, streamText: ((prev.streamText || '') + params.delta).slice(-300) })
          break
        case 'graph/tool_call':
          // Agent 轨迹：记录每轮工具调用（工具名/参数/结果摘要）
          setToolLog(log => [...log.slice(-99), {
            stage: params.stage, tool: params.tool, round: params.round,
            args: params.arguments, result: params.result,
          }])
          setGraphExec(p => p ? { ...p, lastTool: params.tool } : p)
          break
        case 'graph/stage_done': {
          // ── 交付物回写闭环：sidecar 生成的交付物写入前端存储 ──
          const { deliveryId, activeStageId } = deliveryCtxRef.current
          const targetDelivery = params.deliveryId || deliveryId
          if (targetDelivery && params.stage) {
            if (typeof params.content === 'string' && params.content) {
              saveStageDeliverable(targetDelivery, params.stage, params.content)
              // 当前正在查看该阶段 → 编辑器同步最新内容
              if (targetDelivery === deliveryId && params.stage === activeStageId) {
                setEditContent(params.content)
              }
            }
            if (params.review) saveStageReview(targetDelivery, params.stage, params.review)
          }
          setGraphExec({ ...(prev || {}), threadId: params.threadId, status: 'running', stage: params.stage, lastScore: params.reviewScore })
          showToast(`「${params.stage}」阶段产出完成${typeof params.reviewScore === 'number' ? `（评审 ${params.reviewScore} 分）` : ''}`, 'success')
          break
        }
        case 'graph/review_rejected':
          setReviewRejection({
            score: params.score, threshold: params.threshold,
            retryCount: params.retryCount, retryTarget: params.retryTarget,
          })
          showToast(`评审驳回（${params.score} < ${params.threshold}），已退回「${params.retryTarget}」重做`, 'warning')
          break
        case 'graph/interrupted':
          setGraphExec({ ...(prev || {}), threadId: params.threadId, status: 'interrupted', next: params.next, interrupts: params.interrupts, currentStage: params.currentStage })
          break
        case 'graph/completed': {
          // 全链路完成 → 交付进度同步至末阶段
          const { deliveryId: ctxDeliveryId, lastStageIndex } = deliveryCtxRef.current
          const targetDelivery = params.deliveryId || ctxDeliveryId
          if (targetDelivery) updateDelivery(targetDelivery, { currentStageIndex: lastStageIndex })
          setGraphExec({ ...(prev || {}), threadId: params.threadId, status: 'completed' })
          setReviewRejection(null)
          showToast('全链路交付完成', 'success')
          break
        }
        case 'graph/error':
          setGraphExec({ ...(prev || {}), threadId: params.threadId, status: 'error', error: params.message })
          showToast(`执行引擎错误：${params.message}`, 'error')
          break
        default:
          break
      }
    })
  }, [graphRt, saveStageDeliverable, saveStageReview, updateDelivery, showToast])

  // Start or resume the sidecar-hosted LangGraph run for the selected delivery
  const handleGraphAdvance = async () => {
    if (!selectedDelivery) return
    try {
      if (graphExec?.status === 'running') {
        showToast('流程正在执行中，请稍候', 'info')
        return
      }
      if (graphExec?.status === 'interrupted') {
        await graphRt.continueDelivery(graphExec.threadId)
        setGraphExec(prev => (prev ? { ...prev, status: 'running' } : prev))
        showToast('已从断点继续执行', 'success')
        return
      }
      const model = getActiveModel() || getCustomModels().find(m => m.enabled && m.apiKey)
      if (!model) {
        showToast('请先在「模型管理」中添加并启用一个自定义模型', 'error')
        return
      }
      // Phase 4: agent bound to the current stage carries the MCP tool config
      const stageAgent = findStageAgent(agents, getFlowNode(currentProject.id, activeStage?.id))
      // 代码索引接入：优先已就绪索引仓库，交付流上下文包自动注入相关代码
      const indexedRepo = getIndexes(currentProject.id).find(i => i.status === 'ready' && i.repoPath)
      const deliveryRepoPath = indexedRepo?.repoPath || getRepositories(currentProject.id)[0]?.path
      const res = await graphRt.startDelivery({
        projectId: currentProject.id,
        deliveryId: selectedDelivery.id,
        projectName: currentProject.name,
        requirement: selectedDelivery.description || selectedDelivery.title,
        dag: getProjectDAG(currentProject),
        modelConfig: { endpoint: model.endpoint, apiKey: model.apiKey, modelId: model.modelId },
        mcpServers: collectAgentMcpServers(stageAgent),
        allowedTools: collectAllowedTools(stageAgent),
        ...(deliveryRepoPath ? { repoPath: deliveryRepoPath } : {}),
      })
      setGraphExec({ threadId: res.threadId, status: 'running', stage: null, streamText: '' })
      showToast('已启动执行引擎（LangGraph）', 'success')
    } catch (e) {
      showToast(`执行引擎调用失败：${e?.message || e}`, 'error')
    }
  }

  // ─── 门禁确认中心：中断原因推导 + 人工确认操作 ───
  // interrupted 分两类：review 门禁（interruptBefore）等待人工确认进入评审；
  // delegate/manual 节点等待外部注入交付物（DelegatePanel 导入通道）
  const gateInterrupt = (() => {
    if (graphExec?.status !== 'interrupted') return null
    const interrupts = graphExec.interrupts || []
    const awaiting = interrupts.find(i => i?.value?.reason === 'awaiting_external_deliverable')
    if (awaiting) return { kind: 'delegate', stage: awaiting.node }
    const next = (graphExec.next || [])[0] || 'review'
    return { kind: 'review-gate', stage: next, prevStage: graphExec.currentStage }
  })()

  // 门禁确认：继续执行（review 门禁通过人工确认后放行）
  const handleGateConfirm = async () => {
    if (!graphExec?.threadId) return
    try {
      await graphRt.continueDelivery(graphExec.threadId)
      setGraphExec(prev => (prev ? { ...prev, status: 'running' } : prev))
      showToast('门禁已确认，继续执行', 'success')
    } catch (e) {
      showToast(`继续执行失败：${e?.message || e}`, 'error')
    }
  }

  // 中止当前执行（用户主动放弃本轮运行）
  const handleAbortRun = async () => {
    if (!graphExec?.threadId) return
    try {
      await graphRt.abort(graphExec.threadId)
      setGraphExec(prev => (prev ? { ...prev, status: 'error', error: '用户已中止执行' } : prev))
      showToast('已中止执行', 'info')
    } catch (e) {
      showToast(`中止失败：${e?.message || e}`, 'error')
    }
  }

  // 人工评审后放行：先写入人工评审结论，再续跑引擎
  const handleGateHumanReview = async (passed) => {
    if (!selectedDelivery || !graphExec?.threadId) return
    const targetStage = gateInterrupt?.prevStage || activeStage?.id
    if (targetStage) {
      const existing = getDeliverableData(targetStage)?.review || {}
      saveStageReview(selectedDelivery.id, targetStage, {
        ...existing,
        humanReview: { passed, reviewer: currentUser?.name || '当前用户', at: new Date().toISOString() },
      })
    }
    await handleGateConfirm()
  }

  // ─── Advance Stage with Gate Checks ───
  const handleAdvance = () => {
    // 纯客户端单一 harness 入口：推进统一走 sidecar LangGraph 执行引擎，
    // 引擎内部完成门禁校验/断点续跑；sidecar 不可用直接报错，不做降级
    if (!graphRt.available) {
      showToast('执行引擎不可用：sidecar 未就绪，请重启应用后重试', 'error')
      return
    }
    handleGraphAdvance()
  }

  // ─── Create Delivery ───
  // tauri: also cut a feature branch on the project's main repo (branch isolation)
  const handleCreateDelivery = async () => {
    if (!newTitle.trim()) {
      showToast('请输入需求标题', 'info')
      return
    }
    // Edit mode: only update basic fields — branch/deliverables untouched
    if (editingDeliveryId) {
      updateDelivery(editingDeliveryId, {
        title: newTitle.trim(),
        description: newDesc.trim(),
        priority: newPriority,
        assignee: newAssignee,
      })
      closeDeliveryDialog()
      showToast('需求已更新', 'success')
      return
    }
    const newDelivery = {
      id: `d${Date.now()}`,
      title: newTitle.trim(),
      description: newDesc.trim(),
      priority: newPriority,
      projectId: currentProject.id,
      assignee: newAssignee || (currentUser?.name || ''),
      currentStageIndex: 0,
      createdAt: new Date().toISOString().split('T')[0],
    }
    const mainRepo = getRepositories(currentProject.id)
      .find(r => r.isMain && r.status === 'ready' && r.path)
    if (mainRepo && !supportsGitOps(mainRepo)) {
      // 本地引用的非 Git 目录：优雅降级，交付流程继续可用
      showToast('本地目录不是 Git 仓库，跳过分支隔离', 'info')
    } else if (mainRepo) {
      const branchName = buildFeatureBranchName(newDelivery.id, newDelivery.title)
      try {
        await createBranch(mainRepo.path, branchName, mainRepo.branch || undefined)
        newDelivery.gitBranch = branchName
      } catch (e) {
        // 分支创建失败不阻塞需求创建，仅提示
        showToast(`特性分支创建失败：${e?.message || e}`, 'error')
      }
    }
    createDelivery(newDelivery)
    setSelectedDeliveryId(newDelivery.id)
    closeDeliveryDialog()
    setNewTitle('')
    setNewDesc('')
    setNewPriority('P1')
    setNewAssignee(currentProject.members?.[0] || '')
    showToast(`需求「${newDelivery.title}」已创建，进入交付流程`, 'success')
  }

  // ─── Push feature branch (explicit only — never automatic) ───
  const [pushingBranch, setPushingBranch] = useState(false)
  const handlePushBranch = async () => {
    if (!selectedDelivery?.gitBranch) return
    const mainRepo = getRepositories(currentProject.id)
      .find(r => r.isMain && r.status === 'ready' && r.path)
    if (!mainRepo) {
      showToast('未找到就绪的主仓库，无法推送分支', 'error')
      return
    }
    if (!supportsGitOps(mainRepo)) {
      // 非 Git 的本地引用目录无远程可推
      showToast('本地目录不是 Git 仓库，不支持推送', 'info')
      return
    }
    setPushingBranch(true)
    try {
      await pushBranch(mainRepo.path, selectedDelivery.gitBranch, mainRepo.gitUrl)
      showToast(`分支 ${selectedDelivery.gitBranch} 已推送到远程`, 'success')
    } catch (e) {
      showToast(`推送失败：${e?.message || e}`, 'error')
    }
    setPushingBranch(false)
  }

  const openEditDelivery = (d) => {
    setEditingDeliveryId(d.id)
    setNewTitle(d.title)
    setNewDesc(d.description || '')
    setNewPriority(d.priority || 'P1')
    setNewAssignee(d.assignee || '')
    setShowCreateDelivery(true)
  }

  const closeDeliveryDialog = () => {
    setShowCreateDelivery(false)
    setEditingDeliveryId(null)
  }

  const handleDeleteDelivery = (d) => {
    if (!window.confirm(`确定删除需求「${d.title}」？其阶段交付物将一并移除，且不可恢复。`)) return
    deleteDelivery(d.id)
    if (selectedDeliveryId === d.id) setSelectedDeliveryId('')
    showToast(`需求「${d.title}」已删除`, 'success')
  }

  const openCreateDelivery = () => {
    setEditingDeliveryId(null)
    setNewTitle('')
    setNewDesc('')
    setNewPriority('P1')
    setNewAssignee(currentProject.members?.[0] || '')
    setShowCreateDelivery(true)
  }

  // Copy content to clipboard
  const copyContent = (content) => {
    navigator.clipboard.writeText(content).then(() => {
      showToast('已复制到剪贴板', 'success')
    })
  }

  // Download content as .md file
  const downloadContent = (content, stageName) => {
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentProject.name}-${stageName}-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
    showToast('已下载', 'success')
  }

  // Save edited content
  const handleSaveContent = () => {
    if (!selectedDelivery) return
    saveStageDeliverable(selectedDelivery.id, activeStage.id, editContent)
    showToast('内容已保存', 'success')
  }

  // ─── Gate status for advance bar (from flow node gate) ───
  const aiReviewStatus = (() => {
    if (!stageGate?.aiReview) return 'none'
    const review = activeDeliverableData?.review
    if (!review) return 'pending'
    if (!review.passed) return 'failed'
    // 阈值达标校验（与推进门禁 Gate 1 保持一致）
    if (stageGate.threshold > 0 && (review.totalScore ?? 0) < stageGate.threshold) return 'failed'
    return 'passed'
  })()

  const humanReviewStatus = (() => {
    if (!hasHumanReviewGate) return 'none'
    const review = activeDeliverableData?.review
    if (!review?.humanReview) return 'pending'
    return review.humanReview.passed ? 'passed' : 'failed'
  })()

  const isAtCurrentStage = selectedDelivery && activeStageIndex === selectedDelivery.currentStageIndex
  const isAtLastStage = selectedDelivery && selectedDelivery.currentStageIndex >= totalStages - 1
  const canAdvance = isAtCurrentStage && !isAtLastStage &&
    (aiReviewStatus === 'none' || aiReviewStatus === 'passed') &&
    (humanReviewStatus === 'none' || humanReviewStatus === 'passed')

  // ─── Render a config section (Skills / MCPs / Rules) ───────────
  const renderConfigSection = (configType, Icon, title) => {
    const items = stageConfig[configType] || []
    const adminItems = items.filter(i => !i.userAdded)
    const userItems = items.filter(i => i.userAdded)

    const handleAdd = () => {
      const name = addOverride.name.trim()
      if (!name) return
      addDeliveryStageOverride(selectedDelivery.id, activeStage.id, configType, {
        name,
        desc: addOverride.desc.trim(),
      })
      showToast(`已添加：${name}`, 'success')
      setAddOverride({ type: null, name: '', desc: '' })
    }

    return (
      <div className="stage-config-section">
        <div className="stage-config-section-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Icon size={11} /> {title} ({items.filter(i => i.enabled).length}/{items.length})
          </span>
        </div>

        {/* Admin default items */}
        <div style={{ fontSize: '10px', fontWeight: 510, color: 'var(--fg-muted)', margin: '6px 0 4px' }}>
          管理员默认配置
        </div>
        {adminItems.length === 0 && (
          <div style={{ fontSize: '11px', color: 'var(--fg-muted)', padding: '4px 0' }}>暂无默认配置</div>
        )}
        {adminItems.map((item, i) => (
          <div key={i} className={`stage-config-item${item.enabled ? '' : ' disabled'}`}>
            <div className="stage-config-item-info">
              <div className="stage-config-item-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {item.name}
                <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: 'color-mix(in srgb, var(--color-progress) 14%, transparent)', color: 'var(--color-progress)', fontWeight: 510 }}>默认</span>
              </div>
              <div className="stage-config-item-desc">{item.desc}</div>
            </div>
            <Toggle
              checked={item.enabled}
              onChange={() => {
                toggleStageConfigItem(currentProject.id, activeStage.id, configType, item.name)
                showToast(`${item.name} ${item.enabled ? '已禁用' : '已启用'}`, 'success')
              }}
              label={`启用 ${item.name}`}
              size="sm"
            />
          </div>
        ))}

        {/* User-added overrides (only when a delivery is selected) */}
        {selectedDelivery && userItems.length > 0 && (
          <>
            <div style={{ fontSize: '10px', fontWeight: 510, color: 'var(--accent)', margin: '10px 0 4px' }}>
              我的附加配置
            </div>
            {userItems.map((item, i) => (
              <div key={`u-${i}`} className={`stage-config-item${item.enabled ? '' : ' disabled'}`}>
                <div className="stage-config-item-info">
                  <div className="stage-config-item-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {item.name}
                    <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', fontWeight: 510 }}>我的</span>
                  </div>
                  <div className="stage-config-item-desc">{item.desc}</div>
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ padding: '4px', color: 'var(--color-error)' }}
                  onClick={() => {
                    removeDeliveryStageOverride(selectedDelivery.id, activeStage.id, configType, item.name)
                    showToast(`已移除 ${item.name}`, 'success')
                  }}
                  title="移除"
                  aria-label={`移除 ${item.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </>
        )}

        {/* Add control (only when a delivery is selected) */}
        {selectedDelivery && (
          addOverride.type === configType ? (
            <div style={{ marginTop: '8px', padding: '8px', borderRadius: '6px', border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))', background: 'color-mix(in srgb, var(--accent) 4%, var(--bg))' }}>
              <input
                type="text"
                placeholder="名称"
                value={addOverride.name}
                onChange={e => setAddOverride({ ...addOverride, name: e.target.value })}
                style={{ width: '100%', fontSize: '12px', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-subtle)', background: 'var(--bg)', color: 'var(--fg)', marginBottom: '6px', boxSizing: 'border-box' }}
                aria-label="名称"
              />
              <input
                type="text"
                placeholder="描述（可选）"
                value={addOverride.desc}
                onChange={e => setAddOverride({ ...addOverride, desc: e.target.value })}
                style={{ width: '100%', fontSize: '12px', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border-subtle)', background: 'var(--bg)', color: 'var(--fg)', marginBottom: '8px', boxSizing: 'border-box' }}
                aria-label="描述"
              />
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => setAddOverride({ type: null, name: '', desc: '' })}>
                  取消
                </button>
                <button
                  className="btn btn-primary"
                  style={{ padding: '4px 10px', fontSize: '12px' }}
                  disabled={!addOverride.name.trim()}
                  onClick={handleAdd}
                >
                  <Plus size={11} /> 添加
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn btn-ghost"
              style={{ width: '100%', marginTop: '8px', justifyContent: 'center', fontSize: '12px', color: 'var(--accent)' }}
              onClick={() => setAddOverride({ type: configType, name: '', desc: '' })}
            >
              <Plus size={12} /> 添加
            </button>
          )
        )}
      </div>
    )
  }

  return (
    <div className="fade-in">
      {/* Breadcrumb */}
      <nav className="breadcrumb" aria-label="面包屑导航">
        <Link to="/" className="breadcrumb-link">项目总览</Link>
        <ChevronRight size={12} className="breadcrumb-separator" aria-hidden="true" />
        <Link to="/projects" className="breadcrumb-link">项目管理</Link>
        <ChevronRight size={12} className="breadcrumb-separator" aria-hidden="true" />
        <span className="breadcrumb-current" aria-current="page">{currentProject.name} · 交付流水线</span>
      </nav>

      {/* Compact Header */}
      <div className="pipeline-compact-header">
        <div className="pipeline-compact-header-left">
          <h2>{currentProject.name}</h2>
          <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
            {projectDeliveries.length} 个交付需求 · {totalStages} 个阶段
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {!hasAPIKey() && (
            <Link to="/settings" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
              配置 API Key
            </Link>
          )}
          <button className="btn btn-primary" onClick={openCreateDelivery} aria-haspopup="dialog">
            <Plus size={14} aria-hidden="true" /> 新建需求
          </button>
        </div>
      </div>

      {/* ─── Delivery Workspace: 2-column layout ─── */}
      <div className="delivery-workspace">
        {/* ═══ Left: Requirement List Panel (30%) ═══ */}
        <div className="delivery-list-panel">
          <div className="delivery-list-header">
            <span className="delivery-list-header-title">交付需求</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--fg-muted)' }}>
                <Toggle checked={showArchived} onChange={setShowArchived} label="显示已归档需求" size="sm" />
                已归档
              </span>
              <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={openCreateDelivery} aria-label="新建需求">
                <Plus size={14} />
              </button>
            </span>
          </div>
          <div className="delivery-list-scroll">
            {projectDeliveries.length === 0 ? (
              <div className="delivery-list-empty">
                <FileText size={28} style={{ opacity: 0.3, marginBottom: '8px' }} />
                <div>当前项目暂无交付需求</div>
                <div style={{ fontSize: '11px', marginTop: '4px' }}>点击「新建需求」发起交付</div>
              </div>
            ) : (
              projectDeliveries.map(d => {
                const progress = getDeliveryProgress(d)
                const status = getDeliveryStatus(d)
                const isActive = d.id === selectedDeliveryId
                const stageName = projectStages[d.currentStageIndex]?.name || '未知'
                return (
                  <div
                    key={d.id}
                    className={`delivery-req-card${isActive ? ' active' : ''}`}
                    style={d.archived ? { opacity: 0.55 } : undefined}
                    role="button"
                    tabIndex={0}
                    aria-label={`选择需求 ${d.title}，状态：${statusLabels[status]}`}
                    aria-pressed={isActive}
                    onClick={() => setSelectedDeliveryId(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedDeliveryId(d.id)
                      }
                    }}
                  >
                    <div className="delivery-req-card-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.title}{d.archived ? '（已归档）' : ''}
                      </span>
                      <span style={{ display: 'flex', gap: '2px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                        <button className="btn btn-ghost" style={{ padding: '2px', opacity: 0.6 }} onClick={() => openEditDelivery(d)} aria-label={`编辑需求 ${d.title}`} title="编辑">
                          <Pencil size={12} />
                        </button>
                        <button className="btn btn-ghost" style={{ padding: '2px', opacity: 0.6 }} onClick={() => { archiveDelivery(d.id, !d.archived); showToast(d.archived ? '已恢复需求' : '需求已归档', 'success') }} aria-label={d.archived ? `恢复需求 ${d.title}` : `归档需求 ${d.title}`} title={d.archived ? '恢复' : '归档'}>
                          <Archive size={12} />
                        </button>
                        <button className="btn btn-ghost" style={{ padding: '2px', opacity: 0.6, color: 'var(--color-error)' }} onClick={() => handleDeleteDelivery(d)} aria-label={`删除需求 ${d.title}`} title="删除">
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </div>
                    <div className="delivery-req-card-meta">
                      <span className="delivery-priority-tag" style={{ background: priorityColors[d.priority] || 'var(--fg-muted)' }}>
                        {d.priority}
                      </span>
                      <span className="delivery-req-card-stage">{stageName}</span>
                      <span className="delivery-req-card-progress">{progress}%</span>
                    </div>
                    <div className="delivery-req-card-footer">
                      <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                        <User size={10} /> {d.assignee || '未分配'}
                      </span>
                      <span className={`status-badge status-${status === 'delivered' ? 'complete' : status === 'progress' ? 'progress' : 'pending'}`}>
                        <span className="status-dot"></span>
                        {statusLabels[status]}
                      </span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ═══ Right: Delivery Detail Panel (70%) ═══ */}
        <div className="delivery-detail-panel">
          {!selectedDelivery ? (
            <div className="delivery-empty-state">
              <div className="delivery-empty-state-icon">
                <Target size={24} />
              </div>
              <div className="delivery-empty-state-title">未选择交付需求</div>
              <div className="delivery-empty-state-desc">
                从左侧选择一个需求查看交付详情，或点击「新建需求」发起一个新的交付流程
              </div>
            </div>
          ) : (
            <>
              {/* ── Detail Header ── */}
              <div className="delivery-detail-header">
                <div className="delivery-detail-title-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="delivery-detail-title">{selectedDelivery.title}</div>
                  </div>
                  <span className="delivery-priority-tag" style={{ background: priorityColors[selectedDelivery.priority] || 'var(--fg-muted)', flexShrink: 0 }}>
                    {selectedDelivery.priority}
                  </span>
                </div>
                {selectedDelivery.description && (
                  <div className="delivery-detail-desc">{selectedDelivery.description}</div>
                )}
                <div className="delivery-detail-meta">
                  <span className="delivery-detail-meta-item">
                    <User size={12} /> {selectedDelivery.assignee || '未分配'}
                  </span>
                  <span className="delivery-detail-meta-item">
                    创建于 {selectedDelivery.createdAt}
                  </span>
                  {selectedDelivery.gitBranch && (
                    <span className="delivery-detail-meta-item" title="本交付的隔离特性分支">
                      <GitFork size={12} />
                      <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>
                        {selectedDelivery.gitBranch}
                      </code>
                    </span>
                  )}
                  <span className={`status-badge status-${getDeliveryStatus(selectedDelivery) === 'delivered' ? 'complete' : getDeliveryStatus(selectedDelivery) === 'progress' ? 'progress' : 'pending'}`}>
                    <span className="status-dot"></span>
                    {statusLabels[getDeliveryStatus(selectedDelivery)]}
                  </span>
                </div>

                {/* Overall Progress Bar */}
                <div className="delivery-progress-row">
                  <div className="delivery-progress-bar" role="progressbar" aria-valuenow={getDeliveryProgress(selectedDelivery)} aria-valuemin={0} aria-valuemax={100} aria-label="整体交付进度">
                    <div className="delivery-progress-fill" style={{ width: `${getDeliveryProgress(selectedDelivery)}%` }} />
                  </div>
                  <span className="delivery-progress-text">
                    {selectedDelivery.currentStageIndex + 1} / {totalStages} · {getDeliveryProgress(selectedDelivery)}%
                  </span>
                </div>

                {/* Stage Navigation Bar */}
                <div className="delivery-stage-nav" role="tablist" aria-label="阶段导航">
                  {projectStages.map((stage, i) => {
                    const isComplete = i < selectedDelivery.currentStageIndex
                    const isActive = i === activeStageIndex
                    const isCurrent = i === selectedDelivery.currentStageIndex
                    const StageIcon = getStageIcon(stage.icon)
                    return (
                      <React.Fragment key={stage.id}>
                        <button
                          className={`delivery-stage-nav-node${isComplete ? ' complete' : ''}${isActive ? ' active' : ''}`}
                          role="tab"
                          aria-selected={isActive}
                          aria-label={`${stage.name}，${isComplete ? '已完成' : isCurrent ? '当前阶段' : '待开始'}`}
                          onClick={() => setActiveStageIndex(i)}
                        >
                          <div className="delivery-stage-nav-dot">
                            {isComplete ? <Check size={12} /> : <StageIcon size={12} />}
                          </div>
                          <span className="delivery-stage-nav-label">{stage.shortName || stage.name}</span>
                        </button>
                        {i < projectStages.length - 1 && (
                          <div className={`delivery-stage-nav-connector${isComplete ? ' complete' : ''}`} aria-hidden="true" />
                        )}
                      </React.Fragment>
                    )
                  })}
                </div>
              </div>

              {/* ── Tabs ── */}
              <div className="delivery-tabs">
                <button
                  className={`delivery-tab${detailTab === 'current' ? ' active' : ''}`}
                  onClick={() => setDetailTab('current')}
                  role="tab"
                  aria-selected={detailTab === 'current'}
                >
                  当前阶段
                </button>
                <button
                  className={`delivery-tab${detailTab === 'traceability' ? ' active' : ''}`}
                  onClick={() => { setDetailTab('traceability'); refreshTraceability() }}
                  role="tab"
                  aria-selected={detailTab === 'traceability'}
                >
                  <Link2 size={13} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
                  交付追溯
                </button>
                <button
                  className={`delivery-tab${detailTab === 'config' ? ' active' : ''}`}
                  onClick={() => setDetailTab('config')}
                  role="tab"
                  aria-selected={detailTab === 'config'}
                >
                  <Settings size={13} style={{ verticalAlign: 'middle', marginRight: '2px' }} />
                  阶段配置
                </button>
              </div>

              {/* ── Tab Content ── */}
              <div className="delivery-tab-content">
                {/* ═══ Tab: 当前阶段 ═══ */}
                {detailTab === 'current' && activeStage && (
                  <div>
                    {/* Stage Info */}
                    <div className="delivery-stage-info">
                      <div className="delivery-stage-info-icon" style={{ background: `${activeStage.color}15`, color: activeStage.color }}>
                        {(() => {
                          const StageIcon = getStageIcon(activeStage.icon)
                          return <StageIcon size={18} />
                        })()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="delivery-stage-info-name">{activeStage.name}</div>
                        <div className="delivery-stage-info-type">
                          产出类型：{activeStage.concept || 'Deliverable'}
                          {activeStageIndex === selectedDelivery.currentStageIndex && ' · 当前进行中'}
                          {activeStageIndex < selectedDelivery.currentStageIndex && ' · 已完成'}
                          {activeStageIndex > selectedDelivery.currentStageIndex && ' · 待开始'}
                        </div>
                      </div>
                    </div>

                    {/* Bound Agent Info */}
                    {stageAgent ? (
                      <div className="delivery-agent-info">
                        <Bot size={14} style={{ color: 'var(--color-ai-review)', flexShrink: 0 }} />
                        <span style={{ color: 'var(--fg-tertiary)' }}>绑定智能体：</span>
                        <span className="delivery-agent-chip">
                          <Bot size={10} /> {stageAgent.name} · {stageAgent.model}
                        </span>
                        {(stageAgent.skills || []).length > 0 && (
                          <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                            Skills: {stageAgent.skills.join(', ')}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="delivery-agent-info" style={{ background: 'color-mix(in srgb, var(--color-human-review) 6%, var(--bg))', borderColor: 'color-mix(in srgb, var(--color-human-review) 20%, var(--border))' }}>
                        <AlertCircle size={14} style={{ color: 'var(--color-human-review)', flexShrink: 0 }} />
                        <span style={{ color: 'var(--fg-tertiary)' }}>未配置智能体，该阶段将使用默认配置</span>
                        <Link to="/config" className="btn btn-ghost" style={{ fontSize: '11px', padding: '2px 8px', marginLeft: 'auto' }}>
                          前往配置
                        </Link>
                      </div>
                    )}

                    {/* Config Summary */}
                    <div className="delivery-config-summary">
                      <div className="delivery-config-summary-item">
                        <span className="delivery-config-summary-label">模型</span>
                        <span className="delivery-config-summary-value">{stageConfig.model || '默认模型'}</span>
                      </div>
                      <div className="delivery-config-summary-item">
                        <span className="delivery-config-summary-label">温度</span>
                        <span className="delivery-config-summary-value">{stageConfig.temperature ?? 0.7}</span>
                      </div>
                      <div className="delivery-config-summary-item" style={{ flex: 1, minWidth: '120px' }}>
                        <span className="delivery-config-summary-label">提示词摘要</span>
                        <span className="delivery-config-summary-value">
                          {stageConfig.prompt ? (stageConfig.prompt.slice(0, 60) + (stageConfig.prompt.length > 60 ? '...' : '')) : '使用默认提示词'}
                        </span>
                      </div>
                    </div>

                    {/* ── Interactive Chat Area ── */}
                    {activeStage.generatable && isAtCurrentStage && (
                      <div className="delivery-chat-area">
                        {/* Chat toggle bar */}
                        <div
                          className="delivery-chat-toggle"
                          onClick={() => setShowChat(!showChat)}
                          role="button"
                          tabIndex={0}
                          aria-expanded={showChat}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowChat(!showChat) } }}
                        >
                          <MessageSquare size={14} style={{ color: 'var(--accent)' }} />
                          <span style={{ fontSize: '13px', fontWeight: 510, color: 'var(--fg-secondary)' }}>
                            交互式生成
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                            {showChat ? '收起对话' : '展开对话，输入需求让AI按你的要求生成'}
                          </span>
                          {stageChat.length > 0 && (
                            <span style={{
                              fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                              background: 'var(--accent)', color: '#fff', fontWeight: 510,
                            }}>
                              {stageChat.length} 条对话
                            </span>
                          )}
                          <ChevronRight size={14} style={{ marginLeft: 'auto', color: 'var(--fg-muted)', transition: 'transform 0.2s', transform: showChat ? 'rotate(90deg)' : 'rotate(0)' }} />
                        </div>

                        {/* Chat messages + input */}
                        {showChat && (
                          <div className="delivery-chat-body">
                            {/* Messages */}
                            {stageChat.length > 0 && (
                              <div className="delivery-chat-messages">
                                {stageChat.map((msg, i) => (
                                  <div key={i} className={`delivery-chat-msg ${msg.role}`}>
                                    <div className="delivery-chat-msg-avatar">
                                      {msg.role === 'user' ? <User size={12} /> : <Bot size={12} />}
                                    </div>
                                    <div className="delivery-chat-msg-content">{msg.content}</div>
                                  </div>
                                ))}
                                {isChatting && (
                                  <div className="delivery-chat-msg assistant">
                                    <div className="delivery-chat-msg-avatar">
                                      <Bot size={12} />
                                    </div>
                                    <div className="delivery-chat-msg-content" style={{ opacity: 0.6 }}>
                                      <Loader2 size={12} className="spin" style={{ verticalAlign: 'middle' }} /> 思考中...
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Input */}
                            <div className="delivery-chat-input-row">
                              <textarea
                                className="delivery-chat-input"
                                value={chatInput}
                                onChange={e => setChatInput(e.target.value)}
                                onKeyDown={handleChatKeyDown}
                                placeholder="输入你的需求、补充说明或问题，AI 会基于对话内容生成交付物...（Enter 发送，Shift+Enter 换行）"
                                rows={2}
                                disabled={isChatting}
                                aria-label="交互式对话输入"
                              />
                              <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end' }}>
                                <button
                                  className="btn btn-secondary"
                                  style={{ fontSize: '12px', padding: '6px 10px' }}
                                  onClick={handleStageChat}
                                  disabled={!chatInput.trim() || isChatting}
                                >
                                  {isChatting ? <Loader2 size={12} className="spin" /> : <Send size={12} />}
                                  发送
                                </button>
                                {stageChat.length > 0 && (
                                  <button
                                    className="btn btn-ghost"
                                    style={{ fontSize: '12px', padding: '6px 8px' }}
                                    onClick={clearStageChat}
                                    title="清空对话"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Quick generate from chat */}
                            {stageChat.length > 0 && (
                              <div style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent) 6%, var(--bg))', border: '1px solid color-mix(in srgb, var(--accent) 15%, var(--border))' }}>
                                <div style={{ fontSize: '11px', color: 'var(--fg-tertiary)', marginBottom: '6px' }}>
                                  基于以上 {stageChat.length} 条对话，生成交付物：
                                </div>
                                <button
                                  className="stage-quick-action-btn primary"
                                  onClick={() => handleGenerateWithChat(activeStage)}
                                  disabled={isGenerating || isChatting || !hasAPIKey()}
                                >
                                  {isGenerating ? <Loader2 size={12} className="spin" /> : <Bot size={12} />}
                                  基于对话生成
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action Buttons */}
                    <div className="delivery-action-row">
                      {activeStage.generatable && (
                        <button
                          className="stage-quick-action-btn primary"
                          onClick={() => handleGenerate(activeStage)}
                          disabled={isReviewing || !graphRt.available || !isAtCurrentStage || graphExec?.status === 'running'}
                          title={!isAtCurrentStage ? '仅当前阶段可生成' : !graphRt.available ? '执行引擎不可用' : '由 sidecar 执行引擎生成（含上下文包与知识召回）'}
                        >
                          {graphExec?.status === 'running' ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
                          {graphExec?.status === 'running' ? '引擎执行中' : activeDeliverableData?.content ? '重新生成（引擎）' : '执行引擎生成'}
                        </button>
                      )}
                      <button
                        className="stage-quick-action-btn"
                        onClick={openImportModal}
                        disabled={!isAtCurrentStage || !selectedDelivery}
                        title={!isAtCurrentStage ? '仅当前阶段可导入' : '从外部工具导入交付物'}
                      >
                        <Upload size={12} />
                        导入交付物
                      </button>
                      {/* PRD 阶段：HTML 原型生成/预览（t5） */}
                      {activeStage.id === 'prd' && (
                        <button
                          className="stage-quick-action-btn"
                          onClick={handleGeneratePrototype}
                          disabled={prototypeBusy || isGenerating || !activeDeliverableData?.content || !hasAPIKey()}
                          title={!activeDeliverableData?.content ? '请先生成 PRD 交付物' : '基于 PRD 内容生成单文件 HTML 线框原型'}
                        >
                          {prototypeBusy ? <Loader2 size={12} className="spin" /> : <LayoutTemplate size={12} />}
                          {prototypeReady ? '重新生成原型' : '生成原型图'}
                        </button>
                      )}
                      {activeStage.id === 'prd' && prototypeReady && !prototypeBusy && (
                        <button
                          className="stage-quick-action-btn"
                          onClick={handleViewPrototype}
                          title="预览已保存到本地的 HTML 原型"
                        >
                          <Eye size={12} />
                          查看原型
                        </button>
                      )}
                      {stageGate?.aiReview && (
                        <button
                          className="stage-quick-action-btn"
                          onClick={() => handleReview(activeStage)}
                          disabled={!activeDeliverableData?.content || isGenerating || isReviewing || !hasAPIKey()}
                        >
                          {isReviewing ? <Loader2 size={12} className="spin" /> : <Eye size={12} />}
                          AI 评审
                        </button>
                      )}
                      {generatingProgress && (
                        <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)', alignSelf: 'center' }}>
                          {generatingProgress}
                        </span>
                      )}
                    </div>

                    {/* Content Editor (editable) */}
                    <div className="delivery-content-toolbar">
                      <span className="delivery-content-toolbar-meta">
                        {activeDeliverableData?.generatedAt
                          ? `生成于 ${new Date(activeDeliverableData.generatedAt).toLocaleString('zh-CN')}`
                          : '暂无内容'}
                      </span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => copyContent(editContent)} title="复制" disabled={!editContent}>
                          <Copy size={13} />
                        </button>
                        <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => downloadContent(editContent, activeStage.name)} title="下载" disabled={!editContent}>
                          <Download size={13} />
                        </button>
                        <button className="btn btn-ghost" style={{ padding: '4px' }} onClick={() => setViewDeliverable({ content: editContent, name: activeStage.name })} title="全屏查看" disabled={!editContent}>
                          <ExternalLink size={13} />
                        </button>
                        <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={handleSaveContent} disabled={!isAtCurrentStage}>
                          保存
                        </button>
                      </div>
                    </div>
                    <textarea
                      className="delivery-content-editor"
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      placeholder={activeStage.generatable
                        ? '点击「AI 生成交付物」自动生成，或在此手动编辑内容...'
                        : '此阶段暂不支持 AI 自动生成，请手动输入交付物内容...'}
                      aria-label={`${activeStage.name} 交付物内容编辑器`}
                    />

                    {/* AI Review Result */}
                    {activeDeliverableData?.review && activeDeliverableData.review.totalScore !== undefined && (() => {
                      const r = activeDeliverableData.review
                      return (
                        <div className="review-result-card" style={{
                          marginTop: '16px',
                          background: r.passed ? 'var(--surface-success)' : 'var(--surface-human-review)',
                          borderColor: r.passed ? 'color-mix(in srgb, var(--color-success) 40%, transparent)' : 'color-mix(in srgb, var(--color-human-review) 40%, transparent)',
                        }}>
                          <div className="review-score-display">
                            <span className="review-score-value" style={{ color: r.passed ? 'var(--color-success)' : 'var(--color-human-review)' }}>{r.totalScore}</span>
                            <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>/100</span>
                            <span style={{ fontSize: '12px', fontWeight: 510, color: r.passed ? 'var(--text-success)' : 'var(--text-human-review)' }}>
                              {r.passed ? '通过' : '需改进'}
                            </span>
                          </div>
                          {r.dimensions && Object.entries(r.dimensions).map(([key, val]) => (
                            <div key={key} className="review-dimension-bar">
                              <div className="review-dimension-label">
                                <span style={{ color: 'var(--fg-secondary)' }}>{key}</span>
                                <span style={{ fontWeight: 510 }}>{val.score || val}分</span>
                              </div>
                              <div className="review-dimension-track">
                                <div className="review-dimension-fill" style={{ width: `${val.score || val}%`, background: 'var(--color-progress)' }} />
                              </div>
                            </div>
                          ))}
                          {r.suggestions?.length > 0 && (
                            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--fg-secondary)' }}>
                              <strong>改进建议：</strong>
                              {r.suggestions.map((s, i) => (
                                <div key={i} style={{ paddingLeft: '8px' }}>• {s}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Human Review Actions */}
                    {hasHumanReviewGate && (
                      <div className="delivery-review-actions">
                        <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)', alignSelf: 'center' }}>人工评审：</span>
                        {activeDeliverableData?.review?.humanReview ? (
                          <span style={{ fontSize: '12px', fontWeight: 510, color: activeDeliverableData.review.humanReview.passed ? 'var(--color-success)' : 'var(--color-error)' }}>
                            {activeDeliverableData.review.humanReview.passed ? '已通过' : '已驳回'} · {activeDeliverableData.review.humanReview.reviewer}
                          </span>
                        ) : null}
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '12px', padding: '4px 10px' }}
                          onClick={() => handleHumanReview(true)}
                          disabled={!isAtCurrentStage}
                        >
                          <CheckCircle2 size={13} style={{ color: 'var(--color-success)' }} /> 通过
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '12px', padding: '4px 10px' }}
                          onClick={() => handleHumanReview(false)}
                          disabled={!isAtCurrentStage}
                        >
                          <XCircle size={13} style={{ color: 'var(--color-error)' }} /> 驳回
                        </button>
                      </div>
                    )}

                    {/* Sidecar graph execution progress (tauri mode only) */}
                    {graphRt.available && graphExec && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px', background: 'var(--bg-secondary)', fontSize: '12px' }}>
                        {graphExec.status === 'running' && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-progress)' }} />}
                        {graphExec.status === 'completed' && <CheckCircle2 size={14} style={{ color: 'var(--color-success)' }} />}
                        {graphExec.status === 'error' && <XCircle size={14} style={{ color: 'var(--color-error)' }} />}
                        {graphExec.status === 'interrupted' && <AlertCircle size={14} style={{ color: 'var(--color-human-review)' }} />}
                        <span style={{ color: 'var(--fg-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {graphExec.status === 'running' && `执行引擎运行中${graphExec.stage ? `：${graphExec.stage}` : ''}${graphExec.streamText ? ` · ${graphExec.streamText}` : ''}`}
                          {graphExec.status === 'interrupted' && `执行已在门禁处暂停${graphExec.next?.length ? `（待执行：${graphExec.next.join(', ')}）` : ''}`}
                          {graphExec.status === 'completed' && '执行引擎已完成全部阶段'}
                          {graphExec.status === 'error' && `执行失败：${graphExec.error}`}
                        </span>
                        {graphExec.status === 'interrupted' && (
                          <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px', flexShrink: 0 }} onClick={handleGraphAdvance}>
                            从断点继续
                          </button>
                        )}
                      </div>
                    )}

                    {/* ─── Delegate / manual execution panel (Phase 4) ─── */}
                    <DelegatePanel
                      available={graphRt.available}
                      sidecar={sidecarApi}
                      graphRt={graphRt}
                      graphExec={graphExec}
                      project={currentProject}
                      delivery={selectedDelivery}
                      stage={activeStage}
                      upstreamDeliverables={(() => {
                        const map = {}
                        projectStages.slice(0, activeStageIndex).forEach(st => {
                          const d = getDeliverableData(st.id)
                          if (d?.content) map[st.id] = { content: d.content }
                        })
                        return map
                      })()}
                      mcpServers={collectAgentMcpServers(findStageAgent(agents, getFlowNode(currentProject.id, activeStage?.id)))}
                      allowedTools={collectAllowedTools(findStageAgent(agents, getFlowNode(currentProject.id, activeStage?.id)))}
                      modelConfig={(() => {
                        const m = getActiveModel() || getCustomModels().find(mm => mm.enabled && mm.apiKey)
                        return m ? { endpoint: m.endpoint, apiKey: m.apiKey, modelId: m.modelId } : null
                      })()}
                      dag={getProjectDAG(currentProject)}
                      onStartBuiltin={handleGraphAdvance}
                      onImported={(content) => {
                        if (selectedDelivery && activeStage) saveStageDeliverable(selectedDelivery.id, activeStage.id, content)
                      }}
                      showToast={showToast}
                    />

                    {/* ── 执行控制中心：引擎状态 + 门禁确认 + Agent 轨迹 ── */}
                    {(graphExec || reviewRejection) && (
                      <div className="delivery-exec-center" style={{
                        border: '1px solid var(--border-color)',
                        borderRadius: 'var(--radius-lg, 10px)',
                        background: 'var(--bg-secondary)',
                        padding: '12px 14px',
                        display: 'flex', flexDirection: 'column', gap: 10,
                      }}>
                        {/* 状态行 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Zap size={14} style={{ color: 'var(--color-progress)' }} />
                          <span style={{ fontWeight: 600, fontSize: 13 }}>执行引擎</span>
                          {graphExec?.status === 'running' && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--fg-secondary)', fontSize: 12 }}>
                              <Loader2 size={12} className="animate-spin" />
                              正在执行「{graphExec.stage || '准备中'}」{graphExec.lastTool ? ` · 调用 ${graphExec.lastTool}` : ''}
                            </span>
                          )}
                          {graphExec?.status === 'interrupted' && <span style={{ color: 'var(--color-human-review)', fontSize: 12 }}>已暂停，等待人工确认</span>}
                          {graphExec?.status === 'completed' && <span style={{ color: 'var(--color-success)', fontSize: 12 }}>全链路完成</span>}
                          {graphExec?.status === 'error' && <span style={{ color: 'var(--color-error)', fontSize: 12 }}>错误：{graphExec.error || '未知'}</span>}
                          {typeof graphExec?.lastScore === 'number' && (
                            <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>上阶段评审 {graphExec.lastScore} 分</span>
                          )}
                          <span style={{ flex: 1 }} />
                          {graphExec?.status === 'running' && (
                            <button className="btn btn-secondary" style={{ padding: '2px 10px', fontSize: 12 }} onClick={handleAbortRun}>
                              <XCircle size={12} /> 中止
                            </button>
                          )}
                          {graphExec?.status === 'error' && (
                            <button className="btn btn-secondary" style={{ padding: '2px 10px', fontSize: 12 }} onClick={handleGraphAdvance}>
                              重新启动
                            </button>
                          )}
                        </div>

                        {/* 实时流式输出摘要 */}
                        {graphExec?.status === 'running' && graphExec.streamText && (
                          <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            …{graphExec.streamText.slice(-160)}
                          </div>
                        )}

                        {/* 门禁确认卡片：门禁前人工确认 */}
                        {gateInterrupt?.kind === 'review-gate' && (
                          <div style={{ border: '1px solid var(--color-human-review)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <Shield size={16} style={{ color: 'var(--color-human-review)' }} />
                            <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
                              <div style={{ fontWeight: 600 }}>门禁待确认：「{gateInterrupt.prevStage || '上一阶段'}」已产出</div>
                              <div style={{ color: 'var(--fg-tertiary)', fontSize: 12, marginTop: 2 }}>
                                确认后将进入「{gateInterrupt.stage}」执行 AI 评审；也可先人工评审后再放行
                              </div>
                            </div>
                            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={handleGateConfirm}>
                              <Check size={12} /> 确认进入评审
                            </button>
                            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => handleGateHumanReview(true)}>
                              人工通过并放行
                            </button>
                            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => handleGateHumanReview(false)}>
                              人工驳回
                            </button>
                          </div>
                        )}
                        {gateInterrupt?.kind === 'delegate' && (
                          <div style={{ border: '1px dashed var(--border-color)', borderRadius: 8, padding: '10px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
                            <FileUp size={16} style={{ color: 'var(--fg-secondary)' }} />
                            <span>「{gateInterrupt.stage}」阶段等待外部交付物 — 请在下方外派面板导入产出，引擎将自动继续</span>
                          </div>
                        )}

                        {/* 评审驳回通知条 */}
                        {reviewRejection && graphExec?.status !== 'interrupted' && (
                          <div style={{ border: '1px solid var(--color-error)', borderRadius: 8, padding: '10px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <AlertCircle size={16} style={{ color: 'var(--color-error)' }} />
                            <span style={{ flex: 1 }}>
                              评审驳回：得分 {reviewRejection.score} 低于阈值 {reviewRejection.threshold}，
                              已退回「{reviewRejection.retryTarget}」重做（第 {reviewRejection.retryCount + 1} 次，上限 3 次）
                            </span>
                            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={handleAbortRun}>
                              中止自动重试
                            </button>
                          </div>
                        )}

                        {/* Agent 轨迹：工具调用序列 */}
                        {toolLog.length > 0 && (
                          <details style={{ fontSize: 12 }}>
                            <summary style={{ cursor: 'pointer', color: 'var(--fg-secondary)', userSelect: 'none' }}>
                              Agent 轨迹（{toolLog.length} 次工具调用）
                            </summary>
                            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                              {toolLog.map((t, i) => (
                                <div key={i} style={{ display: 'flex', gap: 8, color: 'var(--fg-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
                                  <span style={{ color: 'var(--fg-muted)' }}>#{t.round}</span>
                                  <span style={{ color: 'var(--color-progress)', minWidth: 120 }}>{t.tool}</span>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {typeof t.args === 'string' ? t.args.slice(0, 80) : JSON.stringify(t.args).slice(0, 80)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    )}

                    {/* Advance Bar */}
                    <div className="delivery-advance-bar">
                      <div className="delivery-gate-status">
                        {stageGate?.aiReview && (
                          <div className="delivery-gate-status-item">
                            <span style={{ color: 'var(--fg-tertiary)' }}>AI评审：</span>
                            {aiReviewStatus === 'passed' && <span className="gate-passed">✓ 已通过</span>}
                            {aiReviewStatus === 'failed' && <span className="gate-failed">✗ 未通过</span>}
                            {aiReviewStatus === 'pending' && <span className="gate-pending">— 待评审</span>}
                          </div>
                        )}
                        {hasHumanReviewGate && (
                          <div className="delivery-gate-status-item">
                            <span style={{ color: 'var(--fg-tertiary)' }}>人工评审：</span>
                            {humanReviewStatus === 'passed' && <span className="gate-passed">✓ 已通过</span>}
                            {humanReviewStatus === 'failed' && <span className="gate-failed">✗ 已驳回</span>}
                            {humanReviewStatus === 'pending' && <span className="gate-pending">— 待评审</span>}
                          </div>
                        )}
                      </div>
                      {/* 交付完成后的显式推送（绝不自动推送） */}
                      {isAtLastStage && selectedDelivery.gitBranch && (
                        <button
                          className="btn btn-secondary"
                          onClick={handlePushBranch}
                          disabled={pushingBranch}
                          title={`推送 ${selectedDelivery.gitBranch} 到远程仓库`}
                        >
                          {pushingBranch ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
                          {pushingBranch ? '推送中' : '推送分支'}
                        </button>
                      )}
                      <button
                        className="btn btn-primary"
                        onClick={handleAdvance}
                        disabled={!canAdvance}
                        title={!isAtCurrentStage ? '请回到当前阶段' : isAtLastStage ? '已完成所有阶段' : !canAdvance ? '门禁未通过' : '推进到下一阶段'}
                      >
                        <Send size={14} aria-hidden="true" />
                        {isAtLastStage ? '已交付' : '推进到下一阶段'}
                      </button>
                    </div>
                  </div>
                )}

                {/* ═══ Tab: 交付追溯 ═══ */}
                {detailTab === 'traceability' && (
                  <div className="traceability-panel">
                    <div className="traceability-header">
                      <h4 className="traceability-title">交付物追溯链</h4>
                    </div>

                    {/* Stats bar */}
                    {traceabilityData && (() => {
                      const linked = traceabilityData.filter(d => d.linked).length
                      const total = traceabilityData.length
                      return (
                        <div className="traceability-stats">
                          <span className="traceability-stat">
                            <CircleDot size={14} />
                            {linked}/{total} 阶段已关联
                          </span>
                        </div>
                      )
                    })()}

                    {/* Chain visualization */}
                    <div className="traceability-chain">
                      {traceabilityData && traceabilityData.map((item, idx) => (
                        <div key={item.stage} className="traceability-chain-node">
                          {/* Connector line */}
                          {idx > 0 && (
                            <div className={`traceability-connector ${item.linkedToPrev ? 'linked' : ''}`}>
                              <ArrowDown size={14} />
                            </div>
                          )}

                          {/* Node card */}
                          <div className={`traceability-node-card ${item.linked ? 'linked' : 'empty'}`}>
                            <div className="traceability-node-header">
                              <span className="traceability-node-stage" style={{ color: 'var(--accent)' }}>
                                {item.label}
                              </span>
                              {item.linked ? (
                                <span className="traceability-badge traceability-badge--linked">已产出</span>
                              ) : (
                                <span className="traceability-badge traceability-badge--empty">待产出</span>
                              )}
                            </div>

                            {item.entities.length > 0 ? (
                              <div className="traceability-entities">
                                {item.entities.map(entity => (
                                  <div key={entity.id} className="traceability-entity">
                                    <div className="traceability-entity-label">{entity.label}</div>
                                    {entity.properties.qualityScore !== undefined && entity.properties.qualityScore !== null && (
                                      <span className="traceability-quality">
                                        质量: {entity.properties.qualityScore}
                                      </span>
                                    )}
                                    {entity.relations && entity.relations.length > 0 && (
                                      <div className="traceability-entity-relations">
                                        {entity.relations.slice(0, 3).map(rel => (
                                          <span key={rel.id} className="traceability-relation-tag">
                                            {rel.relationDef?.label}: {rel.target?.label}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="traceability-empty-hint">
                                该阶段尚未产出交付物
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Quality check status */}
                    <div className="traceability-rules">
                      <h5 className="traceability-rules-title">
                        <GitFork size={14} />
                        质量检查
                      </h5>
                      <div className="traceability-rules-list">
                        {currentProject && (() => {
                          const stageEntity = activeStage && traceabilityData
                            ? traceabilityData
                                .filter(item => item.stage === activeStage.id)
                                .flatMap(item => item.entities ?? [])[0]
                            : null
                          if (!stageEntity || !traceabilityData) {
                            return <p className="traceability-rules-empty">当前阶段暂无可评估的交付物</p>
                          }
                          const rules = evaluateChainRules(traceabilityData, stageEntity.id, { flowConfig, targetStage: activeStage.id })
                          return rules.map(rule => (
                            <div key={rule.id} className={`traceability-rule-item ${rule.passed ? 'passed' : 'failed'} ${rule.type}`}>
                              <span className="traceability-rule-icon">
                                {rule.passed ? '✓' : rule.type === 'constraint' ? '✕' : '!'}
                              </span>
                              <div className="traceability-rule-content">
                                <span className="traceability-rule-label">{rule.label}</span>
                                {!rule.passed && rule.message && (
                                  <span className="traceability-rule-message">{rule.message}</span>
                                )}
                                {rule.context && rule.context.length > 0 && (
                                  <span className="traceability-rule-context">
                                    已注入 {rule.context.length} 个上游上下文
                                  </span>
                                )}
                              </div>
                            </div>
                          ))
                        })()}
                      </div>
                    </div>
                  </div>
                )}

                {/* ═══ Tab: 阶段配置 ═══ */}
                {detailTab === 'config' && (
                  <div>
                    <div style={{ marginBottom: '16px', fontSize: '12px', color: 'var(--fg-tertiary)', lineHeight: 1.5 }}>
                      此配置仅对「{activeStage.name}」环节生效，不同环节可独立配置 Skill / MCP / 规则 / 模型
                    </div>

                    {/* Delivery hint — overrides only available when a delivery is selected */}
                    {!selectedDelivery && (
                      <div style={{ marginBottom: '16px', padding: '10px 12px', background: 'color-mix(in srgb, var(--accent) 6%, var(--bg))', borderRadius: '8px', border: '1px solid color-mix(in srgb, var(--accent) 20%, var(--border))', fontSize: '12px', color: 'var(--fg-secondary)' }}>
                        请在下方选择一个交付需求后配置附加选项
                      </div>
                    )}

                    {/* Model */}
                    <div className="stage-config-section">
                      <div className="stage-config-section-title">
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Zap size={11} /> 生成模型
                          {selectedDelivery && <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', fontWeight: 510 }}>可覆盖</span>}
                        </span>
                        <Link to="/models" style={{ fontSize: '10px', color: 'var(--accent)' }}>管理模型</Link>
                      </div>
                      <div className="stage-config-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                        <select
                          className="select"
                          style={{ width: '100%', fontSize: '12px', padding: '6px 24px 6px 8px' }}
                          value={stageConfig.model || ''}
                          onChange={(e) => {
                            if (selectedDelivery) {
                              setDeliveryStageModel(selectedDelivery.id, activeStage.id, e.target.value)
                            } else {
                              updateStageConfig(currentProject.id, activeStage.id, 'model', e.target.value)
                            }
                            showToast(`模型已切换为 ${e.target.value || '默认'}`, 'success')
                          }}
                          aria-label="选择生成模型"
                        >
                          <option value="">使用默认模型</option>
                          {getCustomModels().filter(m => m.enabled).map(m => (
                            <option key={m.id} value={m.name}>{m.name}</option>
                          ))}
                        </select>
                        <div className="stage-config-item-desc">Temperature: {stageConfig.temperature ?? 0.7} · Max Tokens: {stageConfig.maxTokens ?? 4096}</div>
                      </div>
                    </div>

                    {/* Custom Prompt — only when a delivery is selected */}
                    {selectedDelivery && (
                      <div className="stage-config-section">
                        <div className="stage-config-section-title">
                          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <MessageSquare size={11} /> 自定义提示词
                          </span>
                        </div>
                        <textarea
                          style={{ width: '100%', fontSize: '12px', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-subtle)', background: 'var(--bg)', color: 'var(--fg-secondary)', resize: 'vertical', minHeight: '64px', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box' }}
                          placeholder="为此环节追加自定义提示词（覆盖管理员默认提示词）..."
                          value={stageConfig.prompt || ''}
                          onChange={(e) => setDeliveryStagePrompt(selectedDelivery.id, activeStage.id, e.target.value)}
                          aria-label="自定义提示词"
                        />
                      </div>
                    )}

                    {/* Skills / MCPs / Rules — rendered via shared helper */}
                    {renderConfigSection('skills', Sparkles, 'Skills')}
                    {renderConfigSection('mcps', Plug, 'MCP 工具')}
                    {renderConfigSection('rules', Shield, '团队规范')}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ─── Import Deliverable Dialog ─── */}
      {showImportModal && activeStage && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowImportModal(false)}
          role="presentation"
        >
          <div
            style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '560px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-deliverable-title"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="import-deliverable-title" style={{ fontSize: '16px', fontWeight: 510, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={18} style={{ color: 'var(--accent)' }} />
                导入交付物 — {activeStage.name}
              </h3>
              <button className="btn btn-ghost" onClick={() => setShowImportModal(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '16px', lineHeight: 1.6 }}>
              从其他 AI 工具（如 Workbudy、ChatGPT、Claude 等）产出的内容导入为当前阶段的交付物，导入后可继续后续流程。
            </div>

            {/* Mode tabs */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
              {[
                { key: 'file', label: '上传文件', icon: <FileUp size={13} /> },
                { key: 'paste', label: '粘贴内容', icon: <Clipboard size={13} /> },
                { key: 'path', label: '本地路径', icon: <FolderOpen size={13} /> },
              ].map(tab => (
                <button
                  key={tab.key}
                  className={`btn ${importMode === tab.key ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setImportMode(tab.key)}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* File upload mode */}
            {importMode === 'file' && (
              <div
                style={{
                  border: '2px dashed var(--border-subtle)',
                  borderRadius: '10px',
                  padding: '32px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
                onClick={() => importFileRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); importFileRef.current?.click() } }}
                role="button"
                tabIndex={0}
              >
                <FileUp size={36} style={{ color: 'var(--fg-muted)', marginBottom: '12px', opacity: 0.5 }} />
                <div style={{ fontSize: '14px', fontWeight: 510, color: 'var(--fg-secondary)', marginBottom: '6px' }}>
                  点击选择文件
                </div>
                <div style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
                  支持 .txt, .md, .json, .doc 等文本格式
                </div>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".txt,.md,.json,.doc,.docx,.csv,.xml,.html,.yaml,.yml,.text,text/*"
                  onChange={handleImportFile}
                  style={{ display: 'none' }}
                />
              </div>
            )}

            {/* Paste mode */}
            {importMode === 'paste' && (
              <div>
                <textarea
                  className="input"
                  style={{ width: '100%', minHeight: '200px', resize: 'vertical', fontSize: '13px', fontFamily: 'inherit', lineHeight: 1.6 }}
                  placeholder="粘贴从其他工具产出的交付物内容..."
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  autoFocus
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleImportText}
                    disabled={!importText.trim()}
                    style={{ opacity: importText.trim() ? 1 : 0.5 }}
                  >
                    <Upload size={14} /> 导入内容
                  </button>
                </div>
              </div>
            )}

            {/* Path mode */}
            {importMode === 'path' && (
              <div>
                <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '8px', lineHeight: 1.6 }}>
                  输入本地文件或文件夹路径，系统将记录引用关系。后续在桌面客户端中可直接打开对应文件。
                </div>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="如：/Users/username/Documents/PRD.md 或 ./deliverables/brd.txt"
                  value={importPath}
                  onChange={e => setImportPath(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleImportPath() }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleImportPath}
                    disabled={!importPath.trim()}
                    style={{ opacity: importPath.trim() ? 1 : 0.5 }}
                  >
                    <FolderOpen size={14} /> 关联文件
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Create Delivery Dialog ─── */}
      {showCreateDelivery && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={closeDeliveryDialog} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', padding: '24px', width: '520px', maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="create-delivery-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 id="create-delivery-title" style={{ fontSize: '16px', fontWeight: 510, margin: 0 }}>{editingDeliveryId ? '编辑需求' : '新建需求'}</h3>
              <button className="btn btn-ghost" onClick={closeDeliveryDialog} aria-label="关闭对话框">
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* 需求标题 */}
              <div>
                <label htmlFor="delivery-title" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  需求标题 <span style={{ color: 'var(--color-error)' }}>*</span>
                </label>
                <input
                  id="delivery-title"
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="输入需求标题"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  autoFocus
                />
              </div>

              {/* 需求描述 */}
              <div>
                <label htmlFor="delivery-desc" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  需求描述
                </label>
                <textarea
                  id="delivery-desc"
                  className="input"
                  style={{ width: '100%', minHeight: '80px', resize: 'vertical' }}
                  placeholder="描述需求详情（可选）"
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                />
              </div>

              {/* 优先级 */}
              <div>
                <label htmlFor="delivery-priority" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  优先级
                </label>
                <select
                  id="delivery-priority"
                  className="select"
                  style={{ width: '100%' }}
                  value={newPriority}
                  onChange={e => setNewPriority(e.target.value)}
                >
                  <option value="P0">P0 - 紧急</option>
                  <option value="P1">P1 - 高</option>
                  <option value="P2">P2 - 中</option>
                </select>
              </div>

              {/* 负责人 */}
              <div>
                <label htmlFor="delivery-assignee" style={{ fontSize: '13px', fontWeight: 510, display: 'block', marginBottom: '6px' }}>
                  负责人
                </label>
                <select
                  id="delivery-assignee"
                  className="select"
                  style={{ width: '100%' }}
                  value={newAssignee}
                  onChange={e => setNewAssignee(e.target.value)}
                >
                  <option value="">未分配</option>
                  {(currentProject.members || []).map(member => (
                    <option key={member} value={member}>{member}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
              <button className="btn btn-secondary" onClick={closeDeliveryDialog}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateDelivery}
                disabled={!newTitle.trim()}
                style={{ opacity: newTitle.trim() ? 1 : 0.5 }}
              >
                {editingDeliveryId ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Fullscreen Deliverable View ─── */}
      {viewDeliverable && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setViewDeliverable(null)} role="presentation">
          <div style={{
            background: 'var(--bg)', borderRadius: '12px', padding: '0',
            width: '900px', maxWidth: '95vw', maxHeight: '85vh',
            border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
            display: 'flex', flexDirection: 'column'
          }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${viewDeliverable.name} 完整内容`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ fontSize: '16px' }}>{viewDeliverable.name} - 交付物</h3>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn btn-secondary" onClick={() => copyContent(viewDeliverable.content)}>
                  <Copy size={14} /> 复制
                </button>
                <button className="btn btn-secondary" onClick={() => downloadContent(viewDeliverable.content, viewDeliverable.name)}>
                  <Download size={14} /> 下载
                </button>
                <button className="btn btn-ghost" onClick={() => setViewDeliverable(null)} aria-label="关闭">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div style={{
              flex: 1, overflow: 'auto', padding: '20px 24px',
              fontSize: '14px', lineHeight: '1.8', color: 'var(--fg-secondary)',
              whiteSpace: 'pre-wrap', fontFamily: 'Inter, system-ui, sans-serif'
            }}>
              {viewDeliverable.content}
            </div>
          </div>
        </div>
      )}

      {/* ─── AI Chat Panel (floating, preserved integration) ─── */}
      <AiChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        currentStage={activeStage}
        projectName={currentProject.name}
        deliveryTitle={selectedDelivery?.title}
        modelOverride={stageConfig.model || null}
        projectId={currentProject.id}
        flowConfig={flowConfig}
      />
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

      {/* Spin animation */}
      {/* HTML 原型预览弹窗（iframe 内联渲染，t5） */}
      {prototypePreview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '24px' }}
          onClick={() => setPrototypePreview(null)} role="presentation">
          <div style={{ background: 'var(--bg)', borderRadius: '12px', width: '100%', maxWidth: '1100px', height: '90vh', display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="HTML 原型预览">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <LayoutTemplate size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: '14px', fontWeight: 600 }}>HTML 原型预览</span>
              {prototypePreview.path && (
                <code style={{ fontSize: '11px', color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {prototypePreview.path}
                </code>
              )}
              <div role="button" tabIndex={0} onClick={() => setPrototypePreview(null)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrototypePreview(null) } }}
                style={{ cursor: 'pointer', padding: '4px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-muted)', marginLeft: 'auto' }}>
                <X size={16} />
              </div>
            </div>
            <iframe
              title="HTML 原型"
              srcDoc={prototypePreview.html}
              sandbox="allow-scripts"
              style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }}
            />
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin {
          animation: spin 1s linear infinite;
        }
      `}</style>
    </div>
  )
}
