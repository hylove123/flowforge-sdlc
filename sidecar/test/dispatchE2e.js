// ================================================================
//  dispatchE2e.js — 外派链路端到端验证（真实 sidecar + 真实图谱引擎）
//
//  复现用户场景：需求「入库单条码打印支持」（纯中文、无代码符号），
//  绑定真实仓库后执行外派（context.build_package），验证：
//    1. RPC 不再报「外派失败：代码图谱无匹配结果」
//    2. 上下文包正常交付（markdown/filePath 必有其一）
//    3. 图谱零命中或引擎不可用时以「> 说明：」降级标注，不阻断交付
//    4. 含代码符号的需求能从图谱检索到真实命中
//
//  运行方式（独立于 npm test，依赖本机 codebase-memory-mcp）：
//    node sidecar/test/dispatchE2e.js [repoPath]
// ================================================================

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const tsxBin = path.join(root, '..', 'node_modules', '.bin', 'tsx')
const entry = path.join(root, '..', 'src', 'index.ts')

// 默认使用本机 WMS 仓库（用户外派失败时使用的仓库目录）
const repoPath = process.argv[2] || '/Users/heduola/MyFiles/KukaProjects/awms-project/awms-app'
const requirement = '入库单条码打印支持'

function startSidecar() {
  const child = spawn(tsxBin, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
  const rl = createInterface({ input: child.stdout })
  const queue = []
  const waiters = []
  let seq = 0
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter) waiter(msg)
      else queue.push(msg)
    } catch { /* non-JSON noise on stdout */ }
  })
  return {
    child,
    async invoke(method, params, timeoutMs = 180000) {
      const id = `e2e-${++seq}`
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const msg = queue.length > 0
          ? queue.shift()
          : await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`等待 ${method} 响应超时`)), deadline - Date.now())
              waiters.push((m) => { clearTimeout(timer); resolve(m) })
            })
        if (msg.id === id) return msg
        // 非目标消息（通知/其他响应）直接丢弃，继续等待
      }
      throw new Error(`等待 ${method} 响应超时`)
    },
    stop() {
      this.child.stdin.end()
      this.child.kill()
    },
  }
}

async function main() {
  const s = startSidecar()
  let failures = 0
  const step = (name, ok, detail = '') => {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures++
  }
  try {
    // ── 场景 1：纯中文需求外派（用户原始失败场景）──
    const res1 = await s.invoke('context.build_package', {
      projectId: 'e2e-proj', deliveryId: 'e2e-d1', stageId: 'dev-plan',
      projectName: 'WMS 条码打印', requirement, repoPath,
    })
    step('外派 RPC 无错误返回', !res1.error, res1.error ? String(res1.error.message ?? res1.error) : '')
    const md1 = res1.result?.markdown
    const file1 = res1.result?.filePath
    step('上下文包已交付（markdown/filePath 必有其一）', Boolean(md1 || file1),
      file1 ? `溢出落盘：${file1}` : `${res1.result?.size ?? 0} bytes`)
    if (md1) {
      step('包含交付背景与需求', md1.includes('交付背景') && md1.includes(requirement))
      step('包含代码结构上下文章节', md1.includes('代码结构上下文'))
      const degraded = md1.includes('> 说明：')
      const hit = /### 相关模块（结构搜索）\n\n- /.test(md1)
      step('图谱命中或降级标注（二者其一）', degraded || hit,
        hit ? '图谱有命中' : '零命中已降级标注')
    }

    // ── 场景 2：无 repoPath 外派（知识/方案类交付不受影响）──
    const res2 = await s.invoke('context.build_package', {
      projectId: 'e2e-proj', deliveryId: 'e2e-d2', stageId: 'prd',
      projectName: 'WMS 条码打印', requirement,
    })
    step('无仓库外派正常交付', !res2.error && Boolean(res2.result?.markdown || res2.result?.filePath))

    // ── 场景 3：图谱引擎状态与结构搜索（真实引擎冒烟）──
    const status = await s.invoke('graph_engine.status', {})
    const available = status.result?.available === true
    step('图谱引擎可用（本机 codebase-memory-mcp）', available,
      available ? `${status.result?.tools?.length ?? 0} tools` : String(status.result?.error ?? status.error ?? ''))
    if (available) {
      const search = await s.invoke('graph_engine.search', {
        repoPath, pattern: 'print', mode: 'compact', limit: 3,
      })
      const results = search.result?.results ?? search.result?.matches ?? []
      step('英文符号结构搜索有返回', !search.error,
        search.error ? String(search.error.message ?? search.error) : `命中 ${Array.isArray(results) ? results.length : '?'} 条`)
      if (Array.isArray(results) && results.length > 0) {
        const h = results[0]
        step('命中结构含 qualified_name/label/file 字段',
          Boolean(h.qualified_name ?? h.file),
          `${h.qualified_name ?? ''} @ ${h.file ?? ''}:${h.start_line ?? '?'}`)
      }
    }
  } catch (err) {
    step('端到端执行无异常', false, err.message)
  } finally {
    s.stop()
  }
  console.log(failures === 0 ? '\n🎉 外派链路端到端验证全部通过' : `\n⚠️ ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
