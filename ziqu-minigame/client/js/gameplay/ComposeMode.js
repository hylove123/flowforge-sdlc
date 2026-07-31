/**
 * 字根合成玩法
 * 展示两个字根，玩家从四个候选汉字中选出正确的合成结果。
 * 可通过激励视频解锁提示文案。
 */
import {
  THEME,
  drawText,
  fillRoundRect,
  strokeRoundRect,
  pointInRect,
  shuffle,
} from '../utils/canvas.js';

// 候选干扰字池（避开常用字根本身）
const DISTRACTOR_POOL = [
  '明', '好', '林', '男', '岩', '休', '尘', '尖', '看', '苗',
  '森', '炎', '众', '品', '鑫', '晶', '磊', '淼', '烁', '柏',
];

const OPTION_SIZE = 88;
const OPTION_GAP = 24;

export default class ComposeMode {
  constructor(app, level, onFinish) {
    this.app = app;
    this.level = level;
    this.onFinish = onFinish;

    const { parts = [], answer = '', hint = '' } = level.data;
    this.parts = parts;
    this.answer = answer;
    this.hint = hint;

    const distractors = shuffle(
      DISTRACTOR_POOL.filter((ch) => ch !== answer && !parts.includes(ch))
    ).slice(0, 3);
    this.options = shuffle([answer, ...distractors]);

    this.locked = false;
    this.chosen = -1;
    this.hintShown = false;
    this.pending = null;

    this._layout();
  }

  _layout() {
    const w = this.app.width;
    // 2×2 候选网格
    const gridW = 2 * OPTION_SIZE + OPTION_GAP;
    const startX = (w - gridW) / 2;
    const startY = 340;
    this.optionRects = this.options.map((_, i) => ({
      x: startX + (i % 2) * (OPTION_SIZE + OPTION_GAP),
      y: startY + Math.floor(i / 2) * (OPTION_SIZE + OPTION_GAP),
      width: OPTION_SIZE,
      height: OPTION_SIZE,
    }));
    // 提示按钮
    this.hintRect = { x: w / 2 - 70, y: startY + 2 * (OPTION_SIZE + OPTION_GAP) + 8, width: 140, height: 40 };
  }

  onTouchStart(x, y) {
    if (this.locked) return;

    if (!this.hintShown && pointInRect(x, y, this.hintRect)) {
      // 看激励视频换提示
      this.app.adManager.showRewardedAd((ok) => {
        if (ok) {
          this.hintShown = true;
        }
      });
      return;
    }

    for (let i = 0; i < this.optionRects.length; i++) {
      if (pointInRect(x, y, this.optionRects[i])) {
        this.locked = true;
        this.chosen = i;
        const correct = this.options[i] === this.answer;
        this.pending = { delay: 800, result: { correct } };
        return;
      }
    }
  }

  update(dt) {
    if (this.pending) {
      this.pending.delay -= dt;
      if (this.pending.delay <= 0) {
        const { result } = this.pending;
        this.pending = null;
        this.onFinish(result);
      }
    }
  }

  render(ctx) {
    const w = this.app.width;

    drawText(ctx, '这两个字根能合成哪个字？', w / 2, 156, {
      size: 15,
      color: THEME.gray,
    });

    // 字根算式：木 + 木 = ？
    const expr = `${this.parts.join('  +  ')}  =  ?`;
    drawText(ctx, expr, w / 2, 236, { size: 44, bold: true });

    // 提示文案（解锁后显示）
    if (this.hintShown && this.hint) {
      drawText(ctx, `提示：${this.hint}`, w / 2, 296, {
        size: 14,
        color: THEME.accent,
      });
    }

    // 候选项
    this.options.forEach((ch, i) => {
      const rect = this.optionRects[i];
      const revealed = this.locked;
      const isAnswer = ch === this.answer;
      const isChosen = i === this.chosen;

      let border = THEME.ink;
      let bg = THEME.white;
      let color = THEME.ink;
      if (revealed && isAnswer) {
        bg = THEME.accent;
        border = THEME.accent;
        color = THEME.white;
      } else if (revealed && isChosen && !isAnswer) {
        border = THEME.gray;
        color = THEME.gray;
      }

      fillRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 12, bg);
      strokeRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 12, border, 1.5);
      drawText(ctx, ch, rect.x + rect.width / 2, rect.y + rect.height / 2 + 2, {
        size: 42,
        bold: true,
        color,
      });
    });

    // 提示按钮
    if (!this.hintShown && !this.locked) {
      const r = this.hintRect;
      strokeRoundRect(ctx, r.x, r.y, r.width, r.height, 20, THEME.gray, 1);
      drawText(ctx, '▶ 看视频得提示', r.x + r.width / 2, r.y + r.height / 2 + 1, {
        size: 13,
        color: THEME.gray,
      });
    }
  }
}
