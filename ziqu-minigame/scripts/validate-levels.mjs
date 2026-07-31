/**
 * validate-levels —— 关卡 Schema 离线校验（Node 18+ ESM）
 *
 * 复用 tools/level-generator/src/schema.js 的 validateLevel，
 * 对 client/assets/levels/*.json 中所有关卡逐条校验：
 *   - 文件必须是关卡对象数组（JSON 解析失败 / 非数组视为非法）
 *   - 任一关卡非法则打印文件名、下标、id、错误详情，并以非零码退出
 *
 * 用法：npm run validate-levels（或 node scripts/validate-levels.mjs）
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateLevel } from '../tools/level-generator/src/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVEL_DIR = join(ROOT, 'client', 'assets', 'levels');

const files = readdirSync(LEVEL_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (!files.length) {
  console.error(`[validate-levels] no level json found in ${LEVEL_DIR}`);
  process.exit(1);
}

let total = 0;
let invalid = 0;

for (const file of files) {
  let levels;
  try {
    levels = JSON.parse(readFileSync(join(LEVEL_DIR, file), 'utf8'));
  } catch (err) {
    console.error(`[validate-levels] ${file}: JSON 解析失败 - ${err.message}`);
    invalid += 1;
    continue;
  }
  if (!Array.isArray(levels)) {
    console.error(`[validate-levels] ${file}: 顶层必须是关卡数组`);
    invalid += 1;
    continue;
  }
  levels.forEach((level, index) => {
    total += 1;
    const { valid, errors } = validateLevel(level);
    if (!valid) {
      invalid += 1;
      const id = level && level.id ? level.id : '(no id)';
      console.error(`[validate-levels] ${file}[${index}] id=${id} 非法:`);
      for (const msg of errors) console.error(`  - ${msg}`);
    }
  });
  console.log(`[validate-levels] ${file}: ${levels.length} levels checked`);
}

console.log(`[validate-levels] total ${total} levels in ${files.length} files, ${invalid} invalid`);
if (invalid > 0) {
  process.exit(1);
}
console.log('[validate-levels] all levels valid ✓');
