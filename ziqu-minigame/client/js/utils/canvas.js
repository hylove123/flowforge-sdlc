/**
 * Canvas 绘制工具函数
 * 极简水墨风：黑 / 白 / 灰 + 朱红强调色（#C53D43），字体走系统默认。
 */

export const THEME = {
  bg: '#F6F3EC',      // 宣纸底色
  ink: '#2B2B2B',     // 浓墨
  gray: '#9A948A',    // 淡墨
  faint: '#E7E2D8',   // 极淡（边框 / 分割线 / 占位）
  accent: '#C53D43',  // 朱红（唯一强调色）
  white: '#FFFFFF',
};

export function font(size, bold = false) {
  return `${bold ? 'bold ' : ''}${size}px sans-serif`;
}

export function drawText(ctx, text, x, y, opts = {}) {
  const {
    size = 16,
    color = THEME.ink,
    align = 'center',
    baseline = 'middle',
    bold = false,
    alpha = 1,
  } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font(size, bold);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function fillRoundRect(ctx, x, y, w, h, r, color) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export function strokeRoundRect(ctx, x, y, w, h, r, color, lineWidth = 1) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

export function pointInRect(px, py, rect) {
  return (
    px >= rect.x &&
    px <= rect.x + rect.width &&
    py >= rect.y &&
    py <= rect.y + rect.height
  );
}

/**
 * 中文按字符折行（CJK 文本无空格，按逐字宽度计算）
 * @returns {string[]} 折行后的行数组
 */
export function wrapLines(ctx, text, maxWidth, size) {
  ctx.save();
  ctx.font = font(size);
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      continue;
    }
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  return lines;
}

/** 淡墨分割线 */
export function drawDivider(ctx, x1, x2, y, color = THEME.faint) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

/** 朱红印章式圆点（标题装饰） */
export function drawSealDot(ctx, x, y, r, color = THEME.accent) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 洗牌（Fisher-Yates），返回新数组 */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
