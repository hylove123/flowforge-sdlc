/**
 * 成语 / 梗题解谜玩法
 * 展示题目与四个选项（A/B/C/D），玩家选答案后揭示解释。
 */
import {
  THEME,
  drawText,
  fillRoundRect,
  strokeRoundRect,
  pointInRect,
  wrapLines,
} from '../utils/canvas.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const OPTION_HEIGHT = 52;
const OPTION_GAP = 14;

export default class RiddleMode {
  constructor(app, level, onFinish) {
    this.app = app;
    this.level = level;
    this.onFinish = onFinish;

    const { question = '', options = [], answer = 'A', explanation = '' } = level.data;
    this.question = question;
    this.options = options.slice(0, 4);
    this.answerIndex = Math.max(0, LETTERS.indexOf(answer));
    this.explanation = explanation;

    this.locked = false;
    this.chosen = -1;
    this.pending = null;

    this._layout();
  }

  _layout() {
    const w = this.app.width;
    this.optionX = 32;
    this.optionWidth = w - 64;
    this.optionStartY = 316;
    this.optionRects = this.options.map((_, i) => ({
      x: this.optionX,
      y: this.optionStartY + i * (OPTION_HEIGHT + OPTION_GAP),
      width: this.optionWidth,
      height: OPTION_HEIGHT,
    }));
  }

  onTouchStart(x, y) {
    if (this.locked) return;
    for (let i = 0; i < this.optionRects.length; i++) {
      if (pointInRect(x, y, this.optionRects[i])) {
        this.locked = true;
        this.chosen = i;
        const correct = i === this.answerIndex;
        // 留出时间阅读解释
        this.pending = { delay: this.explanation ? 1800 : 800, result: { correct } };
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

    drawText(ctx, '选出正确答案', w / 2, 156, { size: 15, color: THEME.gray });

    // 题干（折行居中）
    const lines = wrapLines(ctx, this.question, w - 72, 20);
    lines.forEach((line, i) => {
      drawText(ctx, line, w / 2, 200 + i * 30, { size: 20, bold: true });
    });

    // 选项
    this.options.forEach((opt, i) => {
      const rect = this.optionRects[i];
      const isAnswer = i === this.answerIndex;
      const isChosen = i === this.chosen;

      let bg = THEME.white;
      let border = THEME.ink;
      let color = THEME.ink;
      if (this.locked && isAnswer) {
        bg = THEME.accent;
        border = THEME.accent;
        color = THEME.white;
      } else if (this.locked && isChosen && !isAnswer) {
        border = THEME.gray;
        color = THEME.gray;
      } else if (this.locked) {
        border = THEME.faint;
        color = THEME.gray;
      }

      fillRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 10, bg);
      strokeRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 10, border, 1.5);
      drawText(ctx, `${LETTERS[i]}.  ${opt}`, rect.x + 20, rect.y + rect.height / 2 + 1, {
        size: 16,
        align: 'left',
        color,
      });
    });

    // 答题后展示解释
    if (this.locked && this.explanation) {
      const y = this.optionStartY + this.options.length * (OPTION_HEIGHT + OPTION_GAP) + 16;
      const expLines = wrapLines(ctx, `解：${this.explanation}`, w - 72, 13);
      expLines.forEach((line, i) => {
        drawText(ctx, line, w / 2, y + i * 20, { size: 13, color: THEME.accent });
      });
    }
  }
}
