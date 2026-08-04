/**
 * NotificationBridge — forwards sidecar/delegate events to system notifications
 *
 * Listens (tauri mode only) for:
 *   graph/completed      → 「交付完成」
 *   graph/interrupted    → 「门禁待审批」
 *   graph/stage_done     → 「阶段完成」toast（3.1 全局感知执行进度）
 *   graph/review_rejected→ 「评审驳回」toast
 *   delegate://received  → 「外派产出已回收」
 * and calls the Rust `notify_user` command (tauri-plugin-notification), keeping
 * the Rust side decoupled from sidecar event semantics. Renders nothing.
 */

import { useEffect } from 'react'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { useSidecar } from '@/context/SidecarContext'
import { useApp } from '@/context/AppContext'
import { SIDECAR_EVENT } from '@/adapters/SidecarBridge'

export default function NotificationBridge() {
  const sidecar = useSidecar()
  const { showToast } = useApp()

  useEffect(() => {
    if (sidecar.mode !== 'tauri') return undefined

    const notify = (title, body) => {
      tauriInvoke('notify_user', { title, body }).catch(() => { /* notification is best-effort */ })
    }

    const offSidecar = sidecar.onEvent(SIDECAR_EVENT, (payload) => {
      const params = payload?.params || {}
      if (payload?.method === 'graph/completed') {
        notify('交付完成', `交付 ${params.deliveryId || params.threadId || ''} 的全部阶段已执行完毕`)
      } else if (payload?.method === 'graph/interrupted') {
        const next = Array.isArray(params.next) ? params.next.join('、') : (params.stage || '')
        notify('门禁待审批', next ? `阶段「${next}」等待人工审批` : '有阶段等待人工审批')
      } else if (payload?.method === 'graph/stage_done') {
        // 3.1 全局事件监听：任意页面都能看到阶段完成进度
        const score = typeof params.reviewScore === 'number' ? `（${params.reviewScore} 分）` : ''
        showToast(`阶段「${params.stage || ''}」已完成${score}`, params.passed === false ? 'warning' : 'success')
      } else if (payload?.method === 'graph/review_rejected') {
        showToast(`评审驳回：得分 ${params.score ?? '—'} 未达阈值 ${params.threshold ?? '—'}，正在自动重试`, 'warning')
      }
    })

    const offs = []
    tauriListen('delegate://received', (event) => {
      const count = Array.isArray(event.payload?.files) ? event.payload.files.length : 0
      notify('外派产出已回收', count ? `已回收 ${count} 个文件，请回到应用预览确认` : '外派产出已回收，请回到应用预览确认')
    }).then((un) => offs.push(un)).catch(() => { /* not fatal outside tauri runtime */ })

    return () => {
      offSidecar()
      offs.forEach((un) => { try { un() } catch { /* noop */ } })
    }
  }, [sidecar, showToast])

  return null
}
