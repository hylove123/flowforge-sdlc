/**
 * Repository Service — manages project code repositories
 * Supports local paths, git clone, and microservice multi-repo setups
 *
 * Pure client platform: real git via Rust commands
 * (git_clone / git_create_branch / ...)
 */

import { storage } from '@/adapters/StorageService'
import { buildGitAuthForUrl } from '@/services/gitCredentials'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { appDataDir, join as pathJoin } from '@tauri-apps/api/path'

const REPOS_KEY = 'flowforge_repositories'

/** Event channel emitted by the Rust `git_clone` command (200ms throttled). */
export const GIT_CLONE_PROGRESS_EVENT = 'git://clone_progress'

// Repository structure:
// {
//   id: string,
//   projectId: string,
//   name: string,          // display name, e.g. "user-service"
//   type: 'local' | 'git', // local path or git URL
//   source: 'local' | 'clone', // how the repo landed here: direct local
//                          // reference vs git clone. Legacy records have
//                          // no source field ⇒ treated as 'clone'.
//   path: string,          // local filesystem path
//   gitUrl: string,        // git clone URL (for type='git')
//   branch: string,        // default branch
//   isMain: boolean,       // is this the main repo in a microservice setup
//   isGitRepo: boolean,    // local reference only: dir is a git work tree
//   status: 'ready' | 'cloning' | 'error' | 'pending',
//   lastSync: string,      // ISO date of last clone/sync
//   error: string | null,  // error message if status='error'
//   indexed: boolean,      // has been indexed by codebase MCP
// }

/** Backward-compatible source read: records without the field are clones. */
export function getRepoSource(repo) {
  return repo?.source === 'local' ? 'local' : 'clone'
}

/**
 * Whether git branch/push operations make sense for this repo.
 * Local references to non-git directories degrade gracefully (the
 * delivery flow skips branch isolation instead of failing).
 */
export function supportsGitOps(repo) {
  if (!repo) return false
  return getRepoSource(repo) !== 'local' || repo.isGitRepo !== false
}

export function getRepositories(projectId) {
  const all = storage.getJSON(REPOS_KEY, []) || []
  if (!projectId) return all
  return all.filter(r => r.projectId === projectId)
}

export function saveRepositories(repos) {
  storage.setJSON(REPOS_KEY, repos)
}

export function addRepository(repo) {
  const all = getRepositories()
  const newRepo = {
    id: `repo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    indexed: false,
    branch: 'main',
    isMain: false,
    ...repo,
    createdAt: new Date().toISOString(),
  }
  all.push(newRepo)
  saveRepositories(all)
  return newRepo
}

export function updateRepository(id, updates) {
  const all = getRepositories()
  const idx = all.findIndex(r => r.id === id)
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...updates }
    saveRepositories(all)
    return all[idx]
  }
  return null
}

export function deleteRepository(id) {
  saveRepositories(getRepositories().filter(r => r.id !== id))
}

/**
 * Cascade cleanup: drop every repository record of a project
 * (used when a project is removed from the project center).
 * @returns {number} number of removed records
 */
export function removeRepositoriesForProject(projectId) {
  const all = getRepositories()
  const remaining = all.filter(r => r.projectId !== projectId)
  const removed = all.length - remaining.length
  if (removed > 0) saveRepositories(remaining)
  return removed
}

/**
 * Default clone target: appDataDir()/repos/{projectId}/{repoName}
 * Cross-platform via @tauri-apps/api path module (no hardcoded /workspace).
 */
export async function getDefaultCloneDir(repo) {
  const base = await appDataDir()
  return pathJoin(base, 'repos', repo.projectId, repo.name)
}

/**
 * Validate a local directory for direct reference.
 * Rust `validate_local_repo` → {exists, isDirectory, isGitRepo, gitRoot?, currentBranch?}
 */
export async function validateLocalRepo(path) {
  return tauriInvoke('validate_local_repo', { path })
}

/**
 * Register an existing local directory as a project repository.
 * No clone, no copy — the original path is stored as-is. The record is
 * immediately 'ready' and carries source:'local' plus the probed git
 * metadata (isGitRepo drives the branch-isolation degradation downstream).
 * Throws when the path does not exist or is not a directory.
 */
export async function registerLocalRepository({ projectId, name, path, isMain = false }) {
  const info = await validateLocalRepo(path)
  if (!info.exists) throw new Error(`路径不存在：${path}`)
  if (!info.isDirectory) throw new Error(`路径不是目录：${path}`)
  return addRepository({
    projectId,
    name,
    type: 'local',
    source: 'local',
    path,
    gitUrl: '',
    branch: info.currentBranch || 'main',
    isMain,
    isGitRepo: !!info.isGitRepo,
    gitRoot: info.gitRoot || null,
    status: 'ready',
    lastSync: new Date().toISOString(),
    error: null,
  })
}

/**
 * Clone a git repository. Invokes `git_clone`, streaming progress
 * through the `git://clone_progress` event to the optional onProgress
 * callback. A custom local path on the repo record takes precedence
 * over the default appDataDir()-based target.
 * @param {object} repo repository record
 * @param {(p: {phase: string, percent: number|null, line: string}) => void} [onProgress]
 */
export async function cloneRepository(repo, onProgress) {
  return cloneRepositoryTauri(repo, onProgress)
}

async function cloneRepositoryTauri(repo, onProgress) {
  updateRepository(repo.id, { status: 'cloning', error: null, source: 'clone' })

  // Custom local path on the record wins over the default location
  const targetDir = (repo.path && repo.path.trim())
    ? repo.path.trim()
    : await getDefaultCloneDir(repo)

  // Relay throttled clone progress for this repo only
  const unlisten = await tauriListen(GIT_CLONE_PROGRESS_EVENT, (event) => {
    const p = event?.payload
    if (!p || p.repoUrl !== repo.gitUrl) return
    if (typeof onProgress === 'function') onProgress(p)
  })

  try {
    // Per-host token from Settings → Git 凭证 (null ⇒ system credential helper)
    const result = await tauriInvoke('git_clone', {
      repoUrl: repo.gitUrl,
      targetDir,
      branch: repo.branch || null,
      auth: buildGitAuthForUrl(repo.gitUrl),
    })
    return updateRepository(repo.id, {
      status: 'ready',
      path: result.repoPath,
      lastSync: new Date().toISOString(),
      error: null,
      alreadyCloned: !!result.alreadyCloned,
    })
  } catch (e) {
    const message = typeof e === 'string' ? e : (e?.message || String(e))
    updateRepository(repo.id, { status: 'error', error: message })
    throw new Error(message)
  } finally {
    unlisten()
  }
}

// ─── Branch services (real git via the Rust shell) ──────────────

/** Create a branch without switching HEAD. */
export async function createBranch(repoPath, newBranch, base) {
  return tauriInvoke('git_create_branch', { repoPath, newBranch, base: base || null })
}

/** Checkout an existing branch. */
export async function checkoutBranch(repoPath, branch) {
  return tauriInvoke('git_checkout_branch', { repoPath, branch })
}

/** List local/remote branches and the current one. */
export async function listBranches(repoPath) {
  return tauriInvoke('git_branch_list', { repoPath })
}

/**
 * Push a branch to origin. Only ever called explicitly by the user.
 * Pass the repo's gitUrl so a configured host token can be used; the
 * Rust side pushes to the tokened URL without touching the remote.
 */
export async function pushBranch(repoPath, branch, gitUrl) {
  return tauriInvoke('git_push', { repoPath, branch, auth: buildGitAuthForUrl(gitUrl) })
}

/** Probe whether a git binary is available on this machine. */
export async function checkGitAvailable() {
  return tauriInvoke('git_check_available')
}

/**
 * Build a delivery feature branch name: feature/{deliveryId}-{slug}.
 * Slug = lowercased title, non-alphanumerics collapsed to hyphens, truncated.
 */
export function buildFeatureBranchName(deliveryId, title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/[\u4e00-\u9fa5]/g, '')  // drop CJK (unsafe in some git hosts)
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
    .replace(/-$/, '')
  return slug ? `feature/${deliveryId}-${slug}` : `feature/${deliveryId}`
}

/**
 * Validate a git URL format
 */
export function validateGitUrl(url) {
  if (!url) return { valid: false, message: '请输入 Git 地址' }
  // Basic validation for SSH and HTTPS git URLs
  const sshPattern = /^git@[\w.-]+:.*\.git$/
  const httpsPattern = /^https?:\/\/[\w.-]+\/.*(\.git)?$/
  if (sshPattern.test(url) || httpsPattern.test(url)) {
    return { valid: true, message: 'Git 地址格式正确' }
  }
  return { valid: false, message: 'Git 地址格式不正确，支持 SSH (git@host:repo.git) 或 HTTPS' }
}

/**
 * Validate a local filesystem path
 */
export function validateLocalPath(path) {
  if (!path) return { valid: false, message: '请输入本地路径' }
  if (!path.startsWith('/') && !path.startsWith('~') && !path.match(/^[A-Z]:/)) {
    return { valid: false, message: '请输入绝对路径，如 /Users/xxx/project 或 C:\\project' }
  }
  return { valid: true, message: '路径格式正确' }
}

/**
 * Parse git URL to extract repo name
 */
export function getRepoNameFromUrl(url) {
  if (!url) return ''
  // Remove trailing .git
  const clean = url.replace(/\.git$/, '')
  // Get last segment after /
  const parts = clean.split(/[/:]/)
  return parts[parts.length - 1] || ''
}
