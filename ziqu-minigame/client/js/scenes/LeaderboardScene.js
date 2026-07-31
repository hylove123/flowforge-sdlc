/**
 * 排行榜场景
 * - 好友榜：开放数据域（open-data 子域）通过共享 Canvas 绘制，主域贴图展示
 * - 今日 / 本周 / 赛季：走云函数 getLeaderboard
 */
import {
  THEME,
  drawText,
  drawDivider,
  fillRoundRect,
  strokeRoundRect,
  pointInRect,
} from '../utils/canvas.js';

const TABS = [
  { key: 'friend', label: '好友' },
  { key: 'daily', label: '今日' },
  { key: 'weekly', label: '本周' },
  { key: 'season', label: '赛季' },
];

export default class LeaderboardScene {
  constructor(app) {
    this.app = app;
    this.openDataContext = null;
  }

  enter() {
    const { width: w, height: h } = this.app;
    this.backRect = { x: 20, y: 52, width: 36, height: 36 };
    this.listRect = { x: 24, y: 196, width: w - 48, height: h - 280 };

    const tabW = (w - 48) / TABS.length;
    this.tabRects = TABS.map((_, i) => ({
      x: 24 + i * tabW,
      y: 140,
      width: tabW,
      height: 40,
    }));

    this.tab = 'friend';
    this.list = [];
    this.loading = false;

    if (!this.openDataContext && wx.getOpenDataContext) {
      try {
        this.openDataContext = wx.getOpenDataContext();
      } catch (e) {
        console.warn('[Leaderboard] open data context unavailable:', e);
      }
    }
    this._showFriendRank();
  }

  _showFriendRank() {
    if (!this.openDataContext) return;
    // 通知子域按列表区域尺寸绘制好友排行
    this.openDataContext.postMessage({
      type: 'showFriendRank',
      width: Math.round(this.listRect.width),
      height: Math.round(this.listRect.height),
    });
  }

  _loadCloudRank(type) {
    this.loading = true;
    this.list = [];
    this.app.cloud.getLeaderboard(type).then((res) => {
      if (this.tab !== type) return; // 已切走
      this.loading = false;
      this.list = (res && res.ok && res.list) || [];
    });
  }

  onTouchStart(x, y) {
    if (pointInRect(x, y, this.backRect)) {
      this.app.switchScene('menu');
      return;
    }
    for (let i = 0; i < this.tabRects.length; i++) {
      if (pointInRect(x, y, this.tabRects[i])) {
        const { key } = TABS[i];
        if (key === this.tab) return;
        this.tab = key;
        if (key === 'friend') {
          this._showFriendRank();
        } else {
          this._loadCloudRank(key);
        }
        return;
      }
    }
  }

  update() {}

  render(ctx) {
    const { width: w } = this.app;

    // 顶部栏
    const b = this.backRect;
    strokeRoundRect(ctx, b.x, b.y, b.width, b.height, 8, THEME.faint, 1.5);
    drawText(ctx, '‹', b.x + b.width / 2, b.y + b.height / 2, { size: 22, color: THEME.gray });
    drawText(ctx, '排 行 榜', w / 2, 70, { size: 20, bold: true });

    // Tab 栏
    TABS.forEach((tab, i) => {
      const r = this.tabRects[i];
      const active = tab.key === this.tab;
      drawText(ctx, tab.label, r.x + r.width / 2, r.y + r.height / 2, {
        size: 15,
        bold: active,
        color: active ? THEME.accent : THEME.gray,
      });
      if (active) {
        fillRoundRect(ctx, r.x + r.width / 2 - 14, r.y + r.height - 4, 28, 3, 1.5, THEME.accent);
      }
    });
    drawDivider(ctx, 24, w - 24, 184);

    if (this.tab === 'friend') {
      this._renderFriendRank(ctx);
    } else {
      this._renderCloudRank(ctx);
    }
  }

  _renderFriendRank(ctx) {
    const r = this.listRect;
    if (this.openDataContext && this.openDataContext.canvas) {
      try {
        // 共享 Canvas 内容贴到主域
        ctx.drawImage(this.openDataContext.canvas, r.x, r.y, r.width, r.height);
        return;
      } catch (e) {
        // 子域尚未完成绘制时可能抛错，忽略等下一帧
      }
    }
    drawText(ctx, '好友排行需在微信环境中查看', r.x + r.width / 2, r.y + 80, {
      size: 14,
      color: THEME.gray,
    });
  }

  _renderCloudRank(ctx) {
    const r = this.listRect;
    if (this.loading) {
      drawText(ctx, '加载中…', r.x + r.width / 2, r.y + 80, { size: 14, color: THEME.gray });
      return;
    }
    if (!this.list.length) {
      drawText(ctx, '暂无榜单数据', r.x + r.width / 2, r.y + 80, { size: 14, color: THEME.gray });
      return;
    }

    const rowH = 46;
    const maxRows = Math.floor(r.height / rowH);
    this.list.slice(0, maxRows).forEach((item, i) => {
      const y = r.y + i * rowH + rowH / 2;
      const isTop3 = item.rank <= 3;
      drawText(ctx, String(item.rank), r.x + 20, y, {
        size: 16,
        bold: isTop3,
        color: isTop3 ? THEME.accent : THEME.gray,
      });
      drawText(ctx, item.nickname || '神秘书生', r.x + 52, y, {
        size: 15,
        align: 'left',
      });
      drawText(ctx, String(item.score), r.x + r.width - 16, y, {
        size: 15,
        bold: true,
        align: 'right',
        color: THEME.ink,
      });
      drawDivider(ctx, r.x, r.x + r.width, r.y + (i + 1) * rowH);
    });
  }
}
