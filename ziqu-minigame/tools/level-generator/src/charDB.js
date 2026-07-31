// 汉字字库：加载 data/chars.json，提供拆解/查询辅助
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chars = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/chars.json'), 'utf8'),
);

/** 全部字条目：{ char, pinyin, radicals, strokes } */
export function allChars() {
  return chars;
}

/** 可拆解为 2 个以上部件的字（拆字/合字题的素材） */
export function decomposableChars() {
  return chars.filter((c) => Array.isArray(c.radicals) && c.radicals.length >= 2);
}

/** 全字库出现过的部件去重集合（用作干扰项池） */
export const radicalPool = [...new Set(chars.flatMap((c) => c.radicals || []))];

/** 按字查条目 */
export function findChar(ch) {
  return chars.find((c) => c.char === ch);
}

/** 取与目标字部件无关的干扰部件 */
export function pickDistractors(entry, count, rng = Math.random) {
  const pool = radicalPool.filter((r) => !entry.radicals.includes(r) && r !== entry.char);
  const out = [];
  const copy = [...pool];
  while (out.length < count && copy.length > 0) {
    const i = Math.floor(rng() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}
