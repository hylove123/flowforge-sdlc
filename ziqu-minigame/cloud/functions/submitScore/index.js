/**
 * submitScore 云函数
 * 入参：{ levelId: string, score: number, timeMs: number, answerSequence: string[] }
 * 返回：{ ok: true, rank: number, newBest: boolean } 或 { ok: false, error: "cheat_detected" }
 *
 * 防作弊规则（全部命中才算合法提交）：
 * 1. levelId 必须为非空字符串
 * 2. score 必须为 0-1000 的整数
 * 3. timeMs 必须为整数，且 >= 3000（3 秒下限）、<= 1800000（30 分钟上限）
 * 4. answerSequence 必须为字符串数组，长度 1-64，单步长度 <= 64
 * 5. 得分速率校验：每秒得分不能超过 250（如 3 秒提交满分 1000 必判作弊）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MIN_TIME_MS = 3000
const MAX_TIME_MS = 30 * 60 * 1000
const MIN_SCORE = 0
const MAX_SCORE = 1000
const MAX_ANSWER_STEPS = 64
const MAX_ANSWER_ITEM_LEN = 64
const MAX_SCORE_PER_SECOND = 250

// 段位阈值：按 totalScore 从高到低匹配
const RANK_TIERS = [
  { rank: 'master', min: 20000 },
  { rank: 'gold', min: 5000 },
  { rank: 'silver', min: 1000 },
  { rank: 'bronze', min: 0 },
]

function resolveRankTier(totalScore) {
  const tier = RANK_TIERS.find((t) => totalScore >= t.min)
  return tier ? tier.rank : 'bronze'
}

function isCheat(event) {
  const { levelId, score, timeMs, answerSequence } = event || {}
  if (typeof levelId !== 'string' || !levelId.trim()) return true
  if (!Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) return true
  if (!Number.isInteger(timeMs) || timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) return true
  if (!Array.isArray(answerSequence)) return true
  if (answerSequence.length < 1 || answerSequence.length > MAX_ANSWER_STEPS) return true
  if (!answerSequence.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_ANSWER_ITEM_LEN)) return true
  // 得分速率：score / (timeMs / 1000) 超过阈值视为不可能的人类操作
  if (score > 0 && score / (timeMs / 1000) > MAX_SCORE_PER_SECOND) return true
  return false
}

function todayStr() {
  // 以 UTC+8（北京时间）为准
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { ok: false, error: 'no_auth' }
  }
  if (isCheat(event)) {
    return { ok: false, error: 'cheat_detected' }
  }

  const { levelId, score, timeMs } = event
  const players = db.collection('players')

  // 读取玩家档案（不存在则视为新玩家）
  let player = null
  try {
    const res = await players.doc(OPENID).get()
    player = res.data
  } catch (err) {
    player = null
  }

  const bestScores = (player && player.bestScores) || {}
  const prev = bestScores[levelId]
  const newBest = !prev || score > prev.score
  const fasterSameScore = prev && score === prev.score && timeMs < prev.timeMs

  let totalScore = (player && player.totalScore) || 0
  if (newBest) {
    // totalScore = 各关卡最佳分之和，只累加增量
    totalScore += score - (prev ? prev.score : 0)
    bestScores[levelId] = { score, timeMs, date: todayStr() }
  } else if (fasterSameScore) {
    // 同分更快：只刷新用时，不影响 totalScore
    bestScores[levelId] = { score, timeMs, date: todayStr() }
  }

  const now = db.serverDate()
  if (!player) {
    await players.doc(OPENID).set({
      data: {
        nickname: '',
        avatar: '',
        totalScore,
        currentLevel: 1,
        rank: resolveRankTier(totalScore),
        consecutiveSignIn: 0,
        lastSignIn: '',
        bestScores,
        createdAt: now,
        updatedAt: now,
      },
    })
  } else if (newBest || fasterSameScore) {
    await players.doc(OPENID).update({
      data: {
        totalScore,
        rank: resolveRankTier(totalScore),
        bestScores,
        updatedAt: now,
      },
    })
  }

  // 排名 = 比我 totalScore 高的人数 + 1
  const { total } = await players.where({ totalScore: _.gt(totalScore) }).count()

  return { ok: true, rank: total + 1, newBest }
}
