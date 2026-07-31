/**
 * SidecarBridge — unified RPC entry point to the (future) local sidecar
 *
 * Phase 0 of the Tauri evolution plan: establishes the single invoke()
 * call site. In web mode all calls are mocked; in tauri mode calls are
 * forwarded to the Rust shell via `sidecar_request` (Phase 1 wires the
 * actual command handler).
 */

import { detectRuntimeMode } from '@/adapters/StorageService'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

let requestSeq = 0

function nextRequestId() {
  requestSeq += 1
  return `req_${Date.now().toString(36)}_${requestSeq}`
}

// ─── Web implementation (mock) ──────────────────────────────────

function createWebBridge() {
  return {
    mode: 'web',

    async invoke(method, params = {}) {
      console.debug('[SidecarBridge:web] invoke (mocked)', method, params)
      if (method === 'ping') {
        return { ok: true, data: 'pong', mock: true }
      }
      return { ok: false, error: 'sidecar_unavailable_in_web_mode' }
    },

    /** No-op in web mode; returns an unsubscribe function for API parity */
    onEvent(eventName, handler) {
      console.debug('[SidecarBridge:web] onEvent (no-op)', eventName)
      return () => {}
    },
  }
}

// ─── Tauri implementation ───────────────────────────────────────

function createTauriBridge() {
  return {
    mode: 'tauri',

    async invoke(method, params = {}) {
      const id = nextRequestId()
      try {
        return await tauriInvoke('sidecar_request', { id, method, params })
      } catch (e) {
        if (e && e.code) throw e
        throw {
          code: 'SIDECAR_INVOKE_FAILED',
          message: e instanceof Error ? e.message : String(e),
        }
      }
    },

    /**
     * Subscribe to sidecar stream events. The Rust shell re-emits every
     * JSON-RPC notification from the sidecar as `sidecar://event` with
     * payload { method, params }; handler receives that payload.
     */
    onEvent(eventName, handler) {
      const unlistenPromise = tauriListen(eventName, (event) => handler(event.payload))
      return () => {
        unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
      }
    },
  }
}

// ─── Factory & singleton ────────────────────────────────────────

/** Name of the Tauri event carrying sidecar JSON-RPC notifications. */
export const SIDECAR_EVENT = 'sidecar://event'

export function createSidecarBridge(mode = detectRuntimeMode()) {
  return mode === 'tauri' ? createTauriBridge() : createWebBridge()
}

export const sidecar = createSidecarBridge()
