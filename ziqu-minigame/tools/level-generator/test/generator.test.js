// 基础自测：生成 20 关，逐关校验 schema，确认 4 种题型全覆盖
import assert from 'node:assert/strict';
import { generateLevels } from '../src/index.js';
import { validateLevel, LEVEL_SCHEMA, LEVEL_TYPES } from '../src/schema.js';
import { allChars, decomposableChars } from '../src/charDB.js';
import { allIdioms } from '../src/idiomDB.js';

// 1. 数据库完整性
const chars = allChars();
assert.ok(chars.length >= 500, `chars.json 应至少 500 字，实际 ${chars.length}`);
assert.equal(new Set(chars.map((c) => c.char)).size, chars.length, 'chars.json 存在重复字');
for (const c of chars) {
  assert.ok(c.char && c.pinyin && Array.isArray(c.radicals) && c.radicals.length >= 1, `字段缺失: ${JSON.stringify(c)}`);
  assert.ok(Number.isInteger(c.strokes) && c.strokes >= 1, `笔画数非法: ${c.char}`);
}
assert.ok(decomposableChars().length >= 300, '可拆解字（>=2 部件）数量不足');

const idioms = allIdioms();
assert.ok(idioms.length >= 200, `idioms.json 应至少 200 条，实际 ${idioms.length}`);
assert.equal(new Set(idioms.map((i) => i.idiom)).size, idioms.length, 'idioms.json 存在重复成语');
for (const i of idioms) {
  assert.ok(i.idiom && i.pinyin && i.explanation && i.example, `成语字段缺失: ${JSON.stringify(i)}`);
}
console.log(`✓ 数据库完整性：${chars.length} 字 / ${idioms.length} 条成语`);

// 2. schema 常量导出
assert.equal(typeof LEVEL_SCHEMA, 'object');
assert.deepEqual(LEVEL_TYPES, ['disassemble', 'compose', 'typoFind', 'riddle']);
console.log('✓ LEVEL_SCHEMA / LEVEL_TYPES 导出正常');

// 3. 生成 20 关并逐关校验
const levels = generateLevels(20);
assert.equal(levels.length, 20, '应生成 20 关');
const seenIds = new Set();
for (const level of levels) {
  const { valid, errors } = validateLevel(level);
  assert.ok(valid, `schema 校验失败: ${JSON.stringify(errors)}\n${JSON.stringify(level)}`);
  assert.ok(!seenIds.has(level.id), `关卡 id 重复: ${level.id}`);
  seenIds.add(level.id);
  assert.ok(level.difficulty >= 1 && level.difficulty <= 5, `难度越界: ${level.difficulty}`);
}
console.log('✓ 20 关全部通过 validateLevel');

// 4. 四种类型全覆盖
const typeCount = {};
for (const level of levels) typeCount[level.type] = (typeCount[level.type] || 0) + 1;
for (const t of LEVEL_TYPES) {
  assert.ok(typeCount[t] >= 1, `缺少题型: ${t}`);
}
console.log(`✓ 四种题型全覆盖: ${JSON.stringify(typeCount)}`);

// 5. 非法关卡应被 validateLevel 拒绝
assert.equal(validateLevel({}).valid, false);
assert.equal(validateLevel({ ...levels[0], difficulty: 9 }).valid, false);
assert.equal(validateLevel({ ...levels[0], type: 'unknown' }).valid, false);
console.log('✓ 非法关卡被正确拒绝');

console.log('\n全部测试通过 ✅');
