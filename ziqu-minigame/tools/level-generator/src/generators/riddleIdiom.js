// 成语/梗题解谜关卡：看释义猜成语、例句填空等四选一题
import { randomIdiom, pickOtherIdioms } from '../idiomDB.js';
import { estimateDifficulty, categoryForDifficulty } from '../difficulty.js';
import { pick, shuffle, randomUUID } from '../util.js';

const TITLES = ['成语猜猜猜', '这题有点儿冷', '国粹知识局'];
const LETTERS = ['A', 'B', 'C', 'D'];

export function generateRiddleIdiom(rng = Math.random) {
  const target = randomIdiom(rng);
  const distractors = pickOtherIdioms(target, 3, rng);
  const options = shuffle([target, ...distractors].map((i) => i.idiom), rng);
  const answer = LETTERS[options.indexOf(target.idiom)];

  // 若例句中含目标成语则出"例句填空"题，否则出"看释义猜成语"题
  let question;
  if (target.example.includes(target.idiom) && rng() < 0.5) {
    question = `"${target.example.replace(target.idiom, '____')}" 横线处应填哪个成语？`;
  } else {
    question = `下列哪个成语的意思是"${target.explanation}"？`;
  }

  const difficulty = estimateDifficulty('riddle', {
    optionCount: options.length,
    explanationLength: target.explanation.length,
  });
  return {
    id: randomUUID(),
    type: 'riddle',
    difficulty,
    title: pick(TITLES, rng),
    data: {
      question,
      options,
      answer,
      explanation: `${target.idiom}（${target.pinyin}）：${target.explanation}例：${target.example}`,
    },
    meta: {
      category: categoryForDifficulty(difficulty),
      tags: ['成语', '解谜'],
    },
  };
}
