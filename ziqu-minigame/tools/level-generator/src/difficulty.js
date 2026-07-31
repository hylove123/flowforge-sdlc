// 难度评估算法：根据各题型的客观指标估算 1-5 级难度

function clamp(n) {
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** 拆字：笔画越多、部件越多、干扰项越多越难 */
function disassembleDifficulty({ strokes = 8, radicalCount = 2, distractorCount = 2 }) {
  let score = 1;
  if (strokes >= 7) score += 1;
  if (strokes >= 10) score += 1;
  if (strokes >= 13) score += 1;
  if (radicalCount >= 3) score += 1;
  if (distractorCount >= 4) score += 0.5;
  return clamp(score);
}

/** 合字：答案笔画多、部件被打乱数量多则难 */
function composeDifficulty({ strokes = 8, partCount = 2 }) {
  let score = 1;
  if (strokes >= 8) score += 1;
  if (strokes >= 11) score += 1;
  if (strokes >= 14) score += 1;
  if (partCount >= 3) score += 1;
  return clamp(score);
}

/** 找茬：文本越长、错字越多越难 */
function typoFindDifficulty({ textLength = 10, typoCount = 1 }) {
  let score = 1;
  if (textLength >= 10) score += 1;
  if (textLength >= 16) score += 1;
  if (textLength >= 24) score += 1;
  if (typoCount >= 2) score += 1;
  return clamp(score);
}

/** 解谜：选项越多越难，成语生僻度（用释义长度近似）加成 */
function riddleDifficulty({ optionCount = 4, explanationLength = 12 }) {
  let score = 2;
  if (optionCount >= 4) score += 1;
  if (explanationLength >= 14) score += 1;
  if (explanationLength >= 22) score += 1;
  return clamp(score);
}

/**
 * 统一入口：按题型分发到对应的评估函数。
 * @param {'disassemble'|'compose'|'typoFind'|'riddle'} type
 * @param {object} metrics 题型相关指标
 * @returns {number} 1-5
 */
export function estimateDifficulty(type, metrics = {}) {
  switch (type) {
    case 'disassemble': return disassembleDifficulty(metrics);
    case 'compose': return composeDifficulty(metrics);
    case 'typoFind': return typoFindDifficulty(metrics);
    case 'riddle': return riddleDifficulty(metrics);
    default: return 3;
  }
}

/** 由难度推导默认分类：1-2 basic / 3 intermediate / 4-5 meme */
export function categoryForDifficulty(difficulty) {
  if (difficulty <= 2) return 'basic';
  if (difficulty === 3) return 'intermediate';
  return 'meme';
}
