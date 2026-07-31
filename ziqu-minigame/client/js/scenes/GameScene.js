/**
 * 游戏场景
 * 一局取 5 关，按关卡 type 调度四种玩法模式；
 * 每关结束后短暂反馈再进入下一关，整局结束进入结算场景。
 */
import DisassembleMode from '../gameplay/DisassembleMode.js';
import ComposeMode from '../gameplay/ComposeMode.js';
import TypoFindMode from '../gameplay/TypoFindMode.js';
import RiddleMode from '../gameplay/RiddleMode.js';
import {
  THEME,
  drawText,
  drawDivider,
  strokeRoundRect,
  pointInRect,
} from '../utils/canvas.js';

const MODES = {
  disassemble: DisassembleMode,
  compose: ComposeMode,
  typoFind: TypoFindMode,
  riddle: RiddleMode,
};

const MODE_LABEL = {
  disassemble: '拆字重构',
  compose: '字根合成',
  typoFind: '错字找茬',
  riddle: '妙语解谜',
};

const SESSION_SIZE = 5;
const FEEDBACK_MS = 900;

export default class GameScene {
  constructor(app) {
    this.app = app;
  }

  enter(params = {}) {
    this.challenge = params.challenge || null;
    this.session = this.app.levelManager.getSessionLevels(SESSION_SIZE);
    this.round = 0;
    this.results = [];
    this.feedback = null;
    this.mode = null;
    this.quitRect = { x: 20, y: 52, width: 36, height: 36 };

    if (!this.session.length) {
      this.app.toast.show('没有可用关卡');
      this.app.switchScene('menu');
      return;
    }
    this._startRound();
  }

  exit() {
    this.mode = null;
  }

  _startRound() {
    const level = this.session[this.round];
    const ModeClass = MODES[level.type];
    this.mode = new ModeClass(this.app, level, (res) => this._onRoundFinish(res));
    this.roundStart = Date.now();
  }

  _onRoundFinish({ correct }) {
    const level = this.session[this.round];
    const timeMs = Date.now() - this.roundStart;
    // 得分 = 难度基础分 + 时间加成（越快越高，最多 100）
    const score = correct
      ? level.difficulty * 100 + Math.max(0, 100 - Math.floor(timeMs / 300))
      : 0;

    this.results.push({ level, correct, timeMs, score });
    this.app.levelManager.recordResult(level, { correct, score });

    // 静默上报单关成绩（云函数契约 submitScore）
    this.app.cloud.submitScore({
      levelId: level.id,
      score,
      timeMs,
      answerSequence: this.results.map((r) => (r.correct ? '1' : '0')),
    });

    this.feedback = { correct, ms: FEEDBACK_MS };
  }

  update(dt) {
    if (this.feedback) {
      this.feedback.ms -= dt;
      if (this.feedback.ms <= 0) {
        this.feedback = null;
        this.round += 1;
        if (this.round >= this.session.length) {
          this.app.switchScene('result', {
            results: this.results,
            challenge: this.challenge,
          });
        } else {
          this._startRound();
        }
      }
      return;
    }
    if (this.mode) this.mode.update(dt);
  }

  onTouchStart(x, y) {
    if (pointInRect(x, y, this.quitRect)) {
      this.app.switchScene('menu');
      return;
    }
    if (!this.feedback && this.mode) this.mode.onTouchStart(x, y);
  }

  render(ctx) {
    const { width: w } = this.app;
    const level = this.session[this.round];
    if (!level) return;

    // 顶部栏：退出 / 进度 / 计时
    const q = this.quitRect;
    strokeRoundRect(ctx, q.x, q.y, q.width, q.height, 8, THEME.faint, 1.5);
    drawText(ctx, '✕', q.x + q.width / 2, q.y + q.height / 2 + 1, {
      size: 16,
      color: THEME.gray,
    });
    drawText(
      ctx,
      `第 ${this.round + 1}/${this.session.length} 题 · ${MODE_LABEL[level.type]}`,
      w / 2,
      70,
      { size: 15, bold: true }
    );
    const elapsed = Math.floor((Date.now() - this.roundStart) / 1000);
    drawText(ctx, `${elapsed}s`, w - 32, 70, {
      size: 14,
      align: 'right',
      color: THEME.gray,
    });

    // 关卡标题 + 难度
    drawText(ctx, level.title || '', w / 2, 110, { size: 17 });
    drawText(ctx, '★'.repeat(level.difficulty) + '☆'.repeat(5 - level.difficulty),
      w / 2, 132, { size: 11, color: THEME.accent });
    drawDivider(ctx, 24, w - 24, 144);

    if (this.mode) this.mode.render(ctx);

    // 单关反馈遮罩
    if (this.feedback) {
      ctx.save();
      ctx.fillStyle = 'rgba(246,243,236,0.86)';
      ctx.fillRect(0, 0, this.app.width, this.app.height);
      ctx.restore();
      const ok = this.feedback.correct;
      drawText(ctx, ok ? '对' : '错', w / 2, this.app.height * 0.42, {
        size: 96,
        bold: true,
        color: ok ? THEME.accent : THEME.gray,
      });
      drawText(ctx, ok ? '妙哉！' : '再接再厉', w / 2, this.app.height * 0.42 + 84, {
        size: 16,
        color: THEME.gray,
      });
    }
  }
}
