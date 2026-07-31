/**
 * FlywheelPanel — 知识飞轮看板区块（Phase 6）
 *
 * Data comes from the sidecar `flywheel.stats` RPC:
 *   graph 规模、qualityTrend（各阶段 reviewScore 历史）、
 *   evolutions（模板演化记录）、reuse（recall 命中/注册 近似复用率）。
 *
 * tauri + sidecar ready → live板块；web 模式 → 桌面版占位提示。
 * Empty data renders a friendly all-zero state.
 */

import React, { useCallback, useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from 'recharts'
import { Recycle, RefreshCw, Loader2, Sparkles, TrendingUp, Share2 } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { useSidecar } from '@/context/SidecarContext'

const EMPTY_STATS = {
  graph: { totalEntities: 0, totalEdges: 0, traceabilityEdges: 0, chunks: 0 },
  qualityTrend: [],
  evolutions: [],
  diffs: { total: 0, byPattern: {} },
  reuse: { recallCalls: 0, recallHits: 0, registered: 0, reuseRate: 0 },
}

function MetricCard({ label, value, sub }) {
  return (
    <div style={{ flex: 1, minWidth: '120px', padding: '12px', borderRadius: '8px', background: 'var(--bg-secondary)' }}>
      <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  )
}

export default function FlywheelPanel() {
  const { currentProject } = useApp()
  const sidecar = useSidecar()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)

  const available = sidecar.mode === 'tauri' && sidecar.isReady

  const load = useCallback(async () => {
    if (!available || !currentProject) return
    setLoading(true)
    try {
      const res = await sidecar.invoke('flywheel.stats', { projectId: currentProject.id })
      setStats({ ...EMPTY_STATS, ...(res || {}) })
    } catch {
      setStats(EMPTY_STATS)
    } finally {
      setLoading(false)
    }
  }, [available, currentProject, sidecar])

  useEffect(() => { load() }, [load])

  return (
    <div className="card" style={{ marginTop: 'var(--space-5)' }} data-testid="flywheel-panel">
      <div className="card-header">
        <h4 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Recycle size={15} aria-hidden="true" /> 知识飞轮
        </h4>
        {available && (
          <button className="btn btn-ghost" style={{ fontSize: '12px' }} onClick={load} disabled={loading}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新
          </button>
        )}
      </div>

      {!available ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
          知识飞轮需要桌面版（Tauri）且 sidecar 就绪 —— Web 模式下暂不可用
        </div>
      ) : !stats ? (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-tertiary)', fontSize: '13px' }}>
          正在加载飞轮数据…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* 图谱规模 + 复用率 cards */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <MetricCard label="图谱实体" value={stats.graph?.totalEntities ?? 0} sub={`${stats.graph?.chunks ?? 0} 个文本块`} />
            <MetricCard label="图谱关系" value={stats.graph?.totalEdges ?? 0} sub={`${stats.graph?.traceabilityEdges ?? 0} 条追溯边`} />
            <MetricCard
              label="知识复用率"
              value={`${Math.round((stats.reuse?.reuseRate ?? 0) * 100)}%`}
              sub={`召回 ${stats.reuse?.recallHits ?? 0} / 注册 ${stats.reuse?.registered ?? 0}`}
            />
            <MetricCard label="修改样本" value={stats.diffs?.total ?? 0} sub={`${stats.evolutions?.length ?? 0} 次模板演化`} />
          </div>

          {/* 质量趋势折线 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 510, marginBottom: '8px' }}>
              <TrendingUp size={13} aria-hidden="true" /> 质量趋势（AI 评审得分）
            </div>
            {(stats.qualityTrend?.length ?? 0) === 0 ? (
              <div style={{ padding: '18px', textAlign: 'center', fontSize: '12px', color: 'var(--fg-muted)', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                暂无评审数据 —— 完成一次交付阶段后这里会出现趋势曲线
              </div>
            ) : (
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <LineChart data={stats.qualityTrend.map((p, i) => ({ ...p, idx: i + 1 }))} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="stage" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(v) => [`${v} 分`, '评审得分']}
                      labelFormatter={(l) => `阶段：${l}`}
                      contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
                    />
                    <Line type="monotone" dataKey="score" stroke="var(--color-progress, #4f8cff)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* 模板演化记录 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 510, marginBottom: '8px' }}>
              <Sparkles size={13} aria-hidden="true" /> 模板演化
            </div>
            {(stats.evolutions?.length ?? 0) === 0 ? (
              <div style={{ padding: '18px', textAlign: 'center', fontSize: '12px', color: 'var(--fg-muted)', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                暂无演化记录 —— 同类修改模式累计超过 3 次后将自动触发模板演化建议
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {stats.evolutions.slice(0, 5).map((ev) => (
                  <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', background: 'var(--bg-secondary)', fontSize: '12px' }}>
                    <Share2 size={12} style={{ color: 'var(--color-progress)', flexShrink: 0 }} aria-hidden="true" />
                    <span style={{ fontWeight: 510, flexShrink: 0 }}>{ev.stageId}</span>
                    <span style={{ color: 'var(--fg-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ev.suggestion}>
                      {ev.patternLabel || ev.pattern} × {ev.occurrences} —— {ev.suggestion}
                    </span>
                    <span style={{ color: 'var(--fg-muted)', fontSize: '11px', flexShrink: 0 }}>
                      {ev.createdAt ? new Date(ev.createdAt).toLocaleDateString() : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
