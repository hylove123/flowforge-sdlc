/**
 * 错别字找茬玩法
 * 展示一段文本，玩家点击其中的错别字位置。
 * 找齐全部错字判胜；误点 3 次判负。
 */
import {
  THEME,
  drawText,
  fillRoundRect,
  strokeRoundRect,
  pointInRect,
} from '../utils/canvas.js';

const CHAR_SIZE = 34; // 单字格边长
const CHAR_GAP = 6;
const MAX_MISSES = 3;

export default class TypoFindMode {
  constructor(app, level, onFinish) {
    this.app = app;
    this.level = level;
    this.onFinish = onFinish;

    const { text = '', typos = [] } = level.data;
    this.chars = Array.from(text);
    this.typos = typos; // [{pos, wrong, correct}]
    this.found = new Set();
    this.misses = 0;
    this.missFlash = null; // { index, ms } 误点闪烁
    this.locked = false;
    this.pending = null;

    this._layout();
  }

  _layout() {
    const w = this.app.width;
    const cell = CHAR_SIZE + CHAR_GAP;
    const perRow = Math.max(1, Math.floor((w - 56) / cell));
    this.charRects = this.chars.map((_, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const countInRow = Math.min(perRow, this.chars.length - row * perRow);
      const rowW = countInRow * cell - CHAR_GAP;
      return {
        x: (w - rowW) / 2 + col * cell,
        y: 230 + row * (cell + 14),
        width: CHAR_SIZE,
        height: CHAR_SIZE,
      };
    });
  }

  _typoAt(index) {
    return this.typos.find((t) => t.pos === index) || null;
  }

  onTouchStart(x, y) {
    if (this.locked) return;

    for (let i = 0; i < this.charRects.length; i++) {
      if (!pointInRect(x, y, this.charRects[i])) continue;

      const typo = this._typoAt(i);
      if (typo && !this.found.has(i)) {
        this.found.add(i);
        if (this.found.size === this.typos.length) {
          this.locked = true;
          this.pending = { delay: 700, result: { correct: true } };
        }
      } else if (!typo) {
        this.misses += 1;
        this.missFlash = { index: i, ms: 450 };
        if (this.misses >= MAX_MISSES) {
          this.locked = true;
          this.pending = { delay: 700, result: { correct: false } };
        }
      }
      return;
    }
  }

  update(dt) {
    if (this.missFlash) {
      this.missFlash.ms -= dt;
      if (this.missFlash.ms <= 0) this.missFlash = null;
    }
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

    drawText(ctx, `找出文中的错别字（共 ${this.typos.length} 处）`, w / 2, 156, {
      size: 15,
      color: THEME.gray,
    });

    this.chars.forEach((ch, i) => {
      const rect = this.charRects[i];
      const typo = this._typoAt(i);
      const isFound = this.found.has(i);
      const isMissFlash = this.missFlash && this.missFlash.index === i;

      if (isFound) {
        // 找到的错字：朱红底 + 划去原字，上方标注正字
        fillRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 6, THEME.accent);
        drawText(ctx, ch, rect.x + rect.width / 2, rect.y + rect.height / 2 + 1, {
          size: 22,
          color: THEME.white,
        });
        ctx.save();
        ctx.strokeStyle = THEME.white;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(rect.x + 6, rect.y + rect.height / 2);
        ctx.lineTo(rect.x + rect.width - 6, rect.y + rect.height / 2);
        ctx.stroke();
        ctx.restore();
        drawText(ctx, typo.correct, rect.x + rect.width / 2, rect.y - 11, {
          size: 15,
          bold: true,
          color: THEME.accent,
        });
      } else if (isMissFlash) {
        // 误点：灰底闪烁
        fillRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 6, THEME.faint);
        drawText(ctx, ch, rect.x + rect.width / 2, rect.y + rect.height / 2 + 1, {
          size: 22,
          color: THEME.gray,
        });
      } else {
        drawText(ctx, ch, rect.x + rect.width / 2, rect.y + rect.height / 2 + 1, {
          size: 22,
        });
      }

      // 判负后揭示漏掉的错字
      if (this.locked && typo && !isFound) {
        strokeRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 6, THEME.accent, 2);
      }
    });

    // 进度与容错
    const hearts = '●'.repeat(MAX_MISSES - this.misses) + '○'.repeat(this.misses);
    drawText(
      ctx,
      `已找到 ${this.found.size}/${this.typos.length} · 容错 ${hearts}`,
      w / 2,
      this.app.height - 96,
      { size: 13, color: THEME.gray }
    );
  }
}
