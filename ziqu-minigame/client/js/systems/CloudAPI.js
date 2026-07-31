/**
 * 云函数调用封装层（Task#3 云端契约）
 *
 * 云函数契约：
 *  1. submitScore     { levelId, score, timeMs, answerSequence } → { ok, rank, newBest }
 *  2. dailySignIn     {}                                         → { ok, consecutiveDays, reward }
 *  3. createChallenge { levelId, score, timeMs, friendOpenId? }  → { ok, challengeId }
 *  4. acceptChallenge { challengeId, score, timeMs }             → { ok, result: "win"|"lose"|"tie" }
 *  5. getLeaderboard  { type: "daily"|"weekly"|"season" }        → { ok, list: [...] }
 *
 * 云环境不可用（开发者工具未开通 / 云函数未部署）时自动降级为本地 mock，
 * 保证客户端流程可独立联调。
 */

// TODO(上线前): 替换为微信云开发控制台的实际云环境 ID（当前为占位符）
const CLOUD_ENV = 'ziqu-prod'; // Task#3 部署后替换为实际环境 ID

// 签到奖励代码 → 展示文案（云端返回代码型 reward，展示前需映射）
const REWARD_LABELS = {
  coin_10: '铜钱 ×10',
};

/** 未知代码原样返回，避免新奖励类型上线时展示为空 */
function rewardLabel(code) {
  return REWARD_LABELS[code] || code;
}

export default class CloudAPI {
  constructor() {
    this.useMock = false;
  }

  init() {
    try {
      if (wx.cloud) {
        wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
      } else {
        this.useMock = true;
      }
    } catch (e) {
      console.warn('[CloudAPI] cloud init failed, fallback to mock:', e);
      this.useMock = true;
    }
    if (this.useMock) {
      console.warn('[CloudAPI] running in MOCK mode');
    }
  }

  /**
   * 统一调用入口
   * @returns {Promise<object>} 云函数 result；失败时降级 mock
   */
  call(name, data = {}) {
    if (this.useMock) {
      return Promise.resolve(this._mock(name, data));
    }
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name,
        data,
        success: (res) => resolve(res.result || { ok: false }),
        fail: (err) => {
          console.warn(`[CloudAPI] ${name} failed, fallback to mock:`, err);
          resolve(this._mock(name, data));
        },
      });
    });
  }

  // ---- 五个云函数的语义化封装 ----

  submitScore({ levelId, score, timeMs, answerSequence = [] }) {
    return this.call('submitScore', { levelId, score, timeMs, answerSequence });
  }

  dailySignIn() {
    return this.call('dailySignIn', {}).then((res) => {
      if (res && res.reward) {
        return { ...res, reward: rewardLabel(res.reward) };
      }
      return res;
    });
  }

  createChallenge({ levelId, score, timeMs, friendOpenId }) {
    const data = { levelId, score, timeMs };
    if (friendOpenId) data.friendOpenId = friendOpenId;
    return this.call('createChallenge', data);
  }

  acceptChallenge({ challengeId, score, timeMs }) {
    return this.call('acceptChallenge', { challengeId, score, timeMs });
  }

  getLeaderboard(type = 'daily') {
    return this.call('getLeaderboard', { type });
  }

  /**
   * 把总分同步到开放数据域托管存储，供好友排行（open-data 子域）读取
   */
  syncOpenDataScore(score) {
    if (!wx.setUserCloudStorage) return;
    wx.setUserCloudStorage({
      KVDataList: [{ key: 'score', value: String(score) }],
      fail: (err) => console.warn('[CloudAPI] setUserCloudStorage failed:', err),
    });
  }

  // ---- 本地 mock（与契约返回结构一致） ----

  _mock(name, data) {
    switch (name) {
      case 'submitScore':
        return {
          ok: true,
          rank: 1 + Math.floor(Math.random() * 50),
          newBest: (data.score || 0) > 300,
        };
      case 'dailySignIn':
        return { ok: true, consecutiveDays: 1, reward: 'coin_10' };
      case 'createChallenge':
        return { ok: true, challengeId: `mock-${Date.now()}` };
      case 'acceptChallenge': {
        const results = ['win', 'lose', 'tie'];
        return { ok: true, result: results[Math.floor(Math.random() * 3)] };
      }
      case 'getLeaderboard': {
        const names = ['墨客', '砚台', '狼毫', '青简', '朱批', '拓片', '刻刀', '宣纸'];
        const list = names.map((nickname, i) => ({
          openId: `mock-open-id-${i}`,
          nickname,
          avatar: '',
          score: 980 - i * 87,
          rank: i + 1,
        }));
        return { ok: true, list };
      }
      default:
        return { ok: false, error: `unknown function: ${name}` };
    }
  }
}
