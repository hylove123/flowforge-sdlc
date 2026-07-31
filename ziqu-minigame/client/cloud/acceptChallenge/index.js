/**
 * acceptChallenge 云函数
 * 入参：{ challengeId: string, score: number, timeMs: number }
 * 返回：{ ok: true, result: "win"|"lose"|"tie" }（result 站在应战者视角）
 *   或：{ ok: false, error: string }
 *
 * 状态流转：pending → completed（幂等：非 pending 状态拒绝再次应战）
 * 比分判定：先比 score，高者胜；同分比 timeMs，短者胜；均相同为 tie。
 * challenges.result 字段记录全局视角："initiator_win"|"opponent_win"|"tie"
 *
 * 并发安全：读取-校验-更新在 db.runTransaction 事务内原子完成，
 * 两个用户并发应战同一 pending 挑战时仅一人成功，另一人得 challenge_closed。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const MIN_TIME_MS = 3000
const MAX_TIME_MS = 30 * 60 * 1000

function isValidParams(event) {
  const { challengeId, score, timeMs } = event || {}
  if (typeof challengeId !== 'string' || !challengeId.trim()) return false
  if (!Number.isInteger(score) || score < 0 || score > 1000) return false
  if (!Number.isInteger(timeMs) || timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) return false
  return true
}

function judge(initiator, opponent) {
  if (opponent.score > initiator.score) return 'opponent_win'
  if (opponent.score < initiator.score) return 'initiator_win'
  if (opponent.timeMs < initiator.timeMs) return 'opponent_win'
  if (opponent.timeMs > initiator.timeMs) return 'initiator_win'
  return 'tie'
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
  if (!isValidParams(event)) {
    return { ok: false, error: 'invalid_params' }
  }

  const { challengeId, score, timeMs } = event

  try {
    // 读取、校验、更新在同一事务内原子完成，防止并发应战同时通过 pending 校验
    const myResult = await db.runTransaction(async (transaction) => {
      let challenge = null
      try {
        const res = await transaction.collection('challenges').doc(challengeId).get()
        challenge = res.data
      } catch (err) {
        challenge = null
      }

      if (!challenge) {
        throw bizError('challenge_not_found')
      }
      if (challenge.status !== 'pending') {
        throw bizError('challenge_closed')
      }
      if (challenge.initiator.openId === OPENID) {
        throw bizError('cannot_accept_own')
      }
      // 定向挑战时校验应战者身份
      if (challenge.opponent.openId && challenge.opponent.openId !== OPENID) {
        throw bizError('not_invited')
      }

      const opponent = { openId: OPENID, score, timeMs }
      const result = judge(challenge.initiator, opponent)

      await transaction.collection('challenges').doc(challengeId).update({
        data: {
          opponent,
          status: 'completed',
          result,
          completedAt: db.serverDate(),
        },
      })

      return result === 'opponent_win' ? 'win' : result === 'initiator_win' ? 'lose' : 'tie'
    })

    return { ok: true, result: myResult }
  } catch (err) {
    if (err && err.bizError) {
      return { ok: false, error: err.bizError }
    }
    // 事务写冲突（并发应战落败方）等异常统一按挑战已关闭处理
    return { ok: false, error: 'challenge_closed' }
  }
}
