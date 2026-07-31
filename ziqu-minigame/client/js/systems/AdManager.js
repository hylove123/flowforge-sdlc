/**
 * 广告位管理
 * 封装激励视频 / 插屏 / Banner 三类广告。
 * 广告单元 ID 为占位符，上线前替换为 mp 后台申请的正式 ID。
 */

// TODO(上线前): 开通流量主后，替换为 mp 后台申请的三类正式广告位 ID（当前均为占位符）
const AD_UNITS = {
  rewarded: 'adunit-xxxxxxxxxxxxxxxx',      // 激励视频占位
  interstitial: 'adunit-yyyyyyyyyyyyyyyy',  // 插屏占位
  banner: 'adunit-zzzzzzzzzzzzzzzz',        // Banner 占位
};

export default class AdManager {
  constructor() {
    this.rewardedAd = null;
    this.interstitialAd = null;
    this.bannerAd = null;
    this.rewardCallback = null;
  }

  /**
   * @param {{width:number, height:number, toast?:object}} opts 屏幕尺寸用于 Banner 定位
   */
  init({ width, height, toast = null } = {}) {
    this.screenWidth = width || 375;
    this.screenHeight = height || 667;
    this.toast = toast;
    this._createRewardedAd();
    this._createInterstitialAd();
  }

  _createRewardedAd() {
    if (!wx.createRewardedVideoAd) return;
    try {
      this.rewardedAd = wx.createRewardedVideoAd({ adUnitId: AD_UNITS.rewarded });
      this.rewardedAd.onError((err) => {
        console.warn('[AdManager] rewarded ad error:', err);
      });
      this.rewardedAd.onClose((res) => {
        const done = !!(res && res.isEnded);
        const cb = this.rewardCallback;
        this.rewardCallback = null;
        if (cb) cb(done);
        if (!done && this.toast) this.toast.show('完整看完视频才能获得奖励哦');
      });
    } catch (e) {
      console.warn('[AdManager] create rewarded ad failed:', e);
    }
  }

  _createInterstitialAd() {
    if (!wx.createInterstitialAd) return;
    try {
      this.interstitialAd = wx.createInterstitialAd({ adUnitId: AD_UNITS.interstitial });
      this.interstitialAd.onError((err) => {
        console.warn('[AdManager] interstitial ad error:', err);
      });
    } catch (e) {
      console.warn('[AdManager] create interstitial ad failed:', e);
    }
  }

  /**
   * 播放激励视频
   * @param {(success:boolean)=>void} callback 完整观看后回调 true
   */
  showRewardedAd(callback) {
    if (!this.rewardedAd) {
      // 开发者工具 / 未配置广告位时的兜底：直接发放奖励，保证流程可调试
      console.warn('[AdManager] rewarded ad unavailable, grant reward directly (dev fallback)');
      if (callback) callback(true);
      return;
    }
    this.rewardCallback = callback || null;
    this.rewardedAd.show().catch(() => {
      // 失败后按官方建议先 load 再 show
      this.rewardedAd
        .load()
        .then(() => this.rewardedAd.show())
        .catch((err) => {
          console.warn('[AdManager] rewarded ad show failed:', err);
          const cb = this.rewardCallback;
          this.rewardCallback = null;
          if (cb) cb(true); // 广告拉取失败不阻断玩家奖励
        });
    });
  }

  /** 展示插屏广告（结算等节点调用，失败静默） */
  showInterstitial() {
    if (!this.interstitialAd) return;
    this.interstitialAd.show().catch((err) => {
      console.warn('[AdManager] interstitial show failed:', err);
    });
  }

  /** 主菜单底部 Banner */
  showBanner() {
    if (!wx.createBannerAd) return;
    if (!this.bannerAd) {
      try {
        const bannerWidth = Math.min(this.screenWidth, 300);
        this.bannerAd = wx.createBannerAd({
          adUnitId: AD_UNITS.banner,
          adIntervals: 30,
          style: {
            left: (this.screenWidth - bannerWidth) / 2,
            top: this.screenHeight - 110,
            width: bannerWidth,
          },
        });
        this.bannerAd.onError((err) => {
          console.warn('[AdManager] banner ad error:', err);
        });
        // 拿到真实尺寸后贴底居中
        this.bannerAd.onResize((size) => {
          this.bannerAd.style.left = (this.screenWidth - size.width) / 2;
          this.bannerAd.style.top = this.screenHeight - size.height;
        });
      } catch (e) {
        console.warn('[AdManager] create banner failed:', e);
        return;
      }
    }
    this.bannerAd.show().catch(() => {});
  }

  hideBanner() {
    if (this.bannerAd) this.bannerAd.hide();
  }
}
