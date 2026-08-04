// ================================================================
//  Repository.test.js
//
//  Covers the git integration added to repository.js (pure client,
//  every service routes straight to tauri invoke):
//    - cloneRepository: git_clone invoke, default appDataDir
//      target, custom path precedence, progress relay, idempotent
//      clone, failure → error field
//    - branch services: createBranch / checkoutBranch / listBranches
//      / pushBranch / checkGitAvailable
//    - git credentials: per-host token lookup → auth param on
//      git_clone / git_push (null when unconfigured)
//    - buildFeatureBranchName slug rules
// ================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks (must precede importing the module under test) ───────

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => invokeMock(...args),
}))

let progressHandler = null
const unlistenMock = vi.fn()
const listenMock = vi.fn((event, handler) => {
  progressHandler = handler
  return Promise.resolve(unlistenMock)
})
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args) => listenMock(...args),
}))

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(() => Promise.resolve('/AppData/FlowForge')),
  join: vi.fn((...parts) => Promise.resolve(parts.join('/'))),
}))

import {
  addRepository, getRepositories, cloneRepository,
  createBranch, checkoutBranch, listBranches, pushBranch, checkGitAvailable,
  buildFeatureBranchName, GIT_CLONE_PROGRESS_EVENT,
  getRepoSource, supportsGitOps, validateLocalRepo, registerLocalRepository,
} from '@/services/repository'
import {
  addGitCredential, findCredentialForUrl, buildGitAuthForUrl, normalizeGitHost,
} from '@/services/gitCredentials'
import { storage } from '@/adapters/StorageService'

// ─── Helpers ────────────────────────────────────────────────────

function seedGitRepo(overrides = {}) {
  return addRepository({
    projectId: 'p1',
    name: 'user-service',
    type: 'git',
    gitUrl: 'https://example.com/org/user-service.git',
    branch: 'main',
    path: '',
    ...overrides,
  })
}

beforeEach(() => {
  storage.remove('flowforge_repositories')
  storage.remove('flowforge_git_credentials')
  invokeMock.mockReset()
  listenMock.mockClear()
  unlistenMock.mockClear()
  progressHandler = null
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── cloneRepository (tauri) ────────────────────────────────────

describe('cloneRepository', () => {
  it('invokes git_clone with the default appDataDir target and marks the repo ready', async () => {
    const repo = seedGitRepo()
    invokeMock.mockResolvedValue({
      repoPath: '/AppData/FlowForge/repos/p1/user-service',
      alreadyCloned: false,
    })

    const updated = await cloneRepository(repo)

    expect(invokeMock).toHaveBeenCalledWith('git_clone', {
      repoUrl: 'https://example.com/org/user-service.git',
      targetDir: '/AppData/FlowForge/repos/p1/user-service',
      branch: 'main',
      auth: null,
    })
    expect(updated.status).toBe('ready')
    expect(updated.path).toBe('/AppData/FlowForge/repos/p1/user-service')
    expect(updated.error).toBeNull()
    expect(updated.lastSync).toBeTruthy()
    expect(unlistenMock).toHaveBeenCalled()

    const stored = getRepositories('p1').find(r => r.id === repo.id)
    expect(stored.status).toBe('ready')
  })

  it('prefers a custom local path on the repo record over the default target', async () => {
    const repo = seedGitRepo({ path: '/Users/dev/custom-dir' })
    invokeMock.mockResolvedValue({ repoPath: '/Users/dev/custom-dir', alreadyCloned: false })

    await cloneRepository(repo)

    expect(invokeMock).toHaveBeenCalledWith('git_clone', expect.objectContaining({
      targetDir: '/Users/dev/custom-dir',
    }))
  })

  it('relays clone progress events for this repo only', async () => {
    const repo = seedGitRepo()
    const events = []
    invokeMock.mockImplementation(() => {
      // fire progress while the clone is "running"
      progressHandler({ payload: { repoUrl: repo.gitUrl, targetDir: '/x', phase: 'progress', percent: 42, line: 'Receiving objects: 42%' } })
      progressHandler({ payload: { repoUrl: 'https://other.repo/x.git', targetDir: '/y', phase: 'progress', percent: 99, line: 'other' } })
      progressHandler({ payload: { repoUrl: repo.gitUrl, targetDir: '/x', phase: 'done', percent: 100, line: 'done' } })
      return Promise.resolve({ repoPath: '/x', alreadyCloned: false })
    })

    await cloneRepository(repo, (p) => events.push(p))

    expect(listenMock).toHaveBeenCalledWith(GIT_CLONE_PROGRESS_EVENT, expect.any(Function))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ phase: 'progress', percent: 42 })
    expect(events[1]).toMatchObject({ phase: 'done', percent: 100 })
  })

  it('is idempotent: alreadyCloned repos still resolve to ready', async () => {
    const repo = seedGitRepo()
    invokeMock.mockResolvedValue({ repoPath: '/AppData/FlowForge/repos/p1/user-service', alreadyCloned: true })

    const updated = await cloneRepository(repo)
    expect(updated.status).toBe('ready')
    expect(updated.alreadyCloned).toBe(true)
  })

  it('writes the error field and rethrows when git_clone fails', async () => {
    const repo = seedGitRepo()
    // Rust command errors surface as "{code}: {message}" strings
    invokeMock.mockRejectedValue('E_GIT_CLONE: authentication failed')

    await expect(cloneRepository(repo)).rejects.toThrow('E_GIT_CLONE: authentication failed')

    const stored = getRepositories('p1').find(r => r.id === repo.id)
    expect(stored.status).toBe('error')
    expect(stored.error).toBe('E_GIT_CLONE: authentication failed')
    expect(unlistenMock).toHaveBeenCalled()
  })
})

// ─── Branch services ────────────────────────────────────────────

describe('branch services', () => {
  it('createBranch invokes git_create_branch with base', async () => {
    invokeMock.mockResolvedValue(true)
    await createBranch('/repo', 'feature/d1-login', 'main')
    expect(invokeMock).toHaveBeenCalledWith('git_create_branch', {
      repoPath: '/repo', newBranch: 'feature/d1-login', base: 'main',
    })
  })

  it('createBranch passes base:null when omitted', async () => {
    invokeMock.mockResolvedValue(true)
    await createBranch('/repo', 'feature/d1-login')
    expect(invokeMock).toHaveBeenCalledWith('git_create_branch', {
      repoPath: '/repo', newBranch: 'feature/d1-login', base: null,
    })
  })

  it('checkoutBranch / listBranches / pushBranch / checkGitAvailable map to their commands', async () => {
    invokeMock.mockResolvedValue(true)
    await checkoutBranch('/repo', 'dev')
    expect(invokeMock).toHaveBeenCalledWith('git_checkout_branch', { repoPath: '/repo', branch: 'dev' })

    invokeMock.mockResolvedValue({ local: ['main', 'dev'], remote: ['origin/main'], current: 'main' })
    const branches = await listBranches('/repo')
    expect(invokeMock).toHaveBeenCalledWith('git_branch_list', { repoPath: '/repo' })
    expect(branches.local).toContain('dev')

    invokeMock.mockResolvedValue('To origin: new branch')
    const pushOut = await pushBranch('/repo', 'feature/d1-x')
    expect(invokeMock).toHaveBeenCalledWith('git_push', { repoPath: '/repo', branch: 'feature/d1-x', auth: null })
    expect(pushOut).toBe('To origin: new branch')

    invokeMock.mockResolvedValue({ available: true, version: 'git version 2.44.0' })
    const probe = await checkGitAvailable()
    expect(invokeMock).toHaveBeenCalledWith('git_check_available')
    expect(probe.available).toBe(true)
  })
})

// ─── Git credentials → auth param ────────────────────────────

describe('git credentials — token auth plumbing', () => {
  const FAKE_TOKEN = 'glpat-FAKE-test-token'

  it('normalizes hosts and matches http(s) URLs only', () => {
    expect(normalizeGitHost('https://gitlab.example.com/org/repo.git')).toBe('gitlab.example.com')
    expect(normalizeGitHost('https://GitLab.Example.com:8443/grp/x.git')).toBe('gitlab.example.com:8443')
    expect(normalizeGitHost('  gitlab.example.com/ ')).toBe('gitlab.example.com')
    // scp-like SSH form: the ':' introduces a path, not a port
    expect(normalizeGitHost('git@gitlab.example.com:repo.git')).toBe('gitlab.example.com')
    expect(normalizeGitHost('git@GitLab.Example.com:Grp/Repo.git')).toBe('gitlab.example.com')
    expect(normalizeGitHost('ssh://git@gitlab.example.com/grp/repo.git')).toBe('gitlab.example.com')

    // storage and matching normalize through the same function → an SSH-style
    // input still yields a credential hit for the https URL of the same host
    addGitCredential({ host: 'git@ssh-form.example.com:grp/repo.git', token: FAKE_TOKEN })
    expect(findCredentialForUrl('https://ssh-form.example.com/org/repo.git')).toBeTruthy()

    addGitCredential({ host: 'gitlab.example.com', token: FAKE_TOKEN })
    expect(findCredentialForUrl('https://gitlab.example.com/org/repo.git')).toBeTruthy()
    expect(findCredentialForUrl('https://other.example.com/org/repo.git')).toBeNull()
    // ssh URLs never use token auth
    expect(findCredentialForUrl('git@gitlab.example.com:org/repo.git')).toBeNull()
  })

  it('buildGitAuthForUrl defaults the username to oauth2', () => {
    addGitCredential({ host: 'example.com', token: FAKE_TOKEN, username: '' })
    expect(buildGitAuthForUrl('https://example.com/org/x.git')).toEqual({
      username: 'oauth2',
      token: FAKE_TOKEN,
    })
    expect(buildGitAuthForUrl('https://none.example.com/x.git')).toBeNull()
  })

  it('cloneRepository passes the configured credential as auth', async () => {
    addGitCredential({ host: 'example.com', username: 'bot', token: FAKE_TOKEN })
    const repo = seedGitRepo()
    invokeMock.mockResolvedValue({ repoPath: '/x', alreadyCloned: false })

    await cloneRepository(repo)

    expect(invokeMock).toHaveBeenCalledWith('git_clone', expect.objectContaining({
      repoUrl: 'https://example.com/org/user-service.git',
      auth: { username: 'bot', token: FAKE_TOKEN },
    }))
  })

  it('pushBranch passes auth when the gitUrl host is configured, null otherwise', async () => {
    addGitCredential({ host: 'example.com', token: FAKE_TOKEN })
    invokeMock.mockResolvedValue('pushed')

    await pushBranch('/repo', 'feature/x', 'https://example.com/org/user-service.git')
    expect(invokeMock).toHaveBeenCalledWith('git_push', {
      repoPath: '/repo', branch: 'feature/x',
      auth: { username: 'oauth2', token: FAKE_TOKEN },
    })

    await pushBranch('/repo', 'feature/x', 'https://unknown.host/org/x.git')
    expect(invokeMock).toHaveBeenLastCalledWith('git_push', {
      repoPath: '/repo', branch: 'feature/x', auth: null,
    })

    // omitted gitUrl keeps the legacy no-auth call shape
    await pushBranch('/repo', 'feature/x')
    expect(invokeMock).toHaveBeenLastCalledWith('git_push', {
      repoPath: '/repo', branch: 'feature/x', auth: null,
    })
  })
})

// ─── Local directory reference (source: 'local') ────────────────

describe('registerLocalRepository', () => {
  it('registers a git directory as-is: ready, source local, probed branch', async () => {
    invokeMock.mockResolvedValue({
      exists: true, isDirectory: true, isGitRepo: true,
      gitRoot: '/Users/dev/wms-api', currentBranch: 'develop',
    })

    const repo = await registerLocalRepository({
      projectId: 'p1', name: 'wms-api', path: '/Users/dev/wms-api', isMain: true,
    })

    expect(invokeMock).toHaveBeenCalledWith('validate_local_repo', { path: '/Users/dev/wms-api' })
    expect(repo).toMatchObject({
      source: 'local', type: 'local', path: '/Users/dev/wms-api',
      branch: 'develop', isGitRepo: true, gitRoot: '/Users/dev/wms-api',
      status: 'ready', isMain: true, error: null,
    })
    // stored with the original path — no clone, no copy
    const stored = getRepositories('p1').find(r => r.id === repo.id)
    expect(stored.path).toBe('/Users/dev/wms-api')
    expect(stored.gitUrl).toBe('')
  })

  it('registers a plain (non-git) directory with isGitRepo:false for downstream degradation', async () => {
    invokeMock.mockResolvedValue({
      exists: true, isDirectory: true, isGitRepo: false, gitRoot: null, currentBranch: null,
    })

    const repo = await registerLocalRepository({ projectId: 'p1', name: 'docs', path: '/Users/dev/docs' })

    expect(repo.isGitRepo).toBe(false)
    expect(repo.branch).toBe('main')
    expect(repo.status).toBe('ready')
    expect(supportsGitOps(repo)).toBe(false)
  })

  it('rejects a missing path', async () => {
    invokeMock.mockResolvedValue({ exists: false, isDirectory: false, isGitRepo: false })
    await expect(registerLocalRepository({ projectId: 'p1', name: 'x', path: '/no/such/dir' }))
      .rejects.toThrow('路径不存在')
    expect(getRepositories('p1')).toHaveLength(0)
  })

  it('rejects a file path', async () => {
    invokeMock.mockResolvedValue({ exists: true, isDirectory: false, isGitRepo: false })
    await expect(registerLocalRepository({ projectId: 'p1', name: 'x', path: '/etc/hosts' }))
      .rejects.toThrow('路径不是目录')
  })
})

describe('getRepoSource / supportsGitOps — backward compatibility', () => {
  it('treats records without a source field as clone', () => {
    expect(getRepoSource({ id: 'r1', type: 'git' })).toBe('clone')
    expect(getRepoSource({ id: 'r2', source: 'clone' })).toBe('clone')
    expect(getRepoSource({ id: 'r3', source: 'local' })).toBe('local')
  })

  it('supportsGitOps degrades only local non-git references', () => {
    expect(supportsGitOps(null)).toBe(false)
    expect(supportsGitOps({ id: 'r1' })).toBe(true)                                  // legacy clone
    expect(supportsGitOps({ id: 'r2', source: 'local', isGitRepo: true })).toBe(true) // local git repo
    expect(supportsGitOps({ id: 'r3', source: 'local', isGitRepo: false })).toBe(false)
    expect(supportsGitOps({ id: 'r4', source: 'local' })).toBe(true)                  // unknown → optimistic
  })
})

// ─── buildFeatureBranchName ─────────────────────────────────────

describe('buildFeatureBranchName', () => {
  it('builds feature/{deliveryId}-{slug} from safe lowered titles', () => {
    expect(buildFeatureBranchName('d123', 'Add Login Flow!')).toBe('feature/d123-add-login-flow')
    expect(buildFeatureBranchName('d1', 'V2 升级 API')).toBe('feature/d1-v2-api')
  })

  it('falls back to feature/{deliveryId} when no safe slug remains', () => {
    expect(buildFeatureBranchName('d9', '智能客服引擎')).toBe('feature/d9')
    expect(buildFeatureBranchName('d9', '')).toBe('feature/d9')
  })

  it('truncates long slugs and never ends with a hyphen', () => {
    const name = buildFeatureBranchName('d2', 'a'.repeat(60) + ' tail')
    expect(name.length).toBeLessThanOrEqual('feature/d2-'.length + 24)
    expect(name.endsWith('-')).toBe(false)
  })
})
