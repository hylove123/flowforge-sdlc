/**
 * dailySignIn 云函数
 * 入参：{}（用户身份从 cloud.getWXContext().OPENID 获取）
 * 返回：{ ok: true, consecutiveDays: number, reward: "coin_10" }
 *   或：{ ok: false, error: "already_signed" }
 *
 * 逻辑：以北京时间（UTC+8）自然日为准；
 *   - 今日已签到 → already_signed（幂等）
 *   - 昨日签过 → consecutiveSignIn + 1
 *   - 断签 / 首次 → consecutiveSignIn = 1
 *
 * 并发安全：读取-校验-写入在 db.runTransaction 事务内原子完成，
 * 同一用户并发签到仅一次成功，其余得 already_signed，不会重复领奖。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const DAILY_REWARD = 'coin_10'

function chinaDateStr(offsetDays) {
  const offset = offsetDays || 0
  return new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400 * 1000)
    .toISOString()
    .slice(0, 10)
}

// 业务校验失败时抛出携带错误码的异常，用于中止事务并回滚
function bizError(code) {
  const err = new Error(code)
  err.bizError = code
  return err
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { ok: false, error: 'no_auth' }
  }

  const today = chinaDateStr(0)
  const yesterday = chinaDateStr(-1)

  try {
    // 读取、校验、写入在同一事务内原子完成，防止并发签到重复领奖
    const consecutiveDays = await db.runTransaction(async (transaction) => {
      const players = transaction.collection('players')

      let player = null
      try {
        const res = await players.doc(OPENID).get()
        player = res.data
      } catch (err) {
        player = null
      }

      if (player && player.lastSignIn === today) {
        throw bizError('already_signed')
      }

      const days =
        player && player.lastSignIn === yesterday ? (player.consecutiveSignIn || 0) + 1 : 1

      const now = db.serverDate()
      if (!player) {
        await players.doc(OPENID).set({
          data: {
            nickname: '',
            avatar: '',
            totalScore: 0,
            currentLevel: 1,
            rank: 'bronze',
            consecutiveSignIn: days,
            lastSignIn: today,
            bestScores: {},
            createdAt: now,
            updatedAt: now,
          },
        })
      } else {
        await players.doc(OPENID).update({
          data: {
            consecutiveSignIn: days,
            lastSignIn: today,
            updatedAt: now,
          },
        })
      }

      return days
    })

    return { ok: true, consecutiveDays, reward: DAILY_REWARD }
  } catch (err) {
    if (err && err.bizError) {
      return { ok: false, error: err.bizError }
    }
    // 事务写冲突（并发签到落败方）等异常统一按已签到处理
    return { ok: false, error: 'already_signed' }
  }
}
