/**
 * aggregateLeaderboard 定时触发器（每 10 分钟运行一次）
 * 逻辑：按 totalScore 降序查询 players 集合 Top100，
 *       分别写入 leaderboard_cache 的 daily / weekly / season 三条记录。
 *
 * 说明：当前三份榜单均基于 totalScore 全量聚合（daily/weekly 的周期性重置
 *       可在后续迭代中通过快照差值实现），先保证客户端契约稳定。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const TOP_N = 100
const CACHE_TYPES = ['daily', 'weekly', 'season']

exports.main = async (event, context) => {
  const res = await db
    .collection('players')
    .orderBy('totalScore', 'desc')
    .limit(TOP_N)
    .field({ nickname: true, avatar: true, totalScore: true })
    .get()

  const list = (res.data || []).map((p, i) => ({
    openId: p._id,
    nickname: p.nickname || '',
    avatar: p.avatar || '',
    score: p.totalScore || 0,
    rank: i + 1,
  }))

  const cacheCol = db.collection('leaderboard_cache')
  const updatedAt = db.serverDate()

  for (const type of CACHE_TYPES) {
    // doc().set() 为 upsert 语义：不存在则创建，存在则整体覆盖
    await cacheCol.doc(type).set({
      data: { list, updatedAt },
    })
  }

  return { ok: true, count: list.length }
}
