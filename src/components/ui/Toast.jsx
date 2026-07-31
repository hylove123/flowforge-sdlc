import React, { useEffect } from 'react'
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react'
import { useApp } from '@/context/AppContext'

export default function Toast() {
  const { toasts, removeToast } = useApp()

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onClose, ...qoderProps }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000)
    return () => clearTimeout(timer)
  }, [onClose])

  const icons = {
    success: <CheckCircle size={16} aria-hidden="true" />,
    error: <AlertCircle size={16} aria-hidden="true" />,
    info: <Info size={16} aria-hidden="true" />,
  }

  return (
    <div className={[(`toast toast--${toast.type}`), qoderProps?.className].filter(Boolean).join(" ")} role="alert" style={qoderProps?.style} data-qoder-id={qoderProps?.["data-qoder-id"]} data-qoder-source={qoderProps?.["data-qoder-source"]}>
      <span className="toast__icon">{icons[toast.type] || icons.info}</span>
      <span className="toast__message">{toast.message}</span>
      <button className="toast__close" onClick={onClose} aria-label="关闭通知">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
