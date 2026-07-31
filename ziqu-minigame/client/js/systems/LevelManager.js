/**
 * 关卡加载与进度管理
 * - 扫描 assets/levels/ 目录下全部关卡 JSON（sample_levels.json 保底 + 生成器批次产出），
 *   按文件名排序依次合并，按 level.id 去重
 * - 按序推进，游标进度持久化到本地 storage
 */
import * as storage from '../utils/storage.js';

const LEVEL_DIR = 'assets/levels';
const BASE_FILE = 'sample_levels.json';
const PROGRESS_KEY = 'level-progress';
const VALID_TYPES = ['disassemble', 'compose', 'typoFind', 'riddle'];

/** 筛选 .json 文件并排序：sample_levels.json 排最前作为保底，其余按文件名升序 */
export function sortLevelFiles(files) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => typeof f === 'string' && f.endsWith('.json'))
    .sort((a, b) => {
      if (a === BASE_FILE) return -1;
      if (b === BASE_FILE) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/** 合并多个关卡列表：校验字段合法性，按 level.id 去重（先加载的优先） */
export function mergeLevels(lists) {
  const seen = new Set();
  const merged = [];
  for (const list of Array.isArray(lists) ? lists : []) {
    for (const lv of Array.isArray(list) ? list : []) {
      if (!lv || !lv.id || !VALID_TYPES.includes(lv.type) || !lv.data) continue;
      if (seen.has(lv.id)) continue;
      seen.add(lv.id);
      merged.push(lv);
    }
  }
  return merged;
}

export default class LevelManager {
  constructor() {
    this.levels = [];
    // progress: { cursor: 下一关下标, best: { [levelId]: 最高分 }, cleared: 累计通关数 }
    this.progress = storage.get(PROGRESS_KEY, { cursor: 0, best: {}, cleared: 0 });
  }

  /** 读取关卡包（扫描目录合并全部关卡文件，单文件解析失败跳过不阻断） */
  load() {
    try {
      const fs = wx.getFileSystemManager();
      const files = sortLevelFiles(fs.readdirSync(LEVEL_DIR));
      const lists = [];
      for (const name of files) {
        try {
          lists.push(JSON.parse(fs.readFileSync(`${LEVEL_DIR}/${name}`, 'utf8')));
        } catch (e) {
          console.warn(`[LevelManager] skip broken level file ${name}:`, e);
        }
      }
      this.levels = mergeLevels(lists);
    } catch (e) {
      console.error('[LevelManager] load levels failed:', e);
      this.levels = [];
    }
    if (this.progress.cursor >= this.levels.length) {
      this.progress.cursor = 0;
    }
    return this.levels.length;
  }

  get totalCount() {
    return this.levels.length;
  }

  get clearedCount() {
    return this.progress.cleared;
  }

  /** 从当前游标起取一局的关卡（不足时环绕补齐） */
  getSessionLevels(count = 5) {
    if (!this.levels.length) return [];
    const n = Math.min(count, this.levels.length);
    const session = [];
    for (let i = 0; i < n; i++) {
      session.push(this.levels[(this.progress.cursor + i) % this.levels.length]);
    }
    return session;
  }

  /** 按 id 查找关卡（好友挑战按 levelId 复现题目） */
  getLevelById(id) {
    return this.levels.find((lv) => lv.id === id) || null;
  }

  /**
   * 记录单关结果并推进游标
   * @param {object} level 关卡
   * @param {{correct:boolean, score:number}} result
   */
  recordResult(level, { correct, score }) {
    // 防御：关卡列表为空时 (cursor+1) % 0 = NaN，不能写入本地存储
    if (!level || !this.levels.length) return;
    if (correct) {
      const prev = this.progress.best[level.id] || 0;
      if (score > prev) this.progress.best[level.id] = score;
      this.progress.cleared += 1;
    }
    // 无论对错都向后推进，失败关卡留待下一轮环绕重现
    this.progress.cursor = (this.progress.cursor + 1) % this.levels.length;
    storage.set(PROGRESS_KEY, this.progress);
  }

  /** 重置全部进度（调试用） */
  reset() {
    this.progress = { cursor: 0, best: {}, cleared: 0 };
    storage.set(PROGRESS_KEY, this.progress);
  }
}
