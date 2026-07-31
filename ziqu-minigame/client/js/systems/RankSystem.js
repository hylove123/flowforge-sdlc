/**
 * 段位系统
 * 段位分 = 累计答对数 × 10 + 每题速度加成（答得越快加成越高）。
 */
import * as storage from '../utils/storage.js';

const STATS_KEY = 'rank-stats';

// 科举主题段位，min 为该段位所需段位分
export const RANKS = [
  { name: '白丁', min: 0 },
  { name: '书童', min: 100 },
  { name: '秀才', min: 300 },
  { name: '举人', min: 700 },
  { name: '进士', min: 1300 },
  { name: '榜眼', min: 2200 },
  { name: '状元', min: 3500 },
  { name: '文曲星', min: 5200 },
];

export default class RankSystem {
  constructor() {
    // stats: 累计正确数 / 总答题数 / 段位分
    this.stats = storage.get(STATS_KEY, {
      totalCorrect: 0,
      totalPlayed: 0,
      points: 0,
    });
  }

  /**
   * 单题速度加成：3 秒内满分 5，之后每秒衰减 1，最低 0
   */
  static speedBonus(timeMs) {
    if (timeMs <= 3000) return 5;
    return Math.max(0, 5 - Math.floor((timeMs - 3000) / 1000));
  }

  /** 记录单题结果 */
  addResult({ correct, timeMs = 0 }) {
    this.stats.totalPlayed += 1;
    if (correct) {
      this.stats.totalCorrect += 1;
      this.stats.points += 10 + RankSystem.speedBonus(timeMs);
    }
    storage.set(STATS_KEY, this.stats);
  }

  /** 记录一局结果（批量） */
  addSession(results = []) {
    results.forEach((r) => this.addResult(r));
  }

  /**
   * 当前段位信息
   * @returns {{name:string, index:number, points:number, nextName:string|null, progress:number}}
   */
  getRank() {
    const { points } = this.stats;
    let index = 0;
    for (let i = RANKS.length - 1; i >= 0; i--) {
      if (points >= RANKS[i].min) {
        index = i;
        break;
      }
    }
    const current = RANKS[index];
    const next = RANKS[index + 1] || null;
    const progress = next
      ? (points - current.min) / (next.min - current.min)
      : 1;
    return {
      name: current.name,
      index,
      points,
      nextName: next ? next.name : null,
      progress: Math.max(0, Math.min(1, progress)),
    };
  }

  get accuracy() {
    if (!this.stats.totalPlayed) return 0;
    return this.stats.totalCorrect / this.stats.totalPlayed;
  }
}
