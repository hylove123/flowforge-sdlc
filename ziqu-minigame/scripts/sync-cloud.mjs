/**
 * sync-cloud —— 云函数同步脚本（Node 18+ ESM）
 *
 * 微信开发者工具要求 cloudfunctionRoot 位于项目根（client/）内，
 * 而云函数实现在仓库根的 cloud/ 目录。本脚本把 cloud/functions/ 与
 * cloud/triggers/ 下所有云函数目录递归复制到 client/cloud/（排除
 * node_modules）。复制前会先清空 client/cloud/ 下除 README.md 以外的
 * 所有内容（防漂移：源目录删除的函数不会在目标残留），支持重复运行，幂等。
 *
 * 用法：npm run sync-cloud（或 node scripts/sync-cloud.mjs）
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = [join(ROOT, 'cloud', 'functions'), join(ROOT, 'cloud', 'triggers')];
const DEST = join(ROOT, 'client', 'cloud');

// 复制过滤：跳过任何层级的 node_modules
const notNodeModules = (src) => !src.split(sep).includes('node_modules');

// 防漂移：先清空 client/cloud/ 下除 README.md 以外的内容，
// 避免源目录已删除的云函数在目标目录残留
if (existsSync(DEST)) {
  for (const entry of readdirSync(DEST, { withFileTypes: true })) {
    if (entry.name === 'README.md') continue;
    rmSync(join(DEST, entry.name), { recursive: true, force: true });
    console.log(`[sync-cloud] cleaned stale: client/cloud/${entry.name}`);
  }
}

let synced = 0;
for (const srcDir of SOURCE_DIRS) {
  if (!existsSync(srcDir)) {
    console.warn(`[sync-cloud] source dir not found, skip: ${srcDir}`);
    continue;
  }
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const src = join(srcDir, entry.name);
    const dest = join(DEST, entry.name);
    cpSync(src, dest, { recursive: true, force: true, filter: notNodeModules });
    console.log(`[sync-cloud] ${src.slice(ROOT.length + 1)} -> client/cloud/${entry.name}`);
    synced += 1;
  }
}
console.log(`[sync-cloud] done, ${synced} directories synced.`);
