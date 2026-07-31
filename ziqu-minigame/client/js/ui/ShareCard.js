/**
 * 战绩分享卡片
 * 用离屏 Canvas（非首个 wx.createCanvas()）绘制成绩图，
 * 导出临时文件后交给 wx.shareAppMessage 作为 imageUrl。
 * 分享卡比例 5:4（微信转发卡片推荐比例）。
 */
import {
  THEME,
  drawText,
  fillRoundRect,
  strokeRoundRect,
  drawSealDot,
  drawDivider,
} from '../utils/canvas.js';

const CARD_W = 500;
const CARD_H = 400;

/**
 * 绘制分享卡并导出临时图片路径
 * @param {{score:number, correct:number, total:number, rankName:string, challenge?:boolean}} data
 * @returns {string} 临时文件路径，失败时返回 ''
 */
export function createShareCardImage(data = {}) {
  const {
    score = 0,
    correct = 0,
    total = 0,
    rankName = '白丁',
    challenge = false,
  } = data;

  try {
    const canvas = wx.createCanvas(); // 非首个调用 → 离屏 Canvas
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');

    // 宣纸底 + 细边框
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    strokeRoundRect(ctx, 14, 14, CARD_W - 28, CARD_H - 28, 8, THEME.faint, 2);

    // 标题 + 朱红印记
    drawText(ctx, '字 趣', CARD_W / 2, 72, { size: 44, bold: true });
    drawSealDot(ctx, CARD_W / 2 + 78, 56, 7);
    drawText(ctx, '拆字 · 合成 · 找茬 · 解谜', CARD_W / 2, 112, {
      size: 16,
      color: THEME.gray,
    });
    drawDivider(ctx, 60, CARD_W - 60, 140);

    // 成绩主体
    drawText(ctx, String(score), CARD_W / 2, 208, {
      size: 72,
      bold: true,
      color: THEME.accent,
    });
    drawText(ctx, `答对 ${correct}/${total} 题 · 段位「${rankName}」`, CARD_W / 2, 268, {
      size: 20,
    });

    // 底部文案
    const slogan = challenge
      ? '敢来接受我的汉字挑战吗？'
      : '汉字功底大比拼，来试试你能得几分';
    fillRoundRect(ctx, 90, 310, CARD_W - 180, 48, 24, THEME.ink);
    drawText(ctx, slogan, CARD_W / 2, 335, { size: 18, color: THEME.white });

    return canvas.toTempFilePathSync({
      x: 0,
      y: 0,
      width: CARD_W,
      height: CARD_H,
      destWidth: CARD_W,
      destHeight: CARD_H,
    });
  } catch (e) {
    console.warn('[ShareCard] generate failed:', e);
    return '';
  }
}

/**
 * 拉起转发（战绩 / 好友挑战）
 * @param {{score:number, correct:number, total:number, rankName:string, challengeId?:string}} data
 */
export function shareResult(data = {}) {
  const isChallenge = !!data.challengeId;
  const title = isChallenge
    ? `我在「字趣」拿了 ${data.score} 分，敢应战吗？`
    : `我在「字趣」拿了 ${data.score} 分，不服来战！`;
  const imageUrl = createShareCardImage({ ...data, challenge: isChallenge });
  const query = isChallenge
    ? `challengeId=${data.challengeId}&score=${data.score || 0}`
    : '';

  wx.shareAppMessage({
    title,
    imageUrl: imageUrl || undefined,
    query,
  });
}
