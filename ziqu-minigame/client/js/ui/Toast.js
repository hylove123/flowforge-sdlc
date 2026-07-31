/**
 * Toast 提示组件
 * 由 App 统一持有并在每帧场景渲染之后叠加绘制。
 */
import { THEME, fillRoundRect, drawText, font } from '../utils/canvas.js';

const DEFAULT_DURATION = 1600;
const FADE_MS = 240;

export default class Toast {
  constructor(app) {
    this.app = app;
    this.queue = [];
    this.current = null;
    this.elapsed = 0;
  }

  show(text, duration = DEFAULT_DURATION) {
    this.queue.push({ text: String(text), duration });
  }

  update(dt) {
    if (!this.current) {
      if (this.queue.length) {
        this.current = this.queue.shift();
        this.elapsed = 0;
      }
      return;
    }
    this.elapsed += dt;
    if (this.elapsed >= this.current.duration + FADE_MS * 2) {
      this.current = null;
      this.elapsed = 0;
    }
  }

  render(ctx) {
    if (!this.current) return;
    const { text, duration } = this.current;
    // 淡入 → 停留 → 淡出
    let alpha = 1;
    if (this.elapsed < FADE_MS) {
      alpha = this.elapsed / FADE_MS;
    } else if (this.elapsed > FADE_MS + duration) {
      alpha = 1 - (this.elapsed - FADE_MS - duration) / FADE_MS;
    }
    alpha = Math.max(0, Math.min(1, alpha));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = font(14);
    const textWidth = ctx.measureText(text).width;
    const w = Math.min(this.app.width - 48, textWidth + 40);
    const h = 40;
    const x = (this.app.width - w) / 2;
    const y = this.app.height * 0.78;
    fillRoundRect(ctx, x, y, w, h, h / 2, 'rgba(43,43,43,0.92)');
    drawText(ctx, text, this.app.width / 2, y + h / 2 + 1, {
      size: 14,
      color: THEME.white,
    });
    ctx.restore();
  }
}
