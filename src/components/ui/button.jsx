import React from 'react'
import clsx from 'clsx'

const variants = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  ghost: 'btn btn-ghost',
}

const sizes = {
  sm: 'text-xs px-2 py-1',
  md: 'text-sm px-4 py-2',
  lg: 'text-sm px-6 py-3',
}

export function Button({ children, variant = 'secondary', size = 'md', className, ...props }) {
  return (
    <button
      className={clsx(variants[variant], sizes[size], className)}
      {...props}
    >
      {children}
    </button>
  )
}
