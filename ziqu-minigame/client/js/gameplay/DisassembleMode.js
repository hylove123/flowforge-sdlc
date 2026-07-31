/**
 * 拆字重构玩法
 * 展示目标汉字与散落的字根块，玩家点选正确字根组合还原汉字。
 * 允许 2 次提交机会，机会用尽判负。
 */
import {
  THEME,
  drawText,
  fillRoundRect,
  strokeRoundRect,
  pointInRect,
  shuffle,
} from '../utils/canvas.js';

const SLOT_SIZE = 56;
const SLOT_GAP = 14;
const TILE_SIZE = 64;
const TILE_GAP = 16;

export default class DisassembleMode {
  /**
   * @param {object} app App 实例
   * @param {object} level 关卡（type=disassemble）
   * @param {(result:{correct:boolean})=>void} onFinish
   */
  constructor(app, level, onFinish) {
    this.app = app;
    this.level = level;
    this.onFinish = onFinish;

    const { char, radicals = [], distractors = [] } = level.data;
    this.char = char;
    this.radicals = radicals;
    this.tiles = shuffle([...radicals, ...distractors]).map((ch) => ({
      char: ch,
      used: false,
    }));
    this.selection = []; // 已选 tile 下标（有序）
    this.attemptsLeft = 2;
    this.locked = false;
    this.flashMs = 0;      // 提交错误时的红闪
    this.pending = null;   // { delay, result } 延迟结束

    this._layout();
  }

  _layout() {
    const w = this.app.width;
    this.targetY = 216;

    // 答案槽：与字根数一致
    const n = this.radicals.length;
    const slotsW = n * SLOT_SIZE + (n - 1) * SLOT_GAP;
    this.slotRects = [];
    for (let i = 0; i < n; i++) {
      this.slotRects.push({
        x: (w - slotsW) / 2 + i * (SLOT_SIZE + SLOT_GAP),
        y: 300,
        width: SLOT_SIZE,
        height: SLOT_SIZE,
      });
    }

    // 字根块：每行最多 4 个，居中排布
    const perRow = Math.min(4, this.tiles.length);
    this.tiles.forEach((tile, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const countInRow = Math.min(perRow, this.tiles.length - row * perRow);
      const rowW = countInRow * TILE_SIZE + (countInRow - 1) * TILE_GAP;
      tile.rect = {
        x: (w - rowW) / 2 + col * (TILE_SIZE + TILE_GAP),
        y: 400 + row * (TILE_SIZE + TILE_GAP),
        width: TILE_SIZE,
        height: TILE_SIZE,
      };
    });
  }

  onTouchStart(x, y) {
    if (this.locked) return;

    // 点击已填的槽 → 撤回该字根
    for (let i = 0; i < this.selection.length; i++) {
      if (pointInRect(x, y, this.slotRects[i])) {
        const tileIndex = this.selection.splice(i, 1)[0];
        this.tiles[tileIndex].used = false;
        return;
      }
    }

    // 点击字根块 → 填入下一个空槽
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      if (!tile.used && pointInRect(x, y, tile.rect)) {
        tile.used = true;
        this.selection.push(i);
        if (this.selection.length === this.radicals.length) {
          this._submit();
        }
        return;
      }
    }
  }

  _submit() {
    const picked = this.selection.map((i) => this.tiles[i].char);
    // 多重集合比较（字根允许重复，如「林」= 木 + 木）
    const remain = this.radicals.slice();
    const correct = picked.every((ch) => {
      const idx = remain.indexOf(ch);
      if (idx === -1) return false;
      remain.splice(idx, 1);
      return true;
    });

    if (correct) {
      this.locked = true;
      this.solved = true;
      this.pending = { delay: 500, result: { correct: true } };
      return;
    }

    this.attemptsLeft -= 1;
    this.flashMs = 600;
    if (this.attemptsLeft <= 0) {
      this.locked = true;
      this.pending = { delay: 700, result: { correct: false } };
    }
  }

  update(dt) {
    if (this.flashMs > 0) {
      this.flashMs -= dt;
      // 红闪结束后清空错误选择（判负时保留展示）
      if (this.flashMs <= 0 && !this.locked) {
        this.selection.forEach((i) => (this.tiles[i].used = false));
        this.selection = [];
      }
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

    drawText(ctx, '点选字根，还原这个汉字', w / 2, 156, {
      size: 15,
      color: THEME.gray,
    });

    // 目标汉字：未解出时为淡墨轮廓，解出后转朱红
    drawText(ctx, this.char, w / 2, this.targetY, {
      size: 84,
      bold: true,
      color: this.solved ? THEME.accent : THEME.faint,
    });

    // 答案槽
    const flashing = this.flashMs > 0;
    this.slotRects.forEach((rect, i) => {
      const tileIndex = this.selection[i];
      const borderColor = flashing
        ? THEME.accent
        : tileIndex !== undefined
          ? THEME.ink
          : THEME.faint;
      strokeRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 8, borderColor, 2);
      if (tileIndex !== undefined) {
        drawText(
          ctx,
          this.tiles[tileIndex].char,
          rect.x + rect.width / 2,
          rect.y + rect.height / 2 + 2,
          { size: 32, bold: true, color: flashing ? THEME.accent : THEME.ink }
        );
      }
    });

    // 字根块
    this.tiles.forEach((tile) => {
      const { rect } = tile;
      ctx.save();
      if (tile.used) ctx.globalAlpha = 0.25;
      fillRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 10, THEME.white);
      strokeRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 10, THEME.ink, 1.5);
      drawText(ctx, tile.char, rect.x + rect.width / 2, rect.y + rect.height / 2 + 2, {
        size: 34,
        bold: true,
      });
      ctx.restore();
    });

    // 剩余机会
    drawText(ctx, `剩余机会 ${'●'.repeat(this.attemptsLeft)}${'○'.repeat(2 - this.attemptsLeft)}`,
      w / 2, this.app.height - 96, { size: 13, color: THEME.gray });
  }
}
