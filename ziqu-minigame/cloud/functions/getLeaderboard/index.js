/**
 * getLeaderboard 云函数
 * 入参：{ type: "daily"|"weekly"|"season" }
 * 返回：{ ok: true, list: [{ openId, nickname, avatar, score, rank }] }
 *   或：{ ok: false, error: string }
 *
 * 逻辑：直接读取 leaderboard_cache 集合中对应类型的缓存记录（由
 *       aggregateLeaderboard 定时触发器每 10 分钟刷新）。缓存缺失时返回空列表。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const VALID_TYPES = ['daily', 'weekly', 'season']

exports.main = async (event, context) => {
  const { type } = event || {}
  if (!VALID_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_type' }
  }

  let cache = null
  try {
    const res = await db.collection('leaderboard_cache').doc(type).get()
    cache = res.data
  } catch (err) {
    cache = null
  }

  return { ok: true, list: (cache && cache.list) || [] }
}
