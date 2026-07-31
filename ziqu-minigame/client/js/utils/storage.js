/**
 * 本地存储封装（wx.setStorageSync / wx.getStorageSync）
 * 统一前缀 + JSON 序列化 + 异常兜底。
 */

const PREFIX = 'ziqu:';

export function get(key, defaultValue = null) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (raw === '' || raw === null || raw === undefined) return defaultValue;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[storage] get failed:', key, e);
    return defaultValue;
  }
}

export function set(key, value) {
  try {
    wx.setStorageSync(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[storage] set failed:', key, e);
    return false;
  }
}

export function remove(key) {
  try {
    wx.removeStorageSync(PREFIX + key);
  } catch (e) {
    console.warn('[storage] remove failed:', key, e);
  }
}
