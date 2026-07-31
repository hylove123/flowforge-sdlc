import React from 'react'
import { useApp } from '@/context/AppContext'

export default function ConfigScopeBanner() {
  const { currentProject } = useApp()

  return (
    <div className="config-scope-banner" role="status" aria-label="当前配置作用域">
      <span className="config-scope-dot" aria-hidden="true" />
      <span className="config-scope-text">
        当前配置：<strong>{currentProject.name}</strong>
      </span>
    </div>
  )
}
