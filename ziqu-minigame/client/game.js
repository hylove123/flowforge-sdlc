/**
 * 字趣 · 微信小游戏入口
 *
 * 原生小游戏入口约定：首个 wx.createCanvas() 返回上屏 Canvas，
 * 之后交由 App 完成场景管理与主循环。
 */
import App from './js/app.js';

const canvas = wx.createCanvas();

const app = new App(canvas);
app.start();

// 挂到全局便于调试（微信开发者工具 Console 中可通过 GameGlobal.app 访问）
GameGlobal.app = app;
