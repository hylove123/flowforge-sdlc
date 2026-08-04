#!/usr/bin/env node
// ================================================================
//  fetch-node.mjs — 下载官方 Node 运行时并放入 Tauri resources
//
//  目的：让 FlowForge 成为真正的零依赖独立客户端 —— sidecar
//  使用随包分发的 node 二进制，而不是依赖用户本机安装的 Node。
//
//  产物：src-tauri/bin/node（macOS/Linux）或 src-tauri/bin/node.exe
//  由 tauri.conf.json resources 打包进 Contents/Resources/bin/node。
//  已存在且版本匹配时跳过下载（幂等）。
// ================================================================
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { get } from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_VERSION = 'v22.23.2' // 官方 LTS；升级时同步改这里
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'src-tauri', 'bin')
const versionFile = path.join(outDir, '.node-version')

// 平台 → nodejs.org 发布产物映射
function distInfo() {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'arm64') return { file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, member: `node-${NODE_VERSION}-darwin-arm64/bin/node`, out: 'node' }
  if (p === 'darwin' && a === 'x64') return { file: `node-${NODE_VERSION}-darwin-x64.tar.gz`, member: `node-${NODE_VERSION}-darwin-x64/bin/node`, out: 'node' }
  if (p === 'linux' && a === 'x64') return { file: `node-${NODE_VERSION}-linux-x64.tar.gz`, member: `node-${NODE_VERSION}-linux-x64/bin/node`, out: 'node' }
  if (p === 'linux' && a === 'arm64') return { file: `node-${NODE_VERSION}-linux-arm64.tar.gz`, member: `node-${NODE_VERSION}-linux-arm64/bin/node`, out: 'node' }
  if (p === 'win32' && a === 'x64') return { file: `node-${NODE_VERSION}-win-x64.zip`, member: `node-${NODE_VERSION}-win-x64/node.exe`, out: 'node.exe' }
  throw new Error(`不支持的平台: ${p}/${a} — 请手动下载 Node ${NODE_VERSION} 放到 src-tauri/bin/`)
}

const { file, member, out } = distInfo()
const target = path.join(outDir, out)

if (existsSync(target) && existsSync(versionFile) && readFileSync(versionFile, 'utf8').trim() === NODE_VERSION) {
  console.log(`[fetch-node] ${target} 已是 ${NODE_VERSION}，跳过下载`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const url = `https://nodejs.org/dist/${NODE_VERSION}/${file}`
const tmp = path.join(outDir, `download-${file}`)

console.log(`[fetch-node] 下载 ${url} …`)
await new Promise((resolve, reject) => {
  const stream = createWriteStream(tmp)
  get(url, res => {
    if (res.statusCode === 302 || res.statusCode === 301) {
      stream.close()
      get(res.headers.location, r2 => r2.pipe(stream).on('finish', resolve)).on('error', reject)
      return
    }
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
    res.pipe(stream).on('finish', resolve)
  }).on('error', reject)
})

console.log(`[fetch-node] 解压 ${member} …`)
const extractedDir = path.join(outDir, member.split('/')[0])
if (file.endsWith('.tar.gz')) {
  execFileSync('tar', ['-xzf', tmp, '-C', outDir, member], { stdio: 'inherit' })
  renameSync(path.join(outDir, member), target)
  rmSync(extractedDir, { recursive: true, force: true })
  rmSync(tmp, { force: true })
  execFileSync('chmod', ['+x', target])
} else {
  execFileSync('unzip', ['-o', tmp, member, '-d', outDir], { stdio: 'inherit' })
  renameSync(path.join(outDir, member), target)
  rmSync(extractedDir, { recursive: true, force: true })
  rmSync(tmp, { force: true })
}

writeFileSync(versionFile, NODE_VERSION)
console.log(`[fetch-node] ✓ ${target}（${NODE_VERSION}）就绪，将随安装包分发`)
