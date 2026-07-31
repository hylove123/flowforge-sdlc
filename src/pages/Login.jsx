import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles, LogIn, UserPlus, Monitor } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { detectRuntimeMode } from '@/adapters/StorageService'

const roles = [
  '产品经理',
  '架构师',
  '开发工程师',
  '测试工程师',
  '解决方案',
  '运维工程师',
]

export default function Login() {
  const { users, login, addUser, showToast } = useApp()
  const navigate = useNavigate()

  const [mode, setMode] = useState('login')

  // Login fields
  const [loginId, setLoginId] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)

  // Register fields
  const [regName, setRegName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regRole, setRegRole] = useState(roles[0])
  const [regPassword, setRegPassword] = useState('')
  const [regConfirm, setRegConfirm] = useState('')

  // Errors
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')

  // tauri (desktop) mode: the only account is the local workspace user —
  // offer one-click re-entry so logging out never locks the app.
  // web mode keeps the seed-user login flow untouched (protects e2e).
  const isTauri = detectRuntimeMode() === 'tauri'
  const localUser = isTauri ? users[0] : null

  function handleQuickLogin() {
    if (!localUser) return
    login(localUser)
    showToast('欢迎回来，' + localUser.name, 'success')
    navigate('/')
  }

  function handleLogin(e) {
    e.preventDefault()
    setErrors({})
    setFormError('')

    const trimmedId = loginId.trim()
    if (!trimmedId) {
      setErrors({ loginId: '请输入用户名或邮箱' })
      return
    }
    if (!loginPassword) {
      setErrors({ loginPassword: '请输入密码' })
      return
    }

    const user = users.find(
      (u) => u.name === trimmedId || u.email === trimmedId
    )

    if (!user) {
      setFormError('用户名或密码错误')
      return
    }

    login(user)
    showToast('欢迎回来，' + user.name, 'success')
    navigate('/')
  }

  function handleRegister(e) {
    e.preventDefault()
    setErrors({})
    setFormError('')

    const newErrors = {}
    if (!regName.trim()) newErrors.regName = '请输入姓名'
    if (!regEmail.trim()) newErrors.regEmail = '请输入邮箱'
    if (!regPassword) newErrors.regPassword = '请输入密码'
    if (!regConfirm) newErrors.regConfirm = '请确认密码'
    if (regPassword && regConfirm && regPassword !== regConfirm) {
      newErrors.regConfirm = '两次输入的密码不一致'
    }
    if (regEmail.trim() && users.some((u) => u.email === regEmail.trim())) {
      newErrors.regEmail = '该邮箱已被注册'
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    const newUser = {
      id: 'u' + Date.now(),
      name: regName.trim(),
      role: regRole,
      roleTag: regRole.slice(0, 2),
      avatarInitial: regName.trim().charAt(0),
      email: regEmail.trim(),
      password: '(demo)',
    }

    addUser(newUser)
    login(newUser)
    showToast('注册成功，欢迎 ' + newUser.name, 'success')
    navigate('/')
  }

  const switchMode = (next) => {
    setMode(next)
    setErrors({})
    setFormError('')
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* Brand */}
        <div style={styles.brandWrap}>
          <div style={styles.logoCircle}>
            <Sparkles size={24} color="white" />
          </div>
          <h1 style={styles.brandTitle}>FlowForge SDLC</h1>
          <p style={styles.subtitle}>AI驱动的软件开发全生命周期平台</p>
        </div>

        {/* Form */}
        {mode === 'login' ? (
          <form onSubmit={handleLogin} noValidate>
            {formError && <div style={styles.formError}>{formError}</div>}

            {localUser && (
              <button type="button" style={styles.quickLoginBtn} onClick={handleQuickLogin}>
                <Monitor size={16} style={{ marginRight: 6 }} />
                以本地用户「{localUser.name}」进入
              </button>
            )}

            <div style={styles.field}>
              <label style={styles.label}>用户名/邮箱</label>
              <input
                className="input"
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                style={styles.input}
                placeholder="请输入用户名或邮箱"
                autoComplete="username"
              />
              {errors.loginId && <span style={styles.errorText}>{errors.loginId}</span>}
            </div>

            <div style={styles.field}>
              <label style={styles.label}>密码</label>
              <input
                className="input"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                style={styles.input}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
              {errors.loginPassword && <span style={styles.errorText}>{errors.loginPassword}</span>}
            </div>

            <div style={styles.rememberRow}>
              <label style={styles.rememberLabel}>
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  style={styles.checkbox}
                />
                记住我
              </label>
            </div>

            <button type="submit" style={styles.primaryBtn}>
              <LogIn size={16} style={{ marginRight: 6 }} />
              登录
            </button>
          </form>
        ) : (
          <form onSubmit={handleRegister} noValidate>
            {formError && <div style={styles.formError}>{formError}</div>}

            <div style={styles.field}>
              <label style={styles.label}>姓名</label>
              <input
                className="input"
                type="text"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                style={styles.input}
                placeholder="请输入姓名"
                autoComplete="name"
              />
              {errors.regName && <span style={styles.errorText}>{errors.regName}</span>}
            </div>

            <div style={styles.field}>
              <label style={styles.label}>邮箱</label>
              <input
                className="input"
                type="email"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                style={styles.input}
                placeholder="请输入邮箱"
                autoComplete="email"
              />
              {errors.regEmail && <span style={styles.errorText}>{errors.regEmail}</span>}
            </div>

            <div style={styles.field}>
              <label style={styles.label}>角色</label>
              <select
                className="input"
                value={regRole}
                onChange={(e) => setRegRole(e.target.value)}
                style={styles.input}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>密码</label>
              <input
                className="input"
                type="password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                style={styles.input}
                placeholder="请输入密码"
                autoComplete="new-password"
              />
              {errors.regPassword && <span style={styles.errorText}>{errors.regPassword}</span>}
            </div>

            <div style={styles.field}>
              <label style={styles.label}>确认密码</label>
              <input
                className="input"
                type="password"
                value={regConfirm}
                onChange={(e) => setRegConfirm(e.target.value)}
                style={styles.input}
                placeholder="请再次输入密码"
                autoComplete="new-password"
              />
              {errors.regConfirm && <span style={styles.errorText}>{errors.regConfirm}</span>}
            </div>

            <button type="submit" style={styles.primaryBtn}>
              <UserPlus size={16} style={{ marginRight: 6 }} />
              注册
            </button>
          </form>
        )}

        {/* Mode switch */}
        <div style={styles.switchWrap}>
          {mode === 'login' ? (
            <span style={styles.switchLink} onClick={() => switchMode('register')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') switchMode('register') }}>
              还没有账号？立即注册
            </span>
          ) : (
            <span style={styles.switchLink} onClick={() => switchMode('login')} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') switchMode('login') }}>
              已有账号？返回登录
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg)',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    padding: 40,
    borderRadius: 16,
    border: '1px solid var(--border)',
    boxShadow: '0 8px 40px rgba(0,0,0,0.08)',
    background: 'var(--surface)',
  },
  brandWrap: {
    textAlign: 'center',
    marginBottom: 32,
  },
  logoCircle: {
    width: 52,
    height: 52,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, var(--accent), #8b5cf6)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  brandTitle: {
    margin: 0,
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--fg)',
    letterSpacing: '-0.02em',
  },
  subtitle: {
    margin: '6px 0 0',
    fontSize: 13,
    color: 'var(--fg-tertiary)',
  },
  field: {
    marginBottom: 16,
    display: 'flex',
    flexDirection: 'column',
  },
  label: {
    fontSize: 13,
    fontWeight: 510,
    marginBottom: 6,
    color: 'var(--fg-secondary, var(--fg))',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
  },
  errorText: {
    fontSize: 12,
    color: 'var(--color-danger, #e53e3e)',
    marginTop: 4,
  },
  formError: {
    fontSize: 13,
    color: 'var(--color-danger, #e53e3e)',
    background: 'var(--color-danger-bg, rgba(229,62,62,0.08))',
    padding: '8px 12px',
    borderRadius: 8,
    marginBottom: 16,
    textAlign: 'center',
  },
  rememberRow: {
    marginBottom: 20,
  },
  rememberLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: 'var(--fg-secondary, var(--fg))',
    cursor: 'pointer',
  },
  checkbox: {
    accentColor: 'var(--accent)',
  },
  primaryBtn: {
    width: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '10px 0',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: 'var(--accent)',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  quickLoginBtn: {
    width: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '10px 0',
    marginBottom: 16,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--accent)',
    background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
    border: '1px solid var(--accent)',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  switchWrap: {
    textAlign: 'center',
    marginTop: 20,
  },
  switchLink: {
    fontSize: 13,
    color: 'var(--accent)',
    cursor: 'pointer',
  },
}
