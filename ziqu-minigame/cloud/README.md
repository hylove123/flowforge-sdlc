# 字趣消消乐 — 微信云开发后端

微信小游戏云开发后端：5 个业务云函数 + 1 个定时触发器 + 4 个数据库集合。

## 目录结构

```
cloud/
├── functions/
│   ├── submitScore/        # 提交成绩（防作弊校验 + 最佳成绩/总分/排名）
│   ├── dailySignIn/        # 每日签到（幂等、连续签到统计）
│   ├── createChallenge/    # 发起好友挑战
│   ├── acceptChallenge/    # 应战挑战（比分判定 + 状态流转）
│   └── getLeaderboard/     # 读取排行榜缓存
├── triggers/
│   └── aggregateLeaderboard/  # 定时触发器：每 10 分钟聚合 Top100
├── db/
│   └── collections.md      # 集合字段与索引详细说明
└── test/
    └── cloud.test.js       # 本地逻辑单测（mock wx-server-sdk）
```

## 云函数 API 契约

所有云函数均为 `wx.cloud.callFunction({ name, data })` 调用；用户身份一律由服务端
`cloud.getWXContext().OPENID` 获取，**不接受客户端传入 openId**。

| 云函数 | 入参 | 成功返回 | 失败返回 |
| --- | --- | --- | --- |
| `submitScore` | `{ levelId, score, timeMs, answerSequence }` | `{ ok: true, rank, newBest }` | `{ ok: false, error: "cheat_detected" }` |
| `dailySignIn` | `{}` | `{ ok: true, consecutiveDays, reward: "coin_10" }` | `{ ok: false, error: "already_signed" }` |
| `createChallenge` | `{ levelId, score, timeMs, friendOpenId? }` | `{ ok: true, challengeId }` | `{ ok: false, error: "invalid_params" }` |
| `acceptChallenge` | `{ challengeId, score, timeMs }` | `{ ok: true, result: "win"\|"lose"\|"tie" }` | `{ ok: false, error: "challenge_closed"\|"not_invited"\|... }` |
| `getLeaderboard` | `{ type: "daily"\|"weekly"\|"season" }` | `{ ok: true, list: [{openId, nickname, avatar, score, rank}] }` | `{ ok: false, error: "invalid_type" }` |

### submitScore 防作弊规则

1. `levelId` 必须为非空字符串；
2. `score` 必须为 0–1000 的整数；
3. `timeMs` 必须为整数且 3000 ≤ timeMs ≤ 1800000（3 秒下限、30 分钟上限）；
4. `answerSequence` 必须为字符串数组，长度 1–64，单步字符串长度 ≤ 64；
5. 得分速率 `score / (timeMs/1000)` 不得超过 250 分/秒（例如 3 秒提交满分 1000 必判作弊）。

任一规则不满足即返回 `{ ok: false, error: "cheat_detected" }`，不落库。

### aggregateLeaderboard 定时触发器

- cron：`0 */10 * * * * *`（每 10 分钟），配置在其 `config.json` 的 `triggers` 中；
- 逻辑：按 `totalScore` 降序取 `players` Top100，覆盖写入 `leaderboard_cache`
  的 `daily` / `weekly` / `season` 三条记录（`doc(type).set()` upsert 语义）。

## 数据库集合与索引

集合结构详见 [db/collections.md](db/collections.md)。控制台需手动创建 4 个集合并建立索引：

| 集合 | 索引 | 字段 |
| --- | --- | --- |
| `players` | `idx_totalScore_desc` | `totalScore` 降序 |
| `challenges` | `idx_status_opponent` | `status` 升序 + `opponent.openId` 升序 |
| `challenges` | `idx_initiator_createdAt` | `initiator.openId` 升序 + `createdAt` 降序 |
| `levels`（可选） | `idx_category_createdAt` | `meta.category` 升序 + `createdAt` 降序 |

`leaderboard_cache` 仅 `_id` 点查，无需额外索引。

**集合权限**：全部设置为"仅管理端可读写"，客户端只能通过云函数读写数据。

## 部署步骤

1. **开通云开发**：微信开发者工具 → 云开发控制台 → 创建环境（记下环境 ID）。
2. **创建集合**：在"数据库"面板依次创建 `players`、`levels`、`challenges`、
   `leaderboard_cache`，权限选"仅管理端可读写"，并按上表添加索引。
3. **配置项目**：在小游戏 `project.config.json` 中设置
   `"cloudfunctionRoot": "cloud/functions/"`；定时触发器目录 `cloud/triggers/`
   可临时移入 `functions/` 或单独指定后上传。
4. **上传云函数**：在开发者工具中对 `submitScore`、`dailySignIn`、
   `createChallenge`、`acceptChallenge`、`getLeaderboard`、`aggregateLeaderboard`
   逐个右键 →"上传并部署：云端安装依赖"。
5. **启用定时触发器**：`aggregateLeaderboard` 上传后，右键 →"上传触发器"，
   使其 `config.json` 中的 timer（每 10 分钟）生效。
6. **客户端初始化**：游戏入口调用
   `wx.cloud.init({ env: "<环境 ID>", traceUser: true })`。
7. **验证**：手动运行一次 `aggregateLeaderboard`（云函数控制台 → 测试），
   再调用 `getLeaderboard` 确认返回缓存榜单。

> 云函数运行环境为 Node.js 16+，全部代码使用 CommonJS；每个云函数目录独立，
> 依赖仅 `wx-server-sdk`，`cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })` 自动跟随部署环境。

## 本地测试

无需真实云环境，测试通过 hook `require('wx-server-sdk')` 注入内存数据库：

```bash
cd ziqu-minigame/cloud
npm test          # 等价于 node test/cloud.test.js
```

覆盖：submitScore 防作弊 5 类规则与最佳分增量逻辑、dailySignIn 幂等/连签/断签、
acceptChallenge 全部状态流转与比分判定、排行榜聚合 + 读取，共 20 个用例。
