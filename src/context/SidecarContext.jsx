/**
 * SidecarContext — React access point for the local sidecar
 *
 * Wraps SidecarBridge and exposes:
 *   - isReady: true once a ping round-trip succeeded (tauri mode only)
 *   - error:   last startup/probe error (never set in web mode)
 *   - invoke / onEvent: pass-throughs to the bridge
 *
 * Web mode degrades silently: isReady stays false, error stays null,
 * and invoke keeps returning the bridge's mocked responses.
 */

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { sidecar, SIDECAR_EVENT } from '@/adapters/SidecarBridge'

const PROBE_ATTEMPTS = 5
const PROBE_INTERVAL_MS = 2000

const SidecarContext = createContext({
  mode: 'web',
  isReady: false,
  error: null,
  invoke: async () => ({ ok: false, error: 'sidecar_provider_missing' }),
  onEvent: () => () => {},
})

export function SidecarProvider({ children, bridge = sidecar }) {
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    // web mode: silent no-op — the sidecar simply isn't there
    if (bridge.mode !== 'tauri') return undefined

    cancelledRef.current = false

    // the sidecar announces itself when it (re)starts — flip ready early
    const offReady = bridge.onEvent(SIDECAR_EVENT, (payload) => {
      if (cancelledRef.current) return
      if (payload?.method === 'sidecar/ready') {
        setIsReady(true)
        setError(null)
      } else if (payload?.method === 'sidecar/failed') {
        setIsReady(false)
        setError('sidecar failed to start')
      }
    })

    // ping probe with retries (the sidecar process may still be booting)
    ;(async () => {
      for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
        try {
          const res = await bridge.invoke('ping')
          if (cancelledRef.current) return
          if (res && res.ok) {
            setIsReady(true)
            setError(null)
            return
          }
        } catch (e) {
          if (cancelledRef.current) return
          if (attempt === PROBE_ATTEMPTS) {
            setError(e?.message || String(e))
            return
          }
        }
        await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS))
      }
    })()

    return () => {
      cancelledRef.current = true
      offReady()
    }
  }, [bridge])

  const value = useMemo(
    () => ({
      mode: bridge.mode,
      isReady,
      error,
      invoke: (method, params) => bridge.invoke(method, params),
      onEvent: (eventName, handler) => bridge.onEvent(eventName, handler),
    }),
    [bridge, isReady, error]
  )

  return <SidecarContext.Provider value={value}>{children}</SidecarContext.Provider>
}

export function useSidecar() {
  return useContext(SidecarContext)
}
