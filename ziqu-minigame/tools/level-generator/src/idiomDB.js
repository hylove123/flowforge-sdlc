// 成语库：加载 data/idioms.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idioms = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/idioms.json'), 'utf8'),
);

/** 全部成语条目：{ idiom, pinyin, explanation, example } */
export function allIdioms() {
  return idioms;
}

/** 随机取一条成语 */
export function randomIdiom(rng = Math.random) {
  return idioms[Math.floor(rng() * idioms.length)];
}

/** 取 n 条与 target 不同的成语（做干扰选项） */
export function pickOtherIdioms(target, n, rng = Math.random) {
  const pool = idioms.filter((i) => i.idiom !== target.idiom);
  const out = [];
  const copy = [...pool];
  while (out.length < n && copy.length > 0) {
    const i = Math.floor(rng() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}
