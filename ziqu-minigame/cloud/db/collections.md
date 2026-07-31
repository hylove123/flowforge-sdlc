# 数据库集合设计（collections）

字趣消消乐 云开发数据库共 4 个集合：`players`、`levels`、`challenges`、`leaderboard_cache`。

---

## 1. players — 玩家档案

`_id` 直接使用玩家 openId，保证一人一档、支持 `doc(openId)` 点查。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 玩家 openId（由云函数从 `cloud.getWXContext().OPENID` 获取） |
| `nickname` | string | 昵称（客户端授权后另行更新，默认空串） |
| `avatar` | string | 头像 URL（默认空串） |
| `totalScore` | number | 总分 = 各关卡最佳分之和，排行榜排序依据 |
| `currentLevel` | number | 当前推进到的关卡序号，默认 1 |
| `rank` | string | 段位：`bronze` \| `silver` \| `gold` \| `master`（按 totalScore 阈值 0/1000/5000/20000 划分） |
| `consecutiveSignIn` | number | 连续签到天数 |
| `lastSignIn` | string | 最后签到日期，`YYYY-MM-DD`（北京时间） |
| `bestScores` | object | `{ [levelId]: { score, timeMs, date } }` 各关卡最佳成绩 |
| `createdAt` | Date | 创建时间（`db.serverDate()`） |
| `updatedAt` | Date | 最后更新时间 |

**索引：**

| 索引 | 字段 | 属性 | 用途 |
| --- | --- | --- | --- |
| `idx_totalScore_desc` | `totalScore` 降序 | 非唯一 | 排行榜聚合 Top100、`submitScore` 排名统计 |

---

## 2. levels — 动态关卡（可选）

存储热梗周赛等动态下发关卡；基础关卡内置在客户端包内，不依赖此集合。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | levelId（UUID） |
| `type` | string | `disassemble` \| `compose` \| `typoFind` \| `riddle` |
| `difficulty` | number | 难度 1-5 |
| `title` | string | 关卡标题 |
| `data` | object | 关卡内容，结构同客户端 Level JSON Schema |
| `meta` | object | `{ category: "basic"\|"intermediate"\|"meme"\|"weekly", tags: string[] }` |
| `createdAt` | Date | 创建时间 |

**索引：**

| 索引 | 字段 | 属性 | 用途 |
| --- | --- | --- | --- |
| `idx_category_createdAt` | `meta.category` 升序 + `createdAt` 降序 | 非唯一 | 按分类拉取最新关卡（如周赛） |

---

## 3. challenges — 好友挑战

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | challengeId（数据库自动生成） |
| `levelId` | string | 挑战关卡 |
| `initiator` | object | `{ openId, score, timeMs }` 发起者成绩 |
| `opponent` | object | `{ openId, score, timeMs }`；定向挑战时 openId 预填好友，否则为空串；应战前 score/timeMs 为 `null` |
| `status` | string | `pending` \| `completed` \| `expired` |
| `result` | string \| null | `initiator_win` \| `opponent_win` \| `tie`；未完成为 `null` |
| `createdAt` | Date | 创建时间 |
| `completedAt` | Date \| null | 完成时间 |

**状态流转：** `pending` → `completed`（应战成功）；`pending` → `expired`（超时清理，可选后台任务）。非 `pending` 状态拒绝再次应战。

**索引：**

| 索引 | 字段 | 属性 | 用途 |
| --- | --- | --- | --- |
| `idx_status_opponent` | `status` 升序 + `opponent.openId` 升序 | 非唯一 | 查询"我收到的待应战挑战" |
| `idx_initiator_createdAt` | `initiator.openId` 升序 + `createdAt` 降序 | 非唯一 | 查询"我发起的挑战"列表 |

---

## 4. leaderboard_cache — 排行榜缓存

固定 3 条记录，`_id` 即榜单类型，由 `aggregateLeaderboard` 定时触发器每 10 分钟整体覆盖写入。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `daily` \| `weekly` \| `season` |
| `list` | array | Top100：`[{ openId, nickname, avatar, score, rank }]`，rank 从 1 开始 |
| `updatedAt` | Date | 聚合时间 |

**索引：** 仅按 `_id` 点查，无需额外索引。

---

## 集合权限建议（云开发控制台）

所有集合均设置为 **"仅管理端可读写"**（`{"read": false, "write": false}`），
客户端一律通过云函数访问数据，杜绝客户端直改分数。
