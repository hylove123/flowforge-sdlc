/**
 * SidecarBridge — unified RPC entry point to the local sidecar
 *
 * Pure client platform: calls are always forwarded to the Rust shell
 * via `sidecar_request` (JSON-RPC over the managed sidecar process).
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'

let requestSeq = 0

function nextRequestId() {
  requestSeq += 1
  return `req_${Date.now().toString(36)}_${requestSeq}`
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

export function createSidecarBridge(_mode = 'tauri') {
  return createTauriBridge()
}

export const sidecar = createSidecarBridge()
