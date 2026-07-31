import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Plus, Trash2, Settings, Save,
  GripVertical, X, AlertTriangle, Zap,
  FileText, FileCheck, ClipboardList, TestTube2,
  Code2, GitMerge, Eye, Rocket, Circle
} from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { STAGE_DEFINITIONS } from '../data/stages'
import {
  buildDefaultDAG, createNodeFromStage, validateDAG,
  getParallelGroups, saveDAG, getProjectDAG, setProjectDAG,
} from '../data/flowEngine'
import NodeConfigPanel from '../components/NodeConfigPanel'

const STAGE_ICONS = {
  FileText, FileCheck, ClipboardList, TestTube2,
  Code2, GitMerge, Eye, Rocket, Circle,
}

function getStageIcon(iconName, size = 16) {
  const Icon = STAGE_ICONS[iconName] || Circle
  return <Icon size={size} />
}

function getStageDefIcon(stageId) {
  const def = STAGE_DEFINITIONS.find(s => s.id === stageId)
  return def ? def.icon : 'Circle'
}

export default function FlowEditor() {
  const { currentProject, showToast } = useApp()
  const [dag, setDag] = useState(() => getProjectDAG(currentProject))
  const [selectedNode, setSelectedNode] = useState(null)
  const [showConfig, setShowConfig] = useState(false)
  const [dragging, setDragging] = useState(null)
  const [connecting, setConnecting] = useState(null) // node id being connected from
  const [validation, setValidation] = useState(null)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const [dagName, setDagName] = useState(dag.name)
  const canvasRef = useRef(null)
  const dragOffset = useRef({ x: 0, y: 0 })

  // ─── Escape key cancels connect mode ─────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setConnecting(null)
        setShowAddMenu(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // ─── Node CRUD ──────────────────────────────────────────────
  const addNode = (stageId) => {
    const position = { x: 150 + Math.random() * 300, y: 100 + Math.random() * 200 }
    const node = createNodeFromStage(stageId, position)
    setDag(prev => ({ ...prev, nodes: [...prev.nodes, node] }))
    setShowAddMenu(false)
    setSelectedNode(node.id)
    setShowConfig(true)
  }

  const removeNode = (nodeId) => {
    setDag(prev => ({
      ...prev,
      nodes: prev.nodes
        .filter(n => n.id !== nodeId)
        .map(n => ({ ...n, dependsOn: n.dependsOn.filter(d => d !== nodeId) })),
    }))
    if (selectedNode === nodeId) {
      setSelectedNode(null)
      setShowConfig(false)
    }
  }

  const updateNode = (nodeId, updates) => {
    setDag(prev => ({
      ...prev,
      nodes: prev.nodes.map(n => n.id === nodeId ? { ...n, ...updates } : n),
    }))
  }

  const updateNodeConfig = (nodeId, configUpdates) => {
    setDag(prev => ({
      ...prev,
      nodes: prev.nodes.map(n =>
        n.id === nodeId ? { ...n, config: { ...n.config, ...configUpdates } } : n
      ),
    }))
  }

  // ─── Connections ────────────────────────────────────────────
  const addConnection = (fromId, toId) => {
    if (fromId === toId) return
    setDag(prev => ({
      ...prev,
      nodes: prev.nodes.map(n =>
        n.id === toId && !n.dependsOn.includes(fromId)
          ? { ...n, dependsOn: [...n.dependsOn, fromId] }
          : n
      ),
    }))
  }

  const removeConnection = (nodeId, depId) => {
    setDag(prev => ({
      ...prev,
      nodes: prev.nodes.map(n =>
        n.id === nodeId
          ? { ...n, dependsOn: n.dependsOn.filter(d => d !== depId) }
          : n
      ),
    }))
  }

  // ─── Drag handling ──────────────────────────────────────────
  const handleNodeMouseDown = (e, nodeId) => {
    if (e.target.closest('[data-no-drag]')) return
    const node = dag.nodes.find(n => n.id === nodeId)
    if (!node) return
    const rect = canvasRef.current.getBoundingClientRect()
    dragOffset.current = {
      x: e.clientX - rect.left - node.position.x,
      y: e.clientY - rect.top - node.position.y,
    }
    setDragging(nodeId)
    setSelectedNode(nodeId)
  }

  const handleCanvasMouseMove = useCallback((e) => {
    if (!dragging) return
    const rect = canvasRef.current.getBoundingClientRect()
    const x = Math.max(0, e.clientX - rect.left - dragOffset.current.x)
    const y = Math.max(0, e.clientY - rect.top - dragOffset.current.y)
    updateNode(dragging, { position: { x, y } })
  }, [dragging])

  const handleCanvasMouseUp = useCallback(() => {
    setDragging(null)
  }, [])

  // ─── Connect mode ───────────────────────────────────────────
  const startConnect = (nodeId) => {
    setConnecting(nodeId)
  }

  const completeConnect = (targetId) => {
    if (connecting && connecting !== targetId) {
      addConnection(connecting, targetId)
    }
    setConnecting(null)
  }

  // ─── Save & Validate ────────────────────────────────────────
  const handleSave = () => {
    const result = validateDAG(dag)
    setValidation(result)
    if (result.valid) {
      const updatedDag = { ...dag, name: dagName }
      saveDAG(updatedDag)
      if (currentProject) {
        setProjectDAG(currentProject.id, updatedDag.id)
      }
      showToast?.('流程编排已保存', 'success')
    } else {
      showToast?.(`流程校验失败：${result.errors[0]}`, 'error')
    }
  }

  const handleReset = () => {
    const defaultDag = buildDefaultDAG()
    setDag(defaultDag)
    setDagName(defaultDag.name)
    setSelectedNode(null)
    setShowConfig(false)
    setValidation(null)
    showToast?.('已重置为默认流程', 'info')
  }

  // ─── Render helpers ─────────────────────────────────────────
  const getNodeById = (id) => dag.nodes.find(n => n.id === id)
  const parallelGroups = getParallelGroups(dag.nodes)

  // SVG edges
  const edges = []
  dag.nodes.forEach(node => {
    node.dependsOn.forEach(depId => {
      const from = getNodeById(depId)
      if (!from) return
      edges.push({
        id: `${depId}->${node.id}`,
        x1: from.position.x + 80,
        y1: from.position.y + 28,
        x2: node.position.x + 80,
        y2: node.position.y + 28,
        fromId: depId,
        toId: node.id,
      })
    })
  })

  const selectedNodeData = selectedNode ? getNodeById(selectedNode) : null

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-[var(--fg)]">流程编排</h2>
          <input
            value={dagName}
            onChange={e => setDagName(e.target.value)}
            className="text-sm px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--fg)] w-48"
            placeholder="流程名称"
          />
          <span className="text-xs text-[var(--fg-muted)]">{dag.nodes.length} 个节点</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors"
          >
            重置默认
          </button>
          <button
            onClick={() => setShowAddMenu(!showAddMenu)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            <Plus size={14} /> 添加节点
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-[var(--color-success,#22c55e)] text-white hover:opacity-90 transition-opacity"
          >
            <Save size={14} /> 保存
          </button>
        </div>
      </div>

      {/* Validation errors */}
      {validation && !validation.valid && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200">
          {validation.errors.map((err, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-red-600">
              <AlertTriangle size={12} /> {err}
            </div>
          ))}
        </div>
      )}

      {/* Add node menu */}
      {showAddMenu && (
        <div className="absolute top-14 right-4 z-50 w-64 bg-[var(--bg)] border border-[var(--border)] rounded-lg shadow-lg p-2">
          <div className="text-xs font-medium text-[var(--fg-muted)] px-2 py-1 mb-1">从模板添加</div>
          {STAGE_DEFINITIONS.map(s => (
            <button
              key={s.id}
              onClick={() => addNode(s.id)}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-[var(--bg-secondary)] text-[var(--fg)] transition-colors"
            >
              <span style={{ color: s.color }}>{getStageIcon(s.icon, 14)}</span>
              {s.name}
            </button>
          ))}
          <div className="border-t border-[var(--border)] mt-1 pt-1">
            <button
              onClick={() => addNode('custom')}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-[var(--bg-secondary)] text-[var(--fg)] transition-colors"
            >
              <Circle size={14} className="text-[var(--fg-muted)]" />
              自定义节点
            </button>
          </div>
        </div>
      )}

      {/* Canvas + Config Panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* DAG Canvas */}
        <div
          ref={canvasRef}
          className="flex-1 relative overflow-auto bg-[var(--bg-secondary)]"
          style={{ backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onMouseLeave={handleCanvasMouseUp}
          onClick={(e) => {
            if (e.target === canvasRef.current) {
              setSelectedNode(null)
              setShowConfig(false)
              setConnecting(null)
            }
          }}
        >
          {/* SVG Edges */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ minWidth: 1400, minHeight: 600 }}>
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="var(--fg-muted)" />
              </marker>
            </defs>
            {edges.map(edge => (
              <g key={edge.id}>
                <path
                  d={`M ${edge.x1} ${edge.y1} C ${edge.x1 + 60} ${edge.y1}, ${edge.x2 - 60} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                  fill="none"
                  stroke="var(--fg-muted)"
                  strokeWidth="1.5"
                  strokeDasharray={connecting ? "4 2" : "none"}
                  markerEnd="url(#arrowhead)"
                  opacity={0.6}
                />
              </g>
            ))}
          </svg>

          {/* Nodes */}
          {dag.nodes.map(node => {
            const isSelected = selectedNode === node.id
            const isConnecting = connecting === node.id
            const isConnectTarget = connecting && connecting !== node.id
            const def = STAGE_DEFINITIONS.find(s => s.id === node.stageId)
            const color = def?.color || '#6b7280'
            const icon = getStageDefIcon(node.stageId)

            return (
              <div
                key={node.id}
                className={`absolute select-none cursor-grab active:cursor-grabbing group transition-shadow ${
                  isSelected ? 'ring-2 ring-[var(--accent)] shadow-lg' : 'shadow-sm hover:shadow-md'
                } ${isConnectTarget ? 'ring-2 ring-green-400' : ''}`}
                style={{
                  left: node.position.x,
                  top: node.position.y,
                  width: 160,
                  zIndex: isSelected ? 10 : 1,
                }}
                onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                onClick={(e) => {
                  e.stopPropagation()
                  if (connecting) {
                    completeConnect(node.id)
                  } else {
                    setSelectedNode(node.id)
                  }
                }}
              >
                <div className="bg-[var(--bg)] rounded-lg border border-[var(--border)] overflow-hidden">
                  {/* Node header */}
                  <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: `3px solid ${color}` }}>
                    <span style={{ color }}>{getStageIcon(icon, 14)}</span>
                    <span className="text-xs font-medium text-[var(--fg)] truncate flex-1">{node.label}</span>
                    <GripVertical size={12} className="text-[var(--fg-muted)] opacity-0 group-hover:opacity-100" />
                  </div>
                  {/* Node meta */}
                  <div className="px-3 pb-2 flex items-center gap-1 flex-wrap">
                    {node.config.gate.aiReview && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-purple-100 text-purple-700">AI评审</span>
                    )}
                    {node.config.gate.humanReview && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-blue-100 text-blue-700">人工评审</span>
                    )}
                    {node.config.agentId && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-100 text-green-700">Agent</span>
                    )}
                    {node.dependsOn.length > 0 && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600">
                        {node.dependsOn.length} 前置
                      </span>
                    )}
                  </div>
                  {/* Node actions */}
                  <div className="flex items-center border-t border-[var(--border)] px-1 py-1 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      data-no-drag
                      onClick={(e) => { e.stopPropagation(); setSelectedNode(node.id); setShowConfig(true) }}
                      className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--fg-muted)]"
                      title="配置"
                    >
                      <Settings size={12} />
                    </button>
                    <button
                      data-no-drag
                      onClick={(e) => { e.stopPropagation(); startConnect(node.id) }}
                      className={`p-1 rounded hover:bg-[var(--bg-secondary)] ${isConnecting ? 'text-green-500' : 'text-[var(--fg-muted)]'}`}
                      title="连接到..."
                    >
                      <Zap size={12} />
                    </button>
                    <button
                      data-no-drag
                      onClick={(e) => { e.stopPropagation(); removeNode(node.id) }}
                      className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600"
                      title="删除"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* Dependencies list (editable) */}
                {isSelected && node.dependsOn.length > 0 && (
                  <div className="mt-1 bg-[var(--bg)] border border-[var(--border)] rounded p-1.5" data-no-drag>
                    <div className="text-[10px] text-[var(--fg-muted)] mb-1">前置依赖：</div>
                    {node.dependsOn.map(depId => {
                      const dep = getNodeById(depId)
                      return (
                        <div key={depId} className="flex items-center gap-1 text-[10px] text-[var(--fg)]">
                          <span className="truncate flex-1">{dep?.label || depId}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeConnection(node.id, depId) }}
                            className="text-red-400 hover:text-red-600"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* Connecting hint */}
          {connecting && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-green-500 text-white text-xs rounded-full shadow">
              点击目标节点完成连接 · 按 Esc 取消
            </div>
          )}

          {/* Parallel groups indicator */}
          {parallelGroups.some(g => g.length > 1) && (
            <div className="absolute bottom-4 left-4 px-3 py-2 bg-[var(--bg)] border border-[var(--border)] rounded-lg text-xs text-[var(--fg-muted)]">
              <div className="font-medium mb-1">并行执行组：</div>
              {parallelGroups.map((group, i) => (
                group.length > 1 && (
                  <div key={i} className="flex items-center gap-1">
                    <span className="text-[var(--accent)]">∥</span>
                    {group.map(n => n.label).join(' + ')}
                  </div>
                )
              ))}
            </div>
          )}
        </div>

        {/* Config Panel */}
        {showConfig && selectedNodeData && (
          <NodeConfigPanel
            node={selectedNodeData}
            allNodes={dag.nodes}
            onUpdate={(updates) => updateNode(selectedNode, updates)}
            onUpdateConfig={(configUpdates) => updateNodeConfig(selectedNode, configUpdates)}
            onClose={() => setShowConfig(false)}
          />
        )}
      </div>
    </div>
  )
}
