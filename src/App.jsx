import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/context/AppContext'
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
import ProjectConfig from '@/pages/ProjectConfig'
import FlowEditor from '@/pages/FlowEditor'
import Settings from '@/pages/Settings'
import Login from '@/pages/Login'

function Layout({ children }) {
  return (
    <div className="app-layout">
      {/* Phase 6 体验打磨: Cmd+K 面板 + 系统通知桥（均为全局单例） */}
      <CommandPalette />
      <NotificationBridge />
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
  const { currentUser, isAuthenticated } = useApp()

  if (!isAuthenticated) {
    return <Login />
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/knowledge" element={<KnowledgeBase />} />
        <Route path="/models" element={<ModelConfig />} />
        <Route path="/project-config" element={<ProjectConfig />} />
        <Route path="/flow-editor" element={<FlowEditor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

export default App
