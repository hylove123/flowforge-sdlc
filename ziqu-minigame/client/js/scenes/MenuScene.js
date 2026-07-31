/**
 * 主菜单场景
 * 水墨标题 + 段位展示 + 开始/签到/排行榜入口，底部挂 Banner 广告。
 */
import Button from '../ui/Button.js';
import * as storage from '../utils/storage.js';
import {
  THEME,
  drawText,
  drawSealDot,
  drawDivider,
} from '../utils/canvas.js';

const SIGNIN_KEY = 'signin-date';

export default class MenuScene {
  constructor(app) {
    this.app = app;
    this.buttons = [];
  }

  enter() {
    this._buildButtons();
    this.app.adManager.showBanner();
  }

  exit() {
    this.app.adManager.hideBanner();
  }

  _buildButtons() {
    const { width: w, height: h } = this.app;
    const bw = 224;
    const bx = (w - bw) / 2;
    let y = h * 0.46;
    this.buttons = [];

    // 收到好友挑战时优先展示应战入口
    if (this.app.pendingChallenge) {
      this.buttons.push(
        new Button({
          x: bx, y, width: bw, height: 52,
          text: '⚔ 应战好友挑战',
          variant: 'accent',
          onTap: () => {
            const challenge = this.app.pendingChallenge;
            this.app.pendingChallenge = null;
            this.app.switchScene('game', { challenge });
          },
        })
      );
      y += 68;
    }

    this.buttons.push(
      new Button({
        x: bx, y, width: bw, height: 52,
        text: '开始闯关',
        variant: this.app.pendingChallenge ? 'primary' : 'accent',
        onTap: () => this.app.switchScene('game'),
      }),
      new Button({
        x: bx, y: y + 68, width: bw, height: 48,
        text: '每日签到',
        variant: 'primary',
        onTap: () => this._signIn(),
      }),
      new Button({
        x: bx, y: y + 128, width: bw, height: 48,
        text: '排 行 榜',
        variant: 'ghost',
        onTap: () => this.app.switchScene('leaderboard'),
      })
    );
  }

  _signIn() {
    const today = new Date().toDateString();
    if (storage.get(SIGNIN_KEY) === today) {
      this.app.toast.show('今天已经签过到啦');
      return;
    }
    this.app.cloud.dailySignIn().then((res) => {
      if (res && res.ok) {
        storage.set(SIGNIN_KEY, today);
        this.app.toast.show(`已连续签到 ${res.consecutiveDays} 天，获得 ${res.reward}`);
      } else {
        this.app.toast.show('签到失败，请稍后再试');
      }
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

    // 水墨标题 + 朱红印记
    drawText(ctx, '字 趣', w / 2, h * 0.19, { size: 64, bold: true });
    drawSealDot(ctx, w / 2 + 96, h * 0.19 - 24, 8);
    drawText(ctx, '拆字 · 合成 · 找茬 · 解谜', w / 2, h * 0.19 + 52, {
      size: 15,
      color: THEME.gray,
    });
    drawDivider(ctx, w * 0.2, w * 0.8, h * 0.19 + 82);

    // 段位与进度
    const rank = this.app.rankSystem.getRank();
    const lm = this.app.levelManager;
    drawText(ctx, `段位「${rank.name}」 · ${rank.points} 分`, w / 2, h * 0.34, {
      size: 17,
      bold: true,
      color: THEME.accent,
    });
    drawText(
      ctx,
      rank.nextName
        ? `距「${rank.nextName}」还差 ${Math.ceil((1 - rank.progress) * 100)}%`
        : '已登顶文曲星',
      w / 2,
      h * 0.34 + 26,
      { size: 13, color: THEME.gray }
    );
    drawText(ctx, `累计通关 ${lm.clearedCount} 关 · 题库 ${lm.totalCount} 题`, w / 2, h * 0.34 + 48, {
      size: 12,
      color: THEME.gray,
    });

    this.buttons.forEach((btn) => btn.render(ctx));

    drawText(ctx, '—— 一笔一画皆学问 ——', w / 2, h - 132, {
      size: 12,
      color: THEME.faint,
    });
  }
}
