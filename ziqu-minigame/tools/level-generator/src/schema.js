// Level JSON Schema 定义与校验（手写校验，零依赖）

export const LEVEL_TYPES = ['disassemble', 'compose', 'typoFind', 'riddle'];
export const LEVEL_CATEGORIES = ['basic', 'intermediate', 'meme', 'weekly'];

/** 关卡结构的 JSON Schema（供文档 / 客户端 / 云端共用） */
export const LEVEL_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'ZiquLevel',
  type: 'object',
  required: ['id', 'type', 'difficulty', 'title', 'data', 'meta'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
    type: { type: 'string', enum: LEVEL_TYPES },
    difficulty: { type: 'integer', minimum: 1, maximum: 5 },
    title: { type: 'string', minLength: 1 },
    data: { type: 'object' },
    meta: {
      type: 'object',
      required: ['category', 'tags'],
      properties: {
        category: { type: 'string', enum: LEVEL_CATEGORIES },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v, minLen = 0) {
  return Array.isArray(v) && v.length >= minLen && v.every((x) => typeof x === 'string');
}

/** 按 type 校验 data 字段，返回错误列表 */
function validateData(type, data, errors) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push('data 必须是对象');
    return;
  }
  switch (type) {
    case 'disassemble':
      if (!isNonEmptyString(data.char)) errors.push('data.char 必须是非空字符串');
      if (!isStringArray(data.radicals, 2)) errors.push('data.radicals 必须是至少 2 个字符串的数组');
      if (!isStringArray(data.distractors, 1)) errors.push('data.distractors 必须是至少 1 个字符串的数组');
      break;
    case 'compose':
      if (!isStringArray(data.parts, 2)) errors.push('data.parts 必须是至少 2 个字符串的数组');
      if (!isNonEmptyString(data.answer)) errors.push('data.answer 必须是非空字符串');
      if (!isNonEmptyString(data.hint)) errors.push('data.hint 必须是非空字符串');
      break;
    case 'typoFind':
      if (!isNonEmptyString(data.text)) errors.push('data.text 必须是非空字符串');
      if (!Array.isArray(data.typos) || data.typos.length < 1) {
        errors.push('data.typos 必须是至少含 1 项的数组');
      } else {
        data.typos.forEach((t, i) => {
          if (typeof t !== 'object' || t === null) {
            errors.push(`data.typos[${i}] 必须是对象`);
            return;
          }
          if (!Number.isInteger(t.pos) || t.pos < 0 || t.pos >= data.text.length) {
            errors.push(`data.typos[${i}].pos 必须是 text 内合法下标`);
          } else if (isNonEmptyString(t.wrong) && data.text[t.pos] !== t.wrong) {
            errors.push(`data.typos[${i}].pos 处的字符与 wrong 不一致`);
          }
          if (!isNonEmptyString(t.wrong)) errors.push(`data.typos[${i}].wrong 必须是非空字符串`);
          if (!isNonEmptyString(t.correct)) errors.push(`data.typos[${i}].correct 必须是非空字符串`);
        });
      }
      break;
    case 'riddle':
      if (!isNonEmptyString(data.question)) errors.push('data.question 必须是非空字符串');
      if (!isStringArray(data.options, 2)) errors.push('data.options 必须是至少 2 个字符串的数组');
      if (!isNonEmptyString(data.answer)) {
        errors.push('data.answer 必须是非空字符串');
      } else {
        const idx = data.answer.charCodeAt(0) - 65; // 'A' -> 0
        if (idx < 0 || !Array.isArray(data.options) || idx >= data.options.length) {
          errors.push('data.answer 必须是 options 范围内的选项字母（如 "B"）');
        }
      }
      if (!isNonEmptyString(data.explanation)) errors.push('data.explanation 必须是非空字符串');
      break;
    default:
      // type 本身的错误已在外层报告
      break;
  }
}

/**
 * 校验一个关卡对象是否符合 LEVEL_SCHEMA。
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLevel(level) {
  const errors = [];
  if (typeof level !== 'object' || level === null || Array.isArray(level)) {
    return { valid: false, errors: ['关卡必须是对象'] };
  }
  if (!isNonEmptyString(level.id) || !UUID_V4_RE.test(level.id)) errors.push('id 必须是 UUID v4 字符串');
  if (!LEVEL_TYPES.includes(level.type)) errors.push(`type 必须是 ${LEVEL_TYPES.join('|')} 之一`);
  if (!Number.isInteger(level.difficulty) || level.difficulty < 1 || level.difficulty > 5) {
    errors.push('difficulty 必须是 1-5 的整数');
  }
  if (!isNonEmptyString(level.title)) errors.push('title 必须是非空字符串');
  validateData(level.type, level.data, errors);
  if (typeof level.meta !== 'object' || level.meta === null) {
    errors.push('meta 必须是对象');
  } else {
    if (!LEVEL_CATEGORIES.includes(level.meta.category)) {
      errors.push(`meta.category 必须是 ${LEVEL_CATEGORIES.join('|')} 之一`);
    }
    if (!isStringArray(level.meta.tags, 1)) errors.push('meta.tags 必须是至少 1 个字符串的数组');
  }
  return { valid: errors.length === 0, errors };
}
