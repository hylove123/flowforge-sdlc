/**
 * 结算场景
 * 展示本局成绩与段位变化；提供再来一局 / 挑战好友 / 排行榜入口，
 * 支持看激励视频翻倍得分；进入时机播放插屏广告。
 */
import Button from '../ui/Button.js';
import { shareResult } from '../ui/ShareCard.js';
import {
  THEME,
  drawText,
  drawDivider,
  fillRoundRect,
} from '../utils/canvas.js';

const CHALLENGE_TEXT = {
  win: '挑战胜利！技高一筹',
  lose: '惜败好友，再练练吧',
  tie: '势均力敌，战成平手',
};

export default class ResultScene {
  constructor(app) {
    this.app = app;
  }

  enter(params = {}) {
    this.results = params.results || [];
    this.totalScore = this.results.reduce((s, r) => s + r.score, 0);
    this.totalTimeMs = this.results.reduce((s, r) => s + r.timeMs, 0);
    this.correctCount = this.results.filter((r) => r.correct).length;
    this.doubled = false;
    this.challengeOutcome = null;

    // 结算入段位并同步开放数据域（好友排行读取）
    this.app.rankSystem.addSession(
      this.results.map((r) => ({ correct: r.correct, timeMs: r.timeMs }))
    );
    this.rank = this.app.rankSystem.getRank();
    this.app.cloud.syncOpenDataScore(this.rank.points);

    // 应战流程：把本局成绩提交给 acceptChallenge
    if (params.challenge && params.challenge.challengeId) {
      this.app.cloud
        .acceptChallenge({
          challengeId: params.challenge.challengeId,
          score: this.totalScore,
          timeMs: this.totalTimeMs,
        })
        .then((res) => {
          if (res && res.ok) this.challengeOutcome = res.result;
        });
    }

    this.app.adManager.showInterstitial();
    this._buildButtons();
  }

  _buildButtons() {
    const { width: w, height: h } = this.app;
    const bw = 224;
    const bx = (w - bw) / 2;
    const baseY = h * 0.56;

    this.doubleBtn = new Button({
      x: bx, y: baseY, width: bw, height: 46,
      text: '▶ 看视频双倍得分',
      variant: 'ghost',
      fontSize: 15,
      onTap: () => this._doubleReward(),
    });

    this.buttons = [
      this.doubleBtn,
      new Button({
        x: bx, y: baseY + 60, width: bw, height: 50,
        text: '再来一局',
        variant: 'accent',
        onTap: () => this.app.switchScene('game'),
      }),
      new Button({
        x: bx, y: baseY + 122, width: bw, height: 48,
        text: '挑战好友',
        variant: 'primary',
        onTap: () => this._challengeFriend(),
      }),
      new Button({
        x: bx, y: baseY + 182, width: (bw - 12) / 2, height: 44,
        text: '排行榜',
        variant: 'ghost',
        fontSize: 15,
        onTap: () => this.app.switchScene('leaderboard'),
      }),
      new Button({
        x: bx + (bw + 12) / 2, y: baseY + 182, width: (bw - 12) / 2, height: 44,
        text: '主菜单',
        variant: 'ghost',
        fontSize: 15,
        onTap: () => this.app.switchScene('menu'),
      }),
    ];
  }

  _doubleReward() {
    if (this.doubled) return;
    this.app.adManager.showRewardedAd((ok) => {
      if (!ok) return;
      this.doubled = true;
      this.totalScore *= 2;
      this.doubleBtn.disabled = true;
      this.doubleBtn.text = '✓ 已翻倍';
      this.app.toast.show('得分已翻倍！');
    });
  }

  _challengeFriend() {
    if (!this.results.length) return;
    // 先在云端建立挑战，再生成分享卡拉起转发
    this.app.cloud
      .createChallenge({
        levelId: this.results[0].level.id,
        score: this.totalScore,
        timeMs: this.totalTimeMs,
      })
      .then((res) => {
        if (!res || !res.ok) {
          this.app.toast.show('挑战创建失败，请稍后再试');
          return;
        }
        shareResult({
          score: this.totalScore,
          correct: this.correctCount,
          total: this.results.length,
          rankName: this.rank.name,
          challengeId: res.challengeId,
        });
      });
  }

  onTouchStart(x, y) {
    for (const btn of this.buttons) {
      if (btn.tap(x, y)) return;
    }
  }

  update() {}

  render(ctx) {
    const { width: w, height: h } = this.app;

    drawText(ctx, '— 本局结算 —', w / 2, h * 0.12, { size: 16, color: THEME.gray });

    // 总分
    drawText(ctx, String(this.totalScore), w / 2, h * 0.23, {
      size: 72,
      bold: true,
      color: THEME.accent,
    });
    if (this.doubled) {
      drawText(ctx, '×2', w / 2 + 84, h * 0.2, { size: 20, bold: true, color: THEME.accent });
    }

    drawText(
      ctx,
      `答对 ${this.correctCount}/${this.results.length} 题 · 用时 ${(this.totalTimeMs / 1000).toFixed(1)}s`,
      w / 2,
      h * 0.23 + 60,
      { size: 15 }
    );
    drawDivider(ctx, w * 0.2, w * 0.8, h * 0.36);

    // 段位
    drawText(ctx, `当前段位「${this.rank.name}」 · ${this.rank.points} 分`, w / 2, h * 0.41, {
      size: 15,
      bold: true,
    });
    // 段位进度条
    const barW = w * 0.5;
    const barX = (w - barW) / 2;
    const barY = h * 0.44;
    fillRoundRect(ctx, barX, barY, barW, 6, 3, THEME.faint);
    fillRoundRect(ctx, barX, barY, Math.max(6, barW * this.rank.progress), 6, 3, THEME.accent);

    // 好友挑战结果横幅
    if (this.challengeOutcome) {
      drawText(ctx, CHALLENGE_TEXT[this.challengeOutcome] || '', w / 2, h * 0.5, {
        size: 16,
        bold: true,
        color: this.challengeOutcome === 'win' ? THEME.accent : THEME.gray,
      });
    }

    this.buttons.forEach((btn) => btn.render(ctx));
  }
}
