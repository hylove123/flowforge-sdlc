/**
 * Graph Runtime client — thin wrapper over the sidecar's graph.* RPC surface
 *
 * Phase 2b: the LangGraph.js execution engine lives in the Node sidecar.
 * This module adapts SidecarContext/SidecarBridge for the Pipeline page:
 *   - tauri mode + sidecar ready  → real graph.start_delivery / graph.continue
 *   - web mode (or sidecar down)  → available:false, calls report not-available
 *
 * Events (JSON-RPC notifications re-emitted as `sidecar://event`):
 *   graph/stream · graph/stage_start · graph/stage_done ·
 *   graph/interrupted · graph/completed · graph/error · graph/review_rejected
 */

import { SIDECAR_EVENT } from '@/adapters/SidecarBridge'

const NOT_AVAILABLE = { ok: false, error: 'graph_runtime_not_available' }

/**
 * Builds a runtime facade from a sidecar API ({ mode, isReady, invoke, onEvent }),
 * typically the value of useSidecar().
 */
export function createGraphRuntime(sidecarApi) {
  const available = Boolean(sidecarApi && sidecarApi.mode === 'tauri' && sidecarApi.isReady)

  if (!available) {
    return {
      available: false,
      startDelivery: async () => NOT_AVAILABLE,
      continueDelivery: async () => NOT_AVAILABLE,
      getState: async () => NOT_AVAILABLE,
      abort: async () => NOT_AVAILABLE,
      onGraphEvent: () => () => {},
    }
  }

  return {
    available: true,

    /**
     * { projectId, deliveryId, dag?, modelConfig, executionMode?, projectName?, requirement? }
     * → { threadId }
     */
    startDelivery(params) {
      return sidecarApi.invoke('graph.start_delivery', params)
    },

    /** Resume after a gate interrupt; resumeValue injects a manual deliverable. */
    continueDelivery(threadId, resumeValue) {
      const params = { threadId }
      if (resumeValue !== undefined && resumeValue !== null) params.resumeValue = resumeValue
      return sidecarApi.invoke('graph.continue', params)
    },

    getState(threadId) {
      return sidecarApi.invoke('graph.get_state', { threadId })
    },

    abort(threadId) {
      return sidecarApi.invoke('graph.abort', { threadId })
    },

    /** Subscribes to graph/* notifications only; returns an unsubscribe fn. */
    onGraphEvent(handler) {
      return sidecarApi.onEvent(SIDECAR_EVENT, (payload) => {
        if (payload && typeof payload.method === 'string' && payload.method.startsWith('graph/')) {
          handler(payload)
        }
      })
    },
  }
}
