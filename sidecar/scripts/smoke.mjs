// ================================================================
//  scripts/smoke.mjs — drive the built sidecar bundle over JSON-RPC
//
//  Usage: node scripts/smoke.mjs [/path/to/dist/index.js]
//  (defaults to ../dist/index.js; point it at a dist copy in an
//  empty temp dir to prove the bundle is self-contained)
//
//  Exercises the paths that would break if packaging lost a dep:
//    ping / domain.info      pure-JS bundle integrity
//    flywheel.stats          better-sqlite3 v13 native addon
//    graph.get_state         SqliteSaver running on the deduped v13
//    knowledge.stats/search  graph store + sqlite-vec loader (BM25 fallback)
// ================================================================

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = process.argv[2] ?? path.join(here, '..', 'dist', 'index.js')
// isolated data dir so smoke runs never touch ~/.flowforge
// (honor an externally provided FLOWFORGE_DATA_DIR, e.g. in sandboxed CI)
const dataDir = process.env.FLOWFORGE_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'ff-smoke-data-'))
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, FLOWFORGE_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'inherit'],
})
child.on('exit', (code, signal) => {
  if (!done) {
    console.error(`FAIL sidecar exited early (code=${code} signal=${signal})`)
    process.exit(1)
  }
})
let done = false

const pending = new Map()
let buf = ''
child.stdout.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else if (msg.method) {
      console.log('[notify]', msg.method)
    }
  }
})

function rpc(method, params = {}, timeoutMs = 10000) {
  const id = `smoke_${method}_${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs)
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

let failed = false
async function check(name, method, params, validate) {
  try {
    const msg = await rpc(method, params)
    if (msg.error) throw new Error(`rpc error: ${JSON.stringify(msg.error)}`)
    if (validate && !validate(msg.result)) throw new Error(`unexpected result: ${JSON.stringify(msg.result)}`)
    console.log(`PASS ${name}:`, JSON.stringify(msg.result).slice(0, 120))
  } catch (e) {
    failed = true
    console.error(`FAIL ${name}: ${e.message}`)
  }
}

await check('ping', 'ping', {}, (r) => r?.ok === true)
await check('domain.info', 'domain.info', {}, (r) => r?.concepts > 0 && r?.stages?.length > 0)
await check('flywheel.stats (better-sqlite3 v13)', 'flywheel.stats', { projectId: 'smoke-project' }, (r) => r && typeof r === 'object')
await check('graph.get_state (SqliteSaver on v13)', 'graph.get_state', { threadId: 'smoke-none' }, (r) => r && typeof r === 'object')
await check('knowledge.stats (graph + vector store init)', 'knowledge.stats', {}, (r) => r && typeof r === 'object')
await check('knowledge.search (sqlite-vec loader path)', 'knowledge.search', { projectId: 'smoke-project', query: 'smoke test', topK: 2 }, (r) => r && typeof r === 'object')

done = true
child.kill()
console.log(failed ? 'SMOKE: FAILED' : 'SMOKE: ALL PASS')
process.exit(failed ? 1 : 0)
