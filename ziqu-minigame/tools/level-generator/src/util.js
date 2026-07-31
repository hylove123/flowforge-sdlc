// 通用小工具：随机数 / 抽样 / 洗牌 / UUID
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID() {
  return nodeRandomUUID();
}

/** 从数组中随机取一个元素 */
export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

/** 从数组中不重复地抽取 n 个元素 */
export function sample(arr, n, rng = Math.random) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length > 0) {
    const i = Math.floor(rng() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

/** 返回洗牌后的新数组（Fisher-Yates） */
export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** [min, max] 闭区间随机整数 */
export function randomInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}
