import React from 'react'

export function Toggle({ checked, onChange, label, disabled = false, size = 'md', ...qoderProps }) {
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!disabled) onChange(!checked)
    }
  }

  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      className={[(`toggle-switch toggle-switch--${size} ${checked ? 'toggle-switch--checked' : ''} ${disabled ? 'toggle-switch--disabled' : ''}`), qoderProps?.className].filter(Boolean).join(" ")}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={handleKeyDown}
     style={qoderProps?.style}>
      <div className="toggle-switch__thumb" />
    </div>
  )
}
