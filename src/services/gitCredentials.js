/**
 * Git Credentials Service — per-host token auth for git clone/push
 *
 * Storage follows the ModelConfig pattern (services/ai.js): records live
 * in the StorageService KV, i.e. the local SQLite kv_store in tauri mode
 * and localStorage in web mode. Tokens never leave this machine; the
 * Rust side injects them into the git URL per-command and redacts them
 * from every log/event/error (see src-tauri/src/commands/git_ops.rs).
 */

import { storage } from '@/adapters/StorageService'

const GIT_CREDENTIALS_KEY = 'flowforge_git_credentials'

/** Fallback username for host tokens (GitLab PAT convention). */
export const DEFAULT_GIT_USERNAME = 'oauth2'

// Credential structure: { id, host, username, token, createdAt, updatedAt }

export function getGitCredentials() {
  return storage.getJSON(GIT_CREDENTIALS_KEY, [])
}

export function saveGitCredentials(credentials) {
  storage.setJSON(GIT_CREDENTIALS_KEY, credentials)
}

/**
 * Normalize a host for storage/matching: trim, lowercase, drop protocol,
 * userinfo, path and trailing slash. Keeps an explicit numeric port (the
 * same function runs on both the stored host and the matched URL, so the
 * two sides always agree).
 * "https://GitLab.Example.com:8443/grp"   → "gitlab.example.com:8443"
 * "git@gitlab.example.com:grp/repo.git"   → "gitlab.example.com" (scp-like)
 * "ssh://git@gitlab.example.com/grp/x"    → "gitlab.example.com"
 */
export function normalizeGitHost(input) {
  let host = String(input || '').trim().toLowerCase()
  host = host.replace(/^[a-z+]+:\/\//, '')
  // authority ends at the first '/'; userinfo only lives inside it
  const slash = host.indexOf('/')
  if (slash >= 0) host = host.slice(0, slash)
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  // scp-like `host:path` → cut at ':' unless the suffix is a numeric port
  const colon = host.indexOf(':')
  if (colon >= 0 && !/^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  return host
}

export function addGitCredential(credential) {
  const all = getGitCredentials()
  const newCredential = {
    id: `gitcred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    username: DEFAULT_GIT_USERNAME,
    ...credential,
    host: normalizeGitHost(credential.host),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  all.push(newCredential)
  saveGitCredentials(all)
  return newCredential
}

export function updateGitCredential(id, updates) {
  const all = getGitCredentials()
  const idx = all.findIndex(c => c.id === id)
  if (idx >= 0) {
    all[idx] = {
      ...all[idx],
      ...updates,
      ...(updates.host !== undefined ? { host: normalizeGitHost(updates.host) } : {}),
      updatedAt: new Date().toISOString(),
    }
    saveGitCredentials(all)
    return all[idx]
  }
  return null
}

export function deleteGitCredential(id) {
  saveGitCredentials(getGitCredentials().filter(c => c.id !== id))
}

/**
 * Credential configured for the host of an http(s) git URL, or null.
 * SSH / scp-like / local URLs never match (token auth is http(s)-only,
 * those keep the system credential helper behavior).
 */
export function findCredentialForUrl(gitUrl) {
  const url = String(gitUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  const host = normalizeGitHost(url)
  if (!host) return null
  return getGitCredentials().find(c =>
    c.host === host && c.token && String(c.token).trim().length > 0
  ) || null
}

/**
 * `auth` parameter for the Rust git_clone/git_push commands, or null when
 * no credential is configured for the URL's host (system helper fallback).
 */
export function buildGitAuthForUrl(gitUrl) {
  const cred = findCredentialForUrl(gitUrl)
  if (!cred) return null
  return {
    username: (cred.username && cred.username.trim()) || DEFAULT_GIT_USERNAME,
    token: cred.token,
  }
}
