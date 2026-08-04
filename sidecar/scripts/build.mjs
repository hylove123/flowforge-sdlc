// ================================================================
//  scripts/build.mjs — self-contained sidecar bundle for packaging
//
//  Produces a dist/ layout that works with zero external installs,
//  matching what src-tauri/src/commands/sidecar.rs expects inside
//  the Tauri resource dir (`sidecar/dist/index.js`):
//
//    dist/
//      index.js                 esbuild bundle (ESM, all pure-JS deps inlined)
//      node_modules/            pruned runtime tree for NATIVE packages only
//        better-sqlite3/        lib/ + prebuilds/<host platform>.node
//        sqlite-vec/            loader that require.resolve()s the platform pkg
//        sqlite-vec-<os>-<arch>/  vec0 loadable extension binary
//
//  Native modules cannot be inlined (they load .node/.dylib binaries
//  via __dirname- and require.resolve-relative paths), so they stay
//  `external` and ship as a minimal node_modules subtree next to the
//  bundle — Node resolves them from dist/node_modules because the
//  bundle itself lives in dist/.
//
//  Note on better-sqlite3 versions: the tree contains v13 (top-level,
//  prebuild-based) and a nested v12 under @langchain/langgraph-
//  checkpoint-sqlite. The bundle dedupes both onto the shipped v13 —
//  the SqliteSaver API surface (prepare/exec/pragma/transaction) is
//  unchanged between the majors; verified by the graph.get_state
//  smoke RPC in the build pipeline.
// ================================================================

import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const nodeModules = path.join(root, 'node_modules')

// ─── Native package set ─────────────────────────────────────────
// Packages whose runtime loads binaries relative to their own package
// dir. Everything else (langchain/langgraph/MCP SDK/…) is pure JS and
// gets inlined into the bundle.
const NATIVE_PACKAGES = ['better-sqlite3', 'sqlite-vec']
// install-time-only deps that must NOT be dragged into dist
const SKIP_DEPS = new Set(['node-addon-api', 'prebuild-install'])

// ─── 1. clean dist ──────────────────────────────────────────────
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

// ─── 2. bundle ──────────────────────────────────────────────────
// ESM output (package is "type": "module" and sidecar.rs runs plain
// `node dist/index.js`). The banner restores CJS globals so that
// esbuild's __require shim and any dynamic require() left over from
// CJS→ESM conversion (langchain ecosystem) resolve against
// dist/node_modules instead of throwing "Dynamic require … is not
// supported".
await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: path.join(dist, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: NATIVE_PACKAGES,
  banner: {
    js: [
      "import { createRequire as __ffCreateRequire } from 'node:module';",
      "import { fileURLToPath as __ffFileURLToPath } from 'node:url';",
      "import { dirname as __ffPathDirname } from 'node:path';",
      'const require = __ffCreateRequire(import.meta.url);',
      'const __filename = __ffFileURLToPath(import.meta.url);',
      'const __dirname = __ffPathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
})

// ─── 3. copy native packages (pruned) into dist/node_modules ────

/** Recursively copy a directory, skipping build junk that has no runtime role. */
function copyPruned(src, dest) {
  const SKIP_DIRS = new Set(['deps', 'src', 'build', 'node_modules', '.github', 'docs', 'benchmark'])
  const SKIP_FILES = /\.(md|gyp|txt)$|^LICENSE/i
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'prebuilds') {
        copyPrebuilds(from, to)
      } else if (!SKIP_DIRS.has(entry.name)) {
        copyPruned(from, to)
      }
    } else if (!SKIP_FILES.test(entry.name)) {
      fs.copyFileSync(from, to)
    }
  }
}

/** Only ship the host platform's prebuilt .node — Tauri bundles are per-platform anyway. */
function copyPrebuilds(src, dest) {
  const want = `${process.platform}-${process.arch}` // e.g. darwin-arm64; also matches linuxmusl-x64 via includes()
  const files = fs.readdirSync(src).filter((f) => f.includes(`${process.platform}`) && f.includes(`-${process.arch}`))
  if (files.length === 0) {
    throw new Error(`no prebuild matching ${want} in ${src} — cannot produce a runnable bundle`)
  }
  fs.mkdirSync(dest, { recursive: true })
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f))
}

/** Copy a package plus its transitive *runtime* dependencies from node_modules. */
function copyPackageClosure(name, copied = new Set()) {
  if (copied.has(name) || SKIP_DEPS.has(name)) return copied
  copied.add(name)
  const src = path.join(nodeModules, name)
  if (!fs.existsSync(src)) {
    throw new Error(`native package \`${name}\` not found in sidecar/node_modules — run npm install first`)
  }
  copyPruned(src, path.join(dist, 'node_modules', name))
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackageClosure(dep, copied)
  // optionalDependencies: only the ones actually installed (platform binaries)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    if (fs.existsSync(path.join(nodeModules, dep))) copyPackageClosure(dep, copied)
  }
  return copied
}

const shipped = new Set()
for (const name of NATIVE_PACKAGES) copyPackageClosure(name, shipped)

// better-sqlite3 v13 resolves lib/index.js via package.json "main";
// keep an explicit sanity check so a silent layout change fails the build
const sanity = path.join(dist, 'node_modules', 'better-sqlite3', 'lib', 'index.js')
if (!fs.existsSync(sanity)) {
  throw new Error(`bundle layout broken: ${sanity} missing`)
}

// ─── 4. ship the graph engine binary (codebase-memory-mcp) ─────
// Engine B of the dual-index ships as a native binary fetched from
// GitHub Releases at install time. The packaged app has no npx/npm,
// so the platform binary is copied next to the bundle and spawned
// directly by graphEngine.ts (dist/graph-engine/<bin>).
const cbmDir = path.join(nodeModules, 'codebase-memory-mcp')
const engineBinName = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp'
const engineBinSrc = path.join(cbmDir, 'bin', engineBinName)
if (!fs.existsSync(engineBinSrc)) {
  // postinstall download did not run (or failed) — trigger it now
  execFileSync(process.execPath, [path.join(cbmDir, 'install.js')], { stdio: 'inherit' })
}
if (!fs.existsSync(engineBinSrc)) {
  throw new Error(`graph engine binary missing: ${engineBinSrc} — run \`node node_modules/codebase-memory-mcp/install.js\` manually`)
}
const engineBinDestDir = path.join(dist, 'graph-engine')
fs.mkdirSync(engineBinDestDir, { recursive: true })
fs.copyFileSync(engineBinSrc, path.join(engineBinDestDir, engineBinName))
fs.chmodSync(path.join(engineBinDestDir, engineBinName), 0o755)

const bundleKb = Math.round(fs.statSync(path.join(dist, 'index.js')).size / 1024)
const engineMb = Math.round(fs.statSync(path.join(engineBinDestDir, engineBinName)).size / 1024 / 1024)
console.log(`[sidecar build] bundle dist/index.js (${bundleKb} KB), natives: ${[...shipped].join(', ')}, graph engine: ${engineBinName} (${engineMb} MB)`)
