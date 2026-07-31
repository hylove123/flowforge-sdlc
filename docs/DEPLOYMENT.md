# FlowForge 部署与安装指南

FlowForge 是 Tauri 2.x 桌面应用（React 前端 + Node sidecar + Rust shell），支持 macOS 与 Windows。本文覆盖：安装前提、打包方式、LLM 端点配置、应用数据目录。

---

## 1. 安装前提

### macOS

| 依赖 | 说明 |
| --- | --- |
| macOS 11 (Big Sur) 及以上 | Tauri 2.x WebView（系统 WKWebView）要求 |
| **Node.js ≥ 20** | sidecar 以 `node` 子进程运行，需在 PATH 中可用（或设置 `FLOWFORGE_NODE` 环境变量指向可执行文件） |
| Git（推荐随 Xcode Command Line Tools 安装） | 代码仓库状态 / 增量索引功能依赖本地 git 仓库 |
| 首次打开未签名构建 | 需在「系统设置 → 隐私与安全性」中允许，或 `xattr -dr com.apple.quarantine FlowForge.app` |

### Windows

| 依赖 | 说明 |
| --- | --- |
| Windows 10 1803 及以上 | Tauri 2.x 最低要求 |
| **WebView2 Runtime** | Win 11 已内置；Win 10 若缺失，NSIS/MSI 安装器会引导下载，也可从 Microsoft 官网预装 Evergreen Runtime |
| **Microsoft Visual C++ 运行库 (VC++ Redistributable 2015-2022 x64)** | Rust MSVC 构建产物运行时依赖 |
| **Node.js ≥ 20**（安装时勾选 “Add to PATH”） | sidecar 以 `node.exe` 子进程运行；找不到时应用会提示设置 `FLOWFORGE_NODE` |
| **Git for Windows（必装）** | 代码仓库状态、增量索引等功能依赖 `git`；请安装时选择将 git 加入 PATH |

> 安装包产物：macOS 为 `.dmg` / `.app`；Windows 为 `.msi`（WiX）与 `.exe`（NSIS），任选其一安装。

---

## 2. 从源码打包

```bash
# 1) 安装依赖（根 + sidecar）
npm ci
npm ci --prefix sidecar

# 2) 构建 sidecar（tsc → sidecar/dist/index.js）
npm run build:sidecar

# 3) 打包桌面应用（pretauri:build 会自动先执行 build:sidecar）
npm run tauri:build
```

- 打包时 `sidecar/dist` 会作为 Tauri bundle resource 一并携带（见 `src-tauri/tauri.conf.json` 的 `bundle.resources`），运行时由 Rust 侧从 resource dir 解析并以 node 拉起。
- 开发调试：`npm run tauri:dev`（dev 态直接使用仓库内 `sidecar/dist` 或 tsx 源码运行）。
- 覆盖 sidecar 启动命令：设置环境变量 `FLOWFORGE_SIDECAR_CMD`（如 `node /path/to/index.js`）。若程序路径含空格，需用双引号包裹该段，如 `"C:\Program Files\nodejs\node.exe" C:\app\sidecar\dist\index.js`。

CI 上双平台构建由 `.github/workflows/desktop-ci.yml` 承担（macos-latest / windows-latest matrix）。

---

## 2.1 Windows 安装包构建指引

Windows 安装包（NSIS `.exe` / WiX `.msi`）需在 **Windows x64 机器或 CI Windows runner 上原生构建**。

> 为什么不在 macOS 上交叉编译：`cargo-xwin` 实验性方案虽可交叉编译 Rust shell（需 `rustup target add x86_64-pc-windows-msvc` + `cargo install cargo-xwin` + `brew install nsis llvm` + 下载 Windows SDK），但本项目 sidecar 依赖 **平台原生 Node 模块**（better-sqlite3、sqlite-vec），在 macOS 上构建的 `sidecar/dist` 只含 darwin-arm64 二进制，打入 Windows 安装包后 sidecar 无法启动。因此即使交叉编译成功，产物也不可用；Windows 构建必须在 Windows 环境完成（sidecar 会在该环境重装出 win32-x64 原生模块）。

### 前置依赖（构建机）

| 依赖 | 安装方式 |
| --- | --- |
| Rust（MSVC 工具链，`x86_64-pc-windows-msvc`） | [rustup.rs](https://rustup.rs)，默认即 MSVC target |
| Visual Studio Build Tools（含 C++ 工作负载 + Windows SDK） | Visual Studio Installer 勾选「使用 C++ 的桌面开发」 |
| Node.js ≥ 20（含 npm，加入 PATH） | [nodejs.org](https://nodejs.org) |
| WebView2 Runtime | Win 11 内置；Win 10 从 Microsoft 官网安装 Evergreen Runtime |
| NSIS / WiX | 无需手动安装，`tauri build` 时 Tauri CLI 会自动下载 |

### 构建步骤（PowerShell / CMD）

```powershell
git clone <repo-url> && cd flowforge-sdlc
npm ci
npm ci --prefix sidecar   # 在 Windows 上重建原生模块（win32-x64）
npm run tauri:build        # 自动先 build:sidecar，再 vite build + cargo 打包
```

### 产物路径

| 类型 | 路径 |
| --- | --- |
| NSIS 安装器 | `src-tauri\target\release\bundle\nsis\FlowForge_<version>_x64-setup.exe` |
| MSI 安装器 | `src-tauri\target\release\bundle\msi\FlowForge_<version>_x64_en-US.msi` |

### 推荐路线：GitHub Actions

无 Windows 机器时，推荐用仓库内 `.github/workflows/desktop-ci.yml`：push 到 main/master 或手动 `workflow_dispatch` 触发后，`windows-latest` job 会完成依赖安装、测试、`tauri build`，并把 `.msi` / `.exe` 作为 artifact（`flowforge-windows`）上传，macOS job 同时产出 `flowforge-macos`（`.dmg` / `.app`）。

---

## 3. LLM 端点配置

FlowForge 不内置任何模型凭证。安装后需在应用内配置 OpenAI 兼容端点：

1. 打开应用，进入 **模型配置**（Model Config）页面。
2. 填写：
   - **API Base URL**：OpenAI 兼容端点，不含 `/chat/completions` 后缀，例如 `https://api.openai.com/v1` 或你所在组织提供的兼容网关地址。
   - **模型名称**：如 `gpt-4o`、`qwen-max` 等端点支持的模型 ID。
   - **API Key**：你的密钥，仅保存在本机应用数据目录的 SQLite 中，不会上传。
3. 保存后可用页面内的连接测试验证连通性。

> 安全提示：请勿将 API Key 写入仓库、CI 变量日志或本文档；密钥泄露请立即在服务方控制台吊销轮换。

---

## 3.1 Git 凭证配置

克隆 / 推送私有 HTTP(S) 仓库（如自建 GitLab）时，可在应用内按 Git 服务器配置访问 Token，无需依赖系统 credential helper：

1. 打开 **系统设置 → Git 凭证** 标签页。
2. 填写：
   - **Git 服务器地址**：仅主机名或 IP，可带端口，例如 `gitlab.example.com`、`172.16.162.150` 或 `git.corp:8443`（不含 `http://` 前缀与仓库路径）。
   - **用户名**（可选）：默认 `oauth2`，适用于 GitLab Personal Access Token；其他平台按需填写。
   - **Token**：如 GitLab PAT（`glpat-…`，需 `read_repository` / `write_repository` 权限）。
3. 保存后，克隆与推送地址命中该主机的 HTTP(S) 仓库时自动使用该凭证。

行为说明：

- Token 仅保存在本机应用数据目录的 SQLite（见「应用数据目录」），不会上传。
- Token 只在单次 git 命令参数中临时拼入 URL：克隆完成后立即将 origin 重置为干净地址（不落盘 `.git/config`），推送也不修改 remote；日志、进度事件与错误信息统一脱敏为 `://***@`。
- 未配置凭证的地址（及 SSH 地址）保持原行为：回退到系统 Git 凭证（credential helper / SSH key）。

> 安全提示：同样请勿将 Git Token 写入仓库或文档；怀疑泄露时立即在 Git 服务端吊销重建。

---

## 3.2 引用本地项目

除 Git URL 克隆外，也可以直接引用本机已有的项目目录（不 clone、不复制，按原路径注册使用）：

1. 打开 **项目配置中心 → 仓库管理 → 添加仓库**（或项目管理页的添加仓库入口）。
2. 导入方式选择 **「引用本地目录」**，点击「选择目录」用系统目录选择器挑选项目目录（浏览器模式下退化为手动输入绝对路径）。
3. 保存时应用会校验该路径（存在性 / 是否目录 / 是否 Git 仓库），校验通过后仓库立即进入「就绪」状态，可直接建立代码索引、参与知识图谱构建与九阶段交付。

行为说明：

- 引用的目录**保持原位**，FlowForge 不做任何复制或移动；删除该仓库记录也不会影响磁盘上的目录。
- 若目录是 Git 仓库（含子目录，向上自动发现仓库根），自动探测当前分支，交付时正常创建 `feature/{deliveryId}-…` 分支隔离，可推送。
- 若目录**不是** Git 仓库：仓库卡片会标记「非 Git 目录」，交付时跳过分支隔离（有提示，流程继续可用），且不提供推送；代码索引与知识图谱功能不受影响。

---

## 4. 应用数据目录

FlowForge 使用 Tauri `appDataDir`，业务数据存于其下 `.flowforge/`（SQLite：`flowforge.db`，WAL 模式）：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/com.flowforge.sdlc/.flowforge/` |
| Windows | `%APPDATA%\com.flowforge.sdlc\.flowforge\`（即 `C:\Users\<用户名>\AppData\Roaming\com.flowforge.sdlc\.flowforge\`) |

- 备份/迁移：复制整个 `.flowforge` 目录即可（含 `flowforge.db` 及 `-wal`/`-shm` 附属文件）。
- 卸载后如需彻底清理，手动删除上述目录。

---

## 5. 故障排查

| 症状 | 处理 |
| --- | --- |
| 启动后提示 sidecar 失败 / `node not found` | 确认 Node ≥ 20 且在 PATH；或设置 `FLOWFORGE_NODE` 指向 node 可执行文件后重启应用 |
| 打包版提示 `packaged sidecar not found` | 安装包缺失 sidecar 资源，请重新安装官方构建，或用 `FLOWFORGE_SIDECAR_CMD` 临时指向本地构建 |
| Windows 白屏 | 安装 WebView2 Evergreen Runtime 后重试 |
| git 相关功能不可用 | 安装 Git（Windows 必须 Git for Windows）并确保 `git` 在 PATH |
