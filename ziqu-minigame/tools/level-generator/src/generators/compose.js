// 字根合成关卡：给出打乱的部件，玩家拼出目标汉字
import { decomposableChars } from '../charDB.js';
import { estimateDifficulty, categoryForDifficulty } from '../difficulty.js';
import { pick, shuffle, randomUUID } from '../util.js';

const TITLES = ['把字拼回来', '字根拼拼乐', '合体！汉字'];

export function generateCompose(rng = Math.random) {
  const entry = pick(decomposableChars(), rng);
  const difficulty = estimateDifficulty('compose', {
    strokes: entry.strokes,
    partCount: entry.radicals.length,
  });
  return {
    id: randomUUID(),
    type: 'compose',
    difficulty,
    title: pick(TITLES, rng),
    data: {
      parts: shuffle(entry.radicals, rng),
      answer: entry.char,
      hint: `读音：${entry.pinyin}`,
    },
    meta: {
      category: categoryForDifficulty(difficulty),
      tags: ['汉字', '合字'],
    },
  };
}
