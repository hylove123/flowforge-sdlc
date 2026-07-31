# ziqu-minigame（字趣小游戏）

微信小游戏项目。目录结构：

- `client/`：小游戏客户端（微信开发者工具项目根）
- `cloud/`：云函数源码（functions / triggers / db / test）
- `scripts/`：辅助脚本（如 `sync-cloud.mjs` 同步云函数到 `client/cloud/`）
- `tools/level-generator/`：关卡批量生成器

## 上线前检查清单

- [ ] **填写 appid**：在 `client/project.config.json` 中将占位 appid 替换为正式小游戏 appid。
- [ ] **替换云环境 ID**：将 `client/js/systems/CloudAPI.js` 中的 `CLOUD_ENV` 常量替换为微信云开发控制台的实际云环境 ID（见文件内 `// TODO(上线前)` 注释）。
- [ ] **替换广告位 ID**：开通流量主后，将 `client/js/systems/AdManager.js` 中 `AD_UNITS` 的三类占位广告位 ID（激励视频 / 插屏 / Banner）替换为 mp 后台申请的正式 ID。
- [ ] **运行 sync-cloud**：在本目录执行 `npm run sync-cloud`，确保 `client/cloud/` 与 `cloud/` 云函数一致后再上传部署。
- [ ] **ICP 备案确认**：确认小游戏主体已完成 ICP 备案且备案信息与 mp 后台一致。
