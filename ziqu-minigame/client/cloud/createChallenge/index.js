/**
 * createChallenge 云函数
 * 入参：{ levelId: string, score: number, timeMs: number, friendOpenId?: string }
 * 返回：{ ok: true, challengeId: string } 或 { ok: false, error: string }
 *
 * 逻辑：发起者携带自己的成绩创建 challenges 记录（status=pending），
 *       challengeId 由数据库生成，客户端通过分享卡片把 challengeId 传给好友。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const MIN_TIME_MS = 3000
const MAX_TIME_MS = 30 * 60 * 1000

function isValidScore(event) {
  const { levelId, score, timeMs } = event || {}
  if (typeof levelId !== 'string' || !levelId.trim()) return false
  if (!Number.isInteger(score) || score < 0 || score > 1000) return false
  if (!Number.isInteger(timeMs) || timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) return false
  return true
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { ok: false, error: 'no_auth' }
  }
  if (!isValidScore(event)) {
    return { ok: false, error: 'invalid_params' }
  }

  const { levelId, score, timeMs, friendOpenId } = event

  const res = await db.collection('challenges').add({
    data: {
      levelId,
      initiator: { openId: OPENID, score, timeMs },
      opponent: {
        openId: typeof friendOpenId === 'string' ? friendOpenId : '',
        score: null,
        timeMs: null,
      },
      status: 'pending',
      result: null,
      createdAt: db.serverDate(),
      completedAt: null,
    },
  })

  return { ok: true, challengeId: res._id }
}
