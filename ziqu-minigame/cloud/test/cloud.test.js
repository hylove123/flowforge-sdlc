/**
 * 云函数本地逻辑单测（无需真实云环境）
 * 运行：node ziqu-minigame/cloud/test/cloud.test.js
 *
 * 通过 hook Module._load 将 wx-server-sdk 替换为内存实现，
 * 覆盖三块核心逻辑：
 *   1. submitScore 防作弊校验与最佳成绩更新
 *   2. dailySignIn 幂等性与连续签到计数
 *   3. acceptChallenge 状态流转与比分判定
 */
'use strict'

const assert = require('assert')
const path = require('path')
const Module = require('module')

/* ---------------------------------------------------------------- *
 * mock wx-server-sdk
 * ---------------------------------------------------------------- */

const state = {
  openid: 'user_A',
  txQueue: Promise.resolve(),
  store: {
    players: new Map(),
    challenges: new Map(),
    leaderboard_cache: new Map(),
    levels: new Map(),
  },
}

let autoId = 0

function matchWhere(docData, cond) {
  return Object.keys(cond).every((key) => {
    const expect = cond[key]
    const actual = docData[key]
    if (expect && typeof expect === 'object' && expect.__op === 'gt') {
      return actual > expect.value
    }
    return actual === expect
  })
}

function createMockDb() {
  const command = { gt: (value) => ({ __op: 'gt', value }) }

  function collection(name) {
    const map = state.store[name]
    return {
      doc(id) {
        return {
          async get() {
            if (!map.has(id)) {
              const err = new Error('document.get:fail document not exists')
              err.errCode = -502004
              throw err
            }
            return { data: Object.assign({ _id: id }, map.get(id)) }
          },
          async set({ data }) {
            map.set(id, JSON.parse(JSON.stringify(normalizeDates(data))))
            return { _id: id }
          },
          async update({ data }) {
            if (!map.has(id)) throw new Error('document not exists')
            map.set(id, Object.assign({}, map.get(id), normalizeDates(data)))
            return { stats: { updated: 1 } }
          },
        }
      },
      async add({ data }) {
        const id = 'auto_' + ++autoId
        map.set(id, JSON.parse(JSON.stringify(normalizeDates(data))))
        return { _id: id }
      },
      where(cond) {
        return {
          async count() {
            let total = 0
            for (const doc of map.values()) if (matchWhere(doc, cond)) total++
            return { total }
          },
        }
      },
      orderBy(field, dir) {
        const chain = {
          _limit: Infinity,
          limit(n) { chain._limit = n; return chain },
          field() { return chain },
          async get() {
            const docs = [...map.entries()].map(([_id, d]) => Object.assign({ _id }, d))
            docs.sort((a, b) => (dir === 'desc' ? b[field] - a[field] : a[field] - b[field]))
            return { data: docs.slice(0, chain._limit) }
          },
        }
        return chain
      },
    }
  }

  /**
   * 模拟 db.runTransaction 事务语义：
   *   - 串行化：事务排队依次执行，模拟云数据库的隔离性（并发事务不会交叉读写）
   *   - 回滚：回调抛异常时恢复全部集合快照，异常继续向外抛出
   *   - 事务内 doc.get 对不存在的文档返回 { data: null }（与真实 SDK 一致）
   */
  function runTransaction(fn) {
    const execute = async () => {
      const snapshot = {}
      for (const [name, map] of Object.entries(state.store)) {
        snapshot[name] = new Map(map)
      }
      const transaction = {
        collection(name) {
          const map = state.store[name]
          return {
            doc(id) {
              return {
                async get() {
                  if (!map.has(id)) return { data: null }
                  return { data: Object.assign({ _id: id }, map.get(id)) }
                },
                async set({ data }) {
                  map.set(id, JSON.parse(JSON.stringify(normalizeDates(data))))
                  return { _id: id }
                },
                async update({ data }) {
                  if (!map.has(id)) throw new Error('document not exists')
                  map.set(id, Object.assign({}, map.get(id), normalizeDates(data)))
                  return { stats: { updated: 1 } }
                },
              }
            },
          }
        },
      }
      try {
        return await fn(transaction)
      } catch (err) {
        for (const [name, map] of Object.entries(snapshot)) {
          state.store[name].clear()
          for (const [k, v] of map) state.store[name].set(k, v)
        }
        throw err
      }
    }
    const result = state.txQueue.then(execute)
    state.txQueue = result.catch(() => {})
    return result
  }

  return { collection, command, runTransaction, serverDate: () => new Date() }
}

function normalizeDates(data) {
  // serverDate 占位为 Date 对象，JSON 序列化时转字符串即可
  return data
}

const mockCloud = {
  DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
  init() {},
  getWXContext: () => ({ OPENID: state.openid }),
  database: () => createMockDb(),
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return mockCloud
  return origLoad.apply(Module, arguments)
}

/* ---------------------------------------------------------------- *
 * 加载被测云函数（mock 安装后再 require）
 * ---------------------------------------------------------------- */

const ROOT = path.join(__dirname, '..')
const submitScore = require(path.join(ROOT, 'functions/submitScore/index.js')).main
const dailySignIn = require(path.join(ROOT, 'functions/dailySignIn/index.js')).main
const createChallenge = require(path.join(ROOT, 'functions/createChallenge/index.js')).main
const acceptChallenge = require(path.join(ROOT, 'functions/acceptChallenge/index.js')).main
const getLeaderboard = require(path.join(ROOT, 'functions/getLeaderboard/index.js')).main
const aggregateLeaderboard = require(path.join(ROOT, 'triggers/aggregateLeaderboard/index.js')).main

function resetStore() {
  Object.values(state.store).forEach((m) => m.clear())
  state.openid = 'user_A'
  state.txQueue = Promise.resolve()
}

function chinaDateStr(offsetDays) {
  return new Date(Date.now() + 8 * 3600 * 1000 + (offsetDays || 0) * 86400 * 1000)
    .toISOString()
    .slice(0, 10)
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

/* ---------------------------------------------------------------- *
 * 1. submitScore 防作弊
 * ---------------------------------------------------------------- */

test('submitScore: timeMs < 3000 判作弊', async () => {
  resetStore()
  const res = await submitScore({ levelId: 'L1', score: 100, timeMs: 2999, answerSequence: ['a'] })
  assert.deepStrictEqual(res, { ok: false, error: 'cheat_detected' })
})

test('submitScore: score 超出 0-1000 判作弊', async () => {
  resetStore()
  const over = await submitScore({ levelId: 'L1', score: 1001, timeMs: 5000, answerSequence: ['a'] })
  const negative = await submitScore({ levelId: 'L1', score: -1, timeMs: 5000, answerSequence: ['a'] })
  assert.strictEqual(over.error, 'cheat_detected')
  assert.strictEqual(negative.error, 'cheat_detected')
})

test('submitScore: answerSequence 非法（缺失/空/超长）判作弊', async () => {
  resetStore()
  const missing = await submitScore({ levelId: 'L1', score: 100, timeMs: 5000 })
  const empty = await submitScore({ levelId: 'L1', score: 100, timeMs: 5000, answerSequence: [] })
  const tooLong = await submitScore({
    levelId: 'L1', score: 100, timeMs: 5000, answerSequence: new Array(65).fill('x'),
  })
  assert.strictEqual(missing.error, 'cheat_detected')
  assert.strictEqual(empty.error, 'cheat_detected')
  assert.strictEqual(tooLong.error, 'cheat_detected')
})

test('submitScore: 得分速率超限（3 秒满分）判作弊', async () => {
  resetStore()
  const res = await submitScore({ levelId: 'L1', score: 1000, timeMs: 3000, answerSequence: ['a', 'b'] })
  assert.deepStrictEqual(res, { ok: false, error: 'cheat_detected' })
})

test('submitScore: 合法提交创建新玩家并返回排名', async () => {
  resetStore()
  const res = await submitScore({ levelId: 'L1', score: 300, timeMs: 8000, answerSequence: ['a', 'b'] })
  assert.deepStrictEqual(res, { ok: true, rank: 1, newBest: true })
  const player = state.store.players.get('user_A')
  assert.strictEqual(player.totalScore, 300)
  assert.strictEqual(player.bestScores.L1.score, 300)
})

test('submitScore: 低于历史最佳不更新 totalScore', async () => {
  resetStore()
  await submitScore({ levelId: 'L1', score: 300, timeMs: 8000, answerSequence: ['a'] })
  const res = await submitScore({ levelId: 'L1', score: 200, timeMs: 8000, answerSequence: ['a'] })
  assert.deepStrictEqual(res, { ok: true, rank: 1, newBest: false })
  assert.strictEqual(state.store.players.get('user_A').totalScore, 300)
})

test('submitScore: 刷新最佳分只累加增量', async () => {
  resetStore()
  await submitScore({ levelId: 'L1', score: 300, timeMs: 8000, answerSequence: ['a'] })
  await submitScore({ levelId: 'L1', score: 500, timeMs: 8000, answerSequence: ['a'] })
  assert.strictEqual(state.store.players.get('user_A').totalScore, 500)
})

/* ---------------------------------------------------------------- *
 * 2. dailySignIn 幂等性
 * ---------------------------------------------------------------- */

test('dailySignIn: 首次签到 consecutiveDays=1', async () => {
  resetStore()
  const res = await dailySignIn({})
  assert.deepStrictEqual(res, { ok: true, consecutiveDays: 1, reward: 'coin_10' })
})

test('dailySignIn: 同日重复签到返回 already_signed（幂等）', async () => {
  resetStore()
  await dailySignIn({})
  const res = await dailySignIn({})
  assert.deepStrictEqual(res, { ok: false, error: 'already_signed' })
  assert.strictEqual(state.store.players.get('user_A').consecutiveSignIn, 1)
})

test('dailySignIn: 昨日签过则连续天数 +1', async () => {
  resetStore()
  state.store.players.set('user_A', {
    nickname: '', avatar: '', totalScore: 0, currentLevel: 1, rank: 'bronze',
    consecutiveSignIn: 3, lastSignIn: chinaDateStr(-1), bestScores: {},
  })
  const res = await dailySignIn({})
  assert.deepStrictEqual(res, { ok: true, consecutiveDays: 4, reward: 'coin_10' })
})

test('dailySignIn: 断签后连续天数重置为 1', async () => {
  resetStore()
  state.store.players.set('user_A', {
    nickname: '', avatar: '', totalScore: 0, currentLevel: 1, rank: 'bronze',
    consecutiveSignIn: 9, lastSignIn: chinaDateStr(-3), bestScores: {},
  })
  const res = await dailySignIn({})
  assert.strictEqual(res.consecutiveDays, 1)
})

test('dailySignIn: 并发签到仅一次成功，另一次返回 already_signed', async () => {
  resetStore()
  // 同时发起两次签到，事务串行化后仅首个通过 lastSignIn 校验
  const [r1, r2] = await Promise.all([dailySignIn({}), dailySignIn({})])
  const results = [r1, r2]
  assert.strictEqual(results.filter((r) => r.ok).length, 1)
  const winner = results.find((r) => r.ok)
  assert.deepStrictEqual(winner, { ok: true, consecutiveDays: 1, reward: 'coin_10' })
  const loser = results.find((r) => !r.ok)
  assert.deepStrictEqual(loser, { ok: false, error: 'already_signed' })
  // 奖励只发一次：连签天数仍为 1
  assert.strictEqual(state.store.players.get('user_A').consecutiveSignIn, 1)
})

/* ---------------------------------------------------------------- *
 * 3. createChallenge / acceptChallenge 状态流转
 * ---------------------------------------------------------------- */

async function setupChallenge(initiatorScore, initiatorTime) {
  state.openid = 'user_A'
  const created = await createChallenge({ levelId: 'L1', score: initiatorScore, timeMs: initiatorTime })
  assert.strictEqual(created.ok, true)
  return created.challengeId
}

test('acceptChallenge: 应战者分高判 win，状态流转为 completed', async () => {
  resetStore()
  const id = await setupChallenge(300, 8000)
  state.openid = 'user_B'
  const res = await acceptChallenge({ challengeId: id, score: 500, timeMs: 9000 })
  assert.deepStrictEqual(res, { ok: true, result: 'win' })
  const doc = state.store.challenges.get(id)
  assert.strictEqual(doc.status, 'completed')
  assert.strictEqual(doc.result, 'opponent_win')
  assert.strictEqual(doc.opponent.openId, 'user_B')
})

test('acceptChallenge: 同分比用时，更慢判 lose', async () => {
  resetStore()
  const id = await setupChallenge(300, 8000)
  state.openid = 'user_B'
  const res = await acceptChallenge({ challengeId: id, score: 300, timeMs: 12000 })
  assert.deepStrictEqual(res, { ok: true, result: 'lose' })
  assert.strictEqual(state.store.challenges.get(id).result, 'initiator_win')
})

test('acceptChallenge: 分数用时全同判 tie', async () => {
  resetStore()
  const id = await setupChallenge(300, 8000)
  state.openid = 'user_B'
  const res = await acceptChallenge({ challengeId: id, score: 300, timeMs: 8000 })
  assert.deepStrictEqual(res, { ok: true, result: 'tie' })
  assert.strictEqual(state.store.challenges.get(id).result, 'tie')
})

test('acceptChallenge: completed 状态拒绝重复应战', async () => {
  resetStore()
  const id = await setupChallenge(300, 8000)
  state.openid = 'user_B'
  await acceptChallenge({ challengeId: id, score: 500, timeMs: 9000 })
  state.openid = 'user_C'
  const res = await acceptChallenge({ challengeId: id, score: 999, timeMs: 9000 })
  assert.deepStrictEqual(res, { ok: false, error: 'challenge_closed' })
})

test('acceptChallenge: 发起者不能应战自己的挑战', async () => {
  resetStore()
  const id = await setupChallenge(300, 8000)
  const res = await acceptChallenge({ challengeId: id, score: 500, timeMs: 9000 })
  assert.deepStrictEqual(res, { ok: false, error: 'cannot_accept_own' })
})

test('acceptChallenge: 定向挑战校验应战者身份', async () => {
  resetStore()
  state.openid = 'user_A'
  const created = await createChallenge({
    levelId: 'L1', score: 300, timeMs: 8000, friendOpenId: 'user_B',
  })
  state.openid = 'user_C'
  const res = await acceptChallenge({ challengeId: created.challengeId, score: 500, timeMs: 9000 })
  assert.deepStrictEqual(res, { ok: false, error: 'not_invited' })
})

test('acceptChallenge: 不存在的挑战返回 challenge_not_found', async () => {
  resetStore()
  const res = await acceptChallenge({ challengeId: 'nope', score: 500, timeMs: 9000 })
  assert.deepStrictEqual(res, { ok: false, error: 'challenge_not_found' })
})

test('acceptChallenge: 并发应战同一 pending 挑战仅一次成功', async () => {
  resetStore()
  const id = await setupChallenge(300, 8000)
  // 两个用户同时应战：getWXContext 在首个 await 前同步读取，各自捕获自己的 openid
  state.openid = 'user_B'
  const p1 = acceptChallenge({ challengeId: id, score: 500, timeMs: 9000 })
  state.openid = 'user_C'
  const p2 = acceptChallenge({ challengeId: id, score: 400, timeMs: 9000 })
  const results = await Promise.all([p1, p2])
  assert.strictEqual(results.filter((r) => r.ok).length, 1)
  const loser = results.find((r) => !r.ok)
  assert.deepStrictEqual(loser, { ok: false, error: 'challenge_closed' })
  // 落库的应战者是事务串行化后的胜出方 user_B，且只写入一次
  const doc = state.store.challenges.get(id)
  assert.strictEqual(doc.status, 'completed')
  assert.strictEqual(doc.opponent.openId, 'user_B')
  assert.strictEqual(doc.opponent.score, 500)
})

/* ---------------------------------------------------------------- *
 * 4. 排行榜聚合与读取
 * ---------------------------------------------------------------- */

test('aggregateLeaderboard + getLeaderboard: Top 榜单按 totalScore 降序', async () => {
  resetStore()
  state.store.players.set('u1', { nickname: 'A', avatar: '', totalScore: 100 })
  state.store.players.set('u2', { nickname: 'B', avatar: '', totalScore: 300 })
  state.store.players.set('u3', { nickname: 'C', avatar: '', totalScore: 200 })
  const agg = await aggregateLeaderboard({})
  assert.deepStrictEqual(agg, { ok: true, count: 3 })
  const res = await getLeaderboard({ type: 'weekly' })
  assert.strictEqual(res.ok, true)
  assert.deepStrictEqual(res.list.map((x) => x.openId), ['u2', 'u3', 'u1'])
  assert.deepStrictEqual(res.list.map((x) => x.rank), [1, 2, 3])
})

test('getLeaderboard: 非法 type 返回 invalid_type，缓存缺失返回空列表', async () => {
  resetStore()
  const bad = await getLeaderboard({ type: 'monthly' })
  assert.deepStrictEqual(bad, { ok: false, error: 'invalid_type' })
  const empty = await getLeaderboard({ type: 'daily' })
  assert.deepStrictEqual(empty, { ok: true, list: [] })
})

/* ---------------------------------------------------------------- *
 * runner
 * ---------------------------------------------------------------- */

;(async () => {
  let passed = 0
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      passed++
      console.log('  ✓ ' + name)
    } catch (err) {
      failed++
      console.error('  ✗ ' + name)
      console.error('    ' + (err && err.message))
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
  process.exit(failed > 0 ? 1 : 0)
})()
