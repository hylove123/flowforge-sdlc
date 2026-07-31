import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppProvider } from '@/context/AppContext'
import { SidecarProvider } from '@/context/SidecarContext'
import { storage } from '@/adapters/StorageService'
import App from './App.jsx'
import './styles.css'

/**
 * Gate rendering on storage readiness (Phase 2a). Web mode is ready
 * synchronously so nothing changes there; tauri mode waits for the
 * SQLite cache hydration (and, on first launch, the legacy migration)
 * before the app tree — and its sync storage reads — mounts.
 */
function StorageGate({ children }) {
  const [ready, setReady] = useState(storage.isReady)

  useEffect(() => {
    if (!ready) {
      let cancelled = false
      storage.ready().then(() => { if (!cancelled) setReady(true) })
      return () => { cancelled = true }
    }
    return undefined
  }, [ready])

  if (!ready) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--fg-tertiary, #888)', fontSize: '13px', fontFamily: 'inherit',
      }}>
        正在加载本地数据…
      </div>
    )
  }
  return children
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <StorageGate>
      <BrowserRouter>
        <SidecarProvider>
          <AppProvider>
            <App />
          </AppProvider>
        </SidecarProvider>
      </BrowserRouter>
    </StorageGate>
  </React.StrictMode>
)
