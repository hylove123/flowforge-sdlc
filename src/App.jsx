import React, { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
import { checkForUpdate } from '@/services/appUpdater'
import TopBar from '@/components/TopBar'
import Sidebar from '@/components/Sidebar'
import CommandPalette from '@/components/CommandPalette'
import NotificationBridge from '@/components/NotificationBridge'
import Toast from '@/components/ui/Toast'
import Dashboard from '@/pages/Dashboard'
import Projects from '@/pages/Projects'
import Pipeline from '@/pages/Pipeline'
import Agents from '@/pages/Agents'
import KnowledgeBase from '@/pages/KnowledgeBase'
import ModelConfig from '@/pages/ModelConfig'
import FlowEditor from '@/pages/FlowEditor'
import Settings from '@/pages/Settings'

function StartupUpdateCheck() {
  const { showToast } = useApp()
  useEffect(() => {
    let cancelled = false
    // 启动后延迟静默检查更新（仅桌面端可用）；端点不可达时静默忽略
    const timer = setTimeout(async () => {
      try {
        const upd = await checkForUpdate()
        if (!cancelled && upd) {
          showToast(`发现新版本 v${upd.version}，请前往「设置 → 关于与更新」安装`, 'info')
        }
      } catch { /* 更新服务不可达 — 不打扰用户 */ }
    }, 3000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [showToast])
  return null
}

function Layout({ children }) {
  return (
    <div className="app-layout">
      {/* Phase 6 体验打磨: Cmd+K 面板 + 系统通知桥（均为全局单例） */}
      <CommandPalette />
      <NotificationBridge />
      <StartupUpdateCheck />
      {/* 全局 Toast 出口：让所有页面的 showToast 可见 */}
      <Toast />
      <Sidebar />
      <div className="main-area">
        <TopBar />
        <div className="page-content" id="main-content">
          {children}
        </div>
      </div>
    </div>
  )
}

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/knowledge" element={<KnowledgeBase />} />
        <Route path="/models" element={<ModelConfig />} />
        <Route path="/flow-editor" element={<FlowEditor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

export default App
