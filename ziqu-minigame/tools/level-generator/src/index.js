#!/usr/bin/env node
// 入口：批量生成关卡数据文件
// 用法：node src/index.js --count 100 --output ../../client/assets/levels/
import fs from 'node:fs';
import path from 'node:path';
import { generateDisassemble } from './generators/disassemble.js';
import { generateCompose } from './generators/compose.js';
import { generateTypoFind } from './generators/typoFind.js';
import { generateRiddleIdiom } from './generators/riddleIdiom.js';
import { validateLevel } from './schema.js';

const GENERATORS = [
  generateDisassemble,
  generateCompose,
  generateTypoFind,
  generateRiddleIdiom,
];

function parseArgs(argv) {
  const args = { count: 100, output: '../../client/assets/levels/' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--count' && argv[i + 1]) args.count = parseInt(argv[++i], 10);
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
  }
  if (!Number.isInteger(args.count) || args.count <= 0) {
    console.error('参数错误：--count 必须是正整数');
    process.exit(1);
  }
  return args;
}

/** 生成 count 个关卡，4 种题型轮转均衡分布 */
export function generateLevels(count, rng = Math.random) {
  const levels = [];
  for (let i = 0; i < count; i++) {
    const level = GENERATORS[i % GENERATORS.length](rng);
    const result = validateLevel(level);
    if (!result.valid) {
      throw new Error(`生成的关卡不符合 Schema：${result.errors.join('；')}\n${JSON.stringify(level, null, 2)}`);
    }
    levels.push(level);
  }
  return levels;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 清理输出目录中旧的批次文件（levels_batch_*.json），避免主包体积累积；保留 sample_levels.json 等非批次文件 */
export function cleanupOldBatches(outDir) {
  if (!fs.existsSync(outDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(outDir)) {
    if (/^levels_batch_.*\.json$/.test(name)) {
      fs.unlinkSync(path.join(outDir, name));
      console.log(`🧹 已删除旧批次文件: ${name}`);
      removed += 1;
    }
  }
  return removed;
}

function main() {
  const { count, output } = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(process.cwd(), output);
  fs.mkdirSync(outDir, { recursive: true });
  cleanupOldBatches(outDir);

  const levels = generateLevels(count);
  const file = path.join(outDir, `levels_batch_${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(levels, null, 2), 'utf8');

  // 输出统计信息
  const byType = {};
  const byDifficulty = {};
  for (const l of levels) {
    byType[l.type] = (byType[l.type] || 0) + 1;
    byDifficulty[l.difficulty] = (byDifficulty[l.difficulty] || 0) + 1;
  }
  console.log(`✅ 已生成 ${levels.length} 个关卡 -> ${file}`);
  console.log(`   题型分布: ${JSON.stringify(byType)}`);
  console.log(`   难度分布: ${JSON.stringify(byDifficulty)}`);
}

// 仅当作为脚本直接运行时执行（便于 test 引用 generateLevels）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
