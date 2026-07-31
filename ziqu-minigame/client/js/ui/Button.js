/**
 * 按钮组件（Canvas 绘制 + 命中检测）
 * variant:
 *  - primary  浓墨底白字
 *  - accent   朱红底白字（强调操作）
 *  - ghost    描边透明底
 */
import {
  THEME,
  fillRoundRect,
  strokeRoundRect,
  drawText,
  pointInRect,
} from '../utils/canvas.js';

export default class Button {
  constructor({
    x = 0,
    y = 0,
    width = 200,
    height = 48,
    text = '',
    variant = 'primary',
    fontSize = 17,
    radius = 10,
    disabled = false,
    onTap = null,
  } = {}) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.text = text;
    this.variant = variant;
    this.fontSize = fontSize;
    this.radius = radius;
    this.disabled = disabled;
    this.onTap = onTap;
  }

  contains(px, py) {
    return pointInRect(px, py, this);
  }

  /**
   * 命中则触发 onTap
   * @returns {boolean} 是否命中本按钮
   */
  tap(px, py) {
    if (this.disabled || !this.contains(px, py)) return false;
    if (typeof this.onTap === 'function') this.onTap();
    return true;
  }

  render(ctx) {
    const { x, y, width, height, radius } = this;
    ctx.save();
    if (this.disabled) ctx.globalAlpha = 0.4;

    let textColor = THEME.white;
    if (this.variant === 'accent') {
      fillRoundRect(ctx, x, y, width, height, radius, THEME.accent);
    } else if (this.variant === 'ghost') {
      strokeRoundRect(ctx, x, y, width, height, radius, THEME.ink, 1.5);
      textColor = THEME.ink;
    } else {
      fillRoundRect(ctx, x, y, width, height, radius, THEME.ink);
    }

    drawText(ctx, this.text, x + width / 2, y + height / 2 + 1, {
      size: this.fontSize,
      color: textColor,
      bold: true,
    });
    ctx.restore();
  }
}
