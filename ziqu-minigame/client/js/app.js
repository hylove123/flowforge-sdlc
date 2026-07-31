/**
 * 应用生命周期与场景管理
 * 简单状态机：Menu → Game → Result → Menu / Leaderboard 循环。
 * 统一持有 Canvas、系统服务（关卡/段位/广告/云）与主循环。
 */
import MenuScene from './scenes/MenuScene.js';
import GameScene from './scenes/GameScene.js';
import ResultScene from './scenes/ResultScene.js';
import LeaderboardScene from './scenes/LeaderboardScene.js';
import LevelManager from './systems/LevelManager.js';
import RankSystem from './systems/RankSystem.js';
import AdManager from './systems/AdManager.js';
import CloudAPI from './systems/CloudAPI.js';
import Toast from './ui/Toast.js';
import { THEME } from './utils/canvas.js';

const MAX_FRAME_MS = 100; // 切后台回来时的 dt 保护

export default class App {
  constructor(canvas) {
    this.canvas = canvas;

    const info = wx.getSystemInfoSync();
    this.width = info.windowWidth;
    this.height = info.windowHeight;
    this.pixelRatio = info.pixelRatio || 1;

    // 按物理像素铺开，再用逻辑像素绘制
    canvas.width = this.width * this.pixelRatio;
    canvas.height = this.height * this.pixelRatio;
    this.ctx = canvas.getContext('2d');
    this.ctx.scale(this.pixelRatio, this.pixelRatio);

    // 系统服务
    this.levelManager = new LevelManager();
    this.rankSystem = new RankSystem();
    this.adManager = new AdManager();
    this.cloud = new CloudAPI();
    this.toast = new Toast(this);

    // 场景状态机
    this.scenes = {
      menu: new MenuScene(this),
      game: new GameScene(this),
      result: new ResultScene(this),
      leaderboard: new LeaderboardScene(this),
    };
    this.scene = null;
    this.pendingChallenge = null; // 好友挑战（从分享 query 进入）
    this.lastTime = 0;
  }

  start() {
    this.cloud.init();
    const levelCount = this.levelManager.load();
    this.adManager.init({ width: this.width, height: this.height, toast: this.toast });

    this._bindTouch();
    this._bindLifecycle();
    if (wx.showShareMenu) wx.showShareMenu({});

    // 冷启动时可能带着挑战参数
    if (wx.getLaunchOptionsSync) {
      this._checkChallengeQuery(wx.getLaunchOptionsSync().query);
    }

    this.switchScene('menu');
    if (!levelCount) this.toast.show('关卡数据加载失败');

    const loop = (ts) => {
      this._frame(ts);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  switchScene(name, params = {}) {
    const next = this.scenes[name];
    if (!next) {
      console.warn('[App] unknown scene:', name);
      return;
    }
    if (this.scene && this.scene.exit) this.scene.exit();
    this.scene = next;
    if (this.scene.enter) this.scene.enter(params);
  }

  _bindTouch() {
    wx.onTouchStart((e) => {
      const t = e.touches && e.touches[0];
      if (t && this.scene && this.scene.onTouchStart) {
        this.scene.onTouchStart(t.clientX, t.clientY);
      }
    });
    wx.onTouchMove((e) => {
      const t = e.touches && e.touches[0];
      if (t && this.scene && this.scene.onTouchMove) {
        this.scene.onTouchMove(t.clientX, t.clientY);
      }
    });
    wx.onTouchEnd((e) => {
      const t = (e.changedTouches && e.changedTouches[0]) || null;
      if (t && this.scene && this.scene.onTouchEnd) {
        this.scene.onTouchEnd(t.clientX, t.clientY);
      }
    });
  }

  _bindLifecycle() {
    // 热启动（从分享卡点进来）也要识别挑战参数
    wx.onShow((res) => {
      this._checkChallengeQuery(res && res.query);
    });
  }

  _checkChallengeQuery(query) {
    if (!query || !query.challengeId) return;
    this.pendingChallenge = {
      challengeId: query.challengeId,
      fromScore: Number(query.score) || 0,
    };
    this.toast.show('收到好友挑战，去主菜单应战！');
    // 若正停留在主菜单，刷新按钮布局露出应战入口
    if (this.scene === this.scenes.menu) this.scenes.menu.enter();
  }

  _frame(ts) {
    const dt = Math.min(MAX_FRAME_MS, this.lastTime ? ts - this.lastTime : 16);
    this.lastTime = ts;

    if (this.scene && this.scene.update) this.scene.update(dt);
    this.toast.update(dt);

    const { ctx } = this;
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.scene && this.scene.render) this.scene.render(ctx);
    this.toast.render(ctx);
  }
}
