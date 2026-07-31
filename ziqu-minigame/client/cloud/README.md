# cloud/ —— 云函数挂载目录（由 sync-cloud 脚本生成）

> **此目录下的云函数子目录由 `sync-cloud` 脚本生成，不要直接修改。**
> 修改请到仓库根的 `cloud/` 目录（`cloud/functions/`、`cloud/triggers/`），
> 然后在 `ziqu-minigame/` 根目录执行 `npm run sync-cloud` 重新同步。

本目录是 `project.config.json` 中 `cloudfunctionRoot` 的挂载点（微信开发者
工具要求云函数目录在项目根内），方便在工具内查看/上传云函数。

## 客户端调用入口

客户端统一通过 [`js/systems/CloudAPI.js`](../js/systems/CloudAPI.js) 调用
`wx.cloud.callFunction`，云环境不可用时自动降级为本地 mock。

## 云函数契约（与 Task#3 共用）

| 云函数 | 入参 | 返回 |
| --- | --- | --- |
| `submitScore` | `{ levelId, score, timeMs, answerSequence }` | `{ ok, rank, newBest }` |
| `dailySignIn` | `{}` | `{ ok, consecutiveDays, reward }` |
| `createChallenge` | `{ levelId, score, timeMs, friendOpenId? }` | `{ ok, challengeId }` |
| `acceptChallenge` | `{ challengeId, score, timeMs }` | `{ ok, result: "win"\|"lose"\|"tie" }` |
| `getLeaderboard` | `{ type: "daily"\|"weekly"\|"season" }` | `{ ok, list: [{openId,nickname,avatar,score,rank}] }` |

## 联调步骤

1. 在 `ziqu-minigame/` 根目录执行 `npm run sync-cloud`，把根 `cloud/` 下的云函数同步到本目录。
2. 在 `js/systems/CloudAPI.js` 中把 `CLOUD_ENV` 替换为实际云环境 ID。
3. 微信开发者工具中右键各函数目录 → 上传并部署。
