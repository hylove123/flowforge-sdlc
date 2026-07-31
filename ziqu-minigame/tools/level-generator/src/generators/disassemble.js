// 拆字重构关卡：给出完整字，玩家从候选部件中选出正确的拆解组合
import { decomposableChars, pickDistractors } from '../charDB.js';
import { estimateDifficulty, categoryForDifficulty } from '../difficulty.js';
import { pick, randomInt, randomUUID } from '../util.js';

const TITLES = ['把字拆开来', '庖丁解字', '这个字由什么组成？'];

export function generateDisassemble(rng = Math.random) {
  const entry = pick(decomposableChars(), rng);
  // 字越复杂，给的干扰部件越多
  const distractorCount = entry.strokes >= 10 ? randomInt(3, 4, rng) : randomInt(2, 3, rng);
  const distractors = pickDistractors(entry, distractorCount, rng);
  const difficulty = estimateDifficulty('disassemble', {
    strokes: entry.strokes,
    radicalCount: entry.radicals.length,
    distractorCount: distractors.length,
  });
  return {
    id: randomUUID(),
    type: 'disassemble',
    difficulty,
    title: pick(TITLES, rng),
    data: {
      char: entry.char,
      radicals: [...entry.radicals],
      distractors,
    },
    meta: {
      category: categoryForDifficulty(difficulty),
      tags: ['汉字', '拆字'],
    },
  };
}
