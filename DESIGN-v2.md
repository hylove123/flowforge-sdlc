# FlowForge SDLC — 整体设计优化方案

## 一、产品定位重新定义

FlowForge 本身就是一个**完整的交付智能体（Delivery Agent）**。

它不是一个被动的流程管理工具，而是具备感知、推理、行动、记忆四大能力的自主智能体：

- **感知**：通过 codebase-memory-mcp 索引项目代码，理解架构、模块、函数调用关系；通过文件监听感知外部工具的产出
- **推理**：基于本体知识图谱 + 规则引擎，判断阶段门禁、评估交付物质量、推导追溯链完整性
- **行动**：自主生成交付物、执行 AI 评审、唤起外部工具、推进流程状态
- **记忆**：代码知识图谱（结构）+ 交付知识图谱（语义）+ 团队知识资产（经验）

FlowForge 能独立完成从需求到交付的全部工作。同时，它也支持在任意阶段将任务委派给外部专业智能体（QoderWork / WorkBuddy / Cursor），并在回收产出后继续自己的流程管控。

```
┌──────────────────────────────────────────────────────────────┐
│                   FlowForge Agent Core                        │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐ │
│  │ 流程引擎    │  │ 本体规则    │  │ 上下文引擎             │ │
│  │ DAG编排     │  │ 门禁评估    │  │ 代码图谱 + 交付图谱    │ │
│  └────────────┘  └────────────┘  └────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │           代码知识图谱（Codebase Knowledge Graph）        │  │
│  │  函数/类/模块 · 调用关系 · 数据流 · 复杂度 · 变更影响     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└────────┬─────────────────────────────────┬───────────────────┘
         │                                 │
    ┌────▼─────────┐                 ┌────▼─────────┐
    │  自主执行      │                 │  协作执行     │
    │  内置LLM      │                 │  外部智能体   │
    │  代码检索     │                 │  QoderWork   │
    │  自动评审     │                 │  WorkBuddy   │
    │  图谱推理     │                 │  Cursor      │
    └──────────────┘                 └──────────────┘
```

---

## 二、双模执行模型

每个阶段支持两种执行模式，用户可随时切换：

### 模式 A：内置执行（Independent）

FlowForge 自己调用 LLM API 完成工作。适用于轻量任务、快速迭代、离线场景。

- 内置 AI 对话（已有 AiChatPanel）
- 一键生成交付物（已有 generateDeliverable）
- AI 自动评审（已有 aiReview）
- 本地 LLM 支持（Ollama / llama.cpp，Tauri 侧调 localhost）

### 模式 B：外派执行（Delegate）

将当前阶段的上下文打包后，交给外部智能体完成。适用于复杂任务、需要特定工具能力的场景。

外派流程：

```
1. 上下文打包（Context Engine）
   ├── 上游交付物摘要（从知识图谱提取）
   ├── 当前阶段模板和指引
   ├── 项目配置（规则、约束、技术栈）
   ├── 用户补充指令
   └── 输出为结构化 .md 文件

2. 派发（Tool Bridge）
   ├── URI Scheme 唤起：qoderwork://task?context=...
   ├── CLI 调用：workbuddy --task "..." --context ./ctx.md
   ├── 剪贴板：复制结构化 Prompt，用户粘贴到任意工具
   └── 文件投递：写入约定目录，工具自行读取

3. 回收（Import）
   ├── 文件监听：监控约定输出目录
   ├── 手动导入：拖拽 / 粘贴 / 选择文件（已有）
   ├── 剪贴板监听：检测剪贴板变化，提示导入
   └── 回调注册：工具完成后调用 FlowForge 的本地 HTTP 端口

4. 注册（Knowledge Graph）
   ├── 自动识别产出类型（Deliverable / TestCase / CodeModule）
   ├── 建立 DERIVED_FROM 追溯关系
   ├── 触发门禁评审
   └── 更新流程状态
```

---

## 三、Tool Bridge 设计（核心新增模块）

### 3.1 工具注册表

```javascript
// src/data/tools.js
export const TOOL_REGISTRY = [
  {
    id: 'qoderwork',
    name: 'QoderWork',
    icon: 'Bot',
    // 唤起方式
    launch: {
      uriScheme: 'qoderwork://chat',
      cli: null,  // QoderWork 暂无 CLI
      clipboard: true,
    },
    // 上下文传递方式
    contextChannel: 'clipboard',  // clipboard | file | uri-param
    // 产出回收方式
    outputChannel: 'file-watch',  // file-watch | clipboard | manual
    outputDir: '~/.qoderwork/workspace/*/outputs/',
    // 擅长的阶段
    bestFor: ['req', 'brd', 'prd', 'dev-plan', 'dev', 'review'],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    icon: 'Wand2',
    launch: {
      uriScheme: null,
      cli: 'workbuddy',
      clipboard: true,
    },
    contextChannel: 'file',
    outputChannel: 'file-watch',
    outputDir: './.workbuddy/output/',
    bestFor: ['req', 'prd', 'dev', 'deploy'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'Code2',
    launch: {
      uriScheme: 'cursor://file',
      cli: 'cursor',
      clipboard: false,
    },
    contextChannel: 'file',  // 写入 .cursorrules 或项目文件
    outputChannel: 'git-watch',  // 监听 git 变更
    bestFor: ['dev', 'review', 'auto-test'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: 'Terminal',
    launch: {
      cli: 'claude',
      clipboard: true,
    },
    contextChannel: 'cli-arg',
    outputChannel: 'file-watch',
    bestFor: ['dev', 'review', 'auto-test'],
  },
  {
    id: 'custom',
    name: '自定义工具',
    icon: 'Plug',
    launch: { clipboard: true },
    contextChannel: 'clipboard',
    outputChannel: 'manual',
    bestFor: [],  // 所有阶段
  },
]
```

### 3.2 上下文打包引擎（Context Engine）

每个阶段外派时，自动生成一份结构化上下文文件：

```markdown
<!-- .flowforge/context/{deliveryId}-{stageId}.md -->
# FlowForge 交付上下文

## 项目信息
- 项目：智能客服系统 v2.0
- 需求：智能客服对话引擎升级
- 当前阶段：PRD
- 优先级：P0

## 上游交付物

### 需求规格（质量分: 88）
[自动从知识图谱提取上游内容摘要，最多2000字]

### BRD（质量分: 85）
[自动提取]

## 当前阶段要求
- 目标：将业务需求转化为详细的产品规格，开发可执行
- 产出：PRD文档
- 质量检查清单：
  - 功能模块划分清晰
  - 每个功能有对应的用户故事
  - 验收标准具体且可测试
  - 包含异常流程处理

## 团队规则
- PRD完整性规则：确保PRD包含用户故事、验收标准、非功能需求
- 代码风格规则：强制Go/TypeScript代码风格统一

## 输出要求
请将产出保存为 Markdown 格式。完成后将文件放入：
`{projectDir}/.flowforge/output/{deliveryId}/prd.md`
或复制内容后在 FlowForge 中粘贴导入。
```

### 3.3 派发与回收（Tauri Rust 侧）

```rust
// src-tauri/src/commands/tool_bridge.rs

#[tauri::command]
async fn delegate_to_tool(
    tool_id: String,
    context_file: String,
    stage_id: String,
) -> Result<DelegateResult, String> {
    match tool_id.as_str() {
        "qoderwork" => {
            // 1. 读取上下文文件
            // 2. 复制到剪贴板
            // 3. 通过 URI scheme 唤起 QoderWork
            // 4. 启动文件监听等待产出
        }
        "cursor" => {
            // 1. 将上下文写入 .cursorrules
            // 2. 调用 `cursor {project_path}`
            // 3. 监听 git diff 作为产出
        }
        "claude-code" => {
            // 1. 调用 `claude --context {file} --task "..."`
            // 2. 捕获 stdout 作为产出
        }
        _ => {
            // 通用：复制到剪贴板 + 提示用户
        }
    }
}

#[tauri::command]
async fn watch_output(
    dir: String,
    delivery_id: String,
    stage_id: String,
) -> Result<(), String> {
    // 文件监听：检测到新文件后自动触发导入
    // 使用 notify crate 监听文件系统事件
}
```

---

## 四、代码智能层（Code Intelligence）

FlowForge 内置代码知识图谱引擎，通过索引项目代码仓库构建结构化的代码理解能力。这不是可选插件，而是 Agent Core 的基础感知层——每个阶段的 AI 推理都依赖它提供代码上下文。

### 4.1 索引引擎

基于 codebase-memory-mcp 的能力模型，FlowForge 在 Tauri Rust 侧实现代码索引：

```
项目代码仓库
    │
    ▼
┌─────────────────────────────────────────┐
│           Code Indexer（Rust 侧）        │
│                                         │
│  解析 → AST提取 → 符号表 → 调用图 → 存储 │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│        Code Knowledge Graph（SQLite）     │
│                                         │
│  节点：Function / Class / Module / Route │
│  边：CALLS / IMPORTS / IMPLEMENTS /      │
│      DATA_FLOW / CROSS_SERVICE           │
│  属性：complexity / loop_depth /         │
│        param_count / test_coverage       │
└─────────────────────────────────────────┘
```

索引能力（对标 codebase-memory-mcp）：

- **全文搜索**：BM25 排序 + camelCase 分词 + 结构标签加权
- **语义搜索**：向量余弦相似度，跨词汇匹配（搜 "publish" 能找到 "send"）
- **调用链追踪**：callers / callees / 数据流 / 跨服务调用
- **复杂度分析**：圈复杂度、认知复杂度、循环深度、线性扫描检测
- **变更影响分析**：修改一个函数，自动识别所有受影响的调用方
- **架构聚类**：Leiden 社区检测，发现事实上的模块边界

### 4.2 各阶段代码智能增强

代码图谱不是只在"开发"阶段有用——它贯穿整个交付流程：

| 阶段 | 代码智能用途 | 示例 |
|------|------------|------|
| 需求分析 | 影响范围评估：这个需求涉及哪些现有模块？ | "修改订单流程" → 自动列出 OrderService、PaymentGateway 等 12 个关联模块 |
| BRD | 技术可行性预判：现有架构能否支撑？ | 检测到当前系统无消息队列，提示"实时推送需引入 MQ" |
| PRD | 接口现状参考：已有哪些 API 可复用？ | 列出 `/api/v1/orders/*` 下 8 个现有端点及其参数 |
| 测试用例 | 覆盖率分析：哪些函数缺少测试？ | "OrderService.cancel() 圈复杂度 12，无单测覆盖" |
| 开发方案 | 架构理解：当前系统怎么设计的？ | 输出模块依赖图、核心调用链、数据流图 |
| 开发 | 精准代码检索：找到要改的位置 | "处理退款逻辑的函数在哪？" → RefundHandler.process() at line 42 |
| Code Review | 变更影响分析：这次改动影响了谁？ | "修改了 UserService.getById()，有 7 个调用方需关注" |
| 自动化测试 | 回归范围推荐：该跑哪些测试？ | 基于调用图推荐受影响的测试用例集 |
| 交付 | 变更清单生成：这次发了什么？ | 自动生成 Release Notes 中的技术变更列表 |

### 4.3 双图谱融合

FlowForge 维护两张知识图谱，并通过 IMPLEMENTS / VALIDATES 关系桥接：

```
┌─────────────────────┐         ┌─────────────────────┐
│   交付知识图谱        │         │   代码知识图谱        │
│   (Delivery Graph)   │         │   (Code Graph)       │
│                     │         │                     │
│  Requirement        │         │  Module             │
│  Deliverable        │◄────────│  Class              │
│  TestCase           │IMPLEMENTS│  Function           │
│  Review             │VALIDATES│  Route              │
│  KnowledgeAsset     │         │  Variable           │
│                     │         │                     │
│  关系：DERIVED_FROM  │         │  关系：CALLS         │
│  REQUIRES/PRODUCES  │         │  IMPORTS/DATA_FLOW  │
│  REVIEWED_BY        │         │  CROSS_SERVICE      │
└─────────────────────┘         └─────────────────────┘
```

融合后的能力：

- **需求→代码追溯**：从一条需求出发，追踪到 BRD → PRD → 技术方案 → 具体函数实现
- **代码→需求反查**：改了一个函数，自动关联到它实现的是哪条需求、哪个 PRD 功能点
- **测试→代码映射**：测试用例验证了哪些函数，哪些函数还没有测试覆盖
- **变更→交付影响**：一次 git commit 影响了哪些进行中的交付需求

### 4.4 上下文引擎增强（Context Engine v2）

外派或内置生成时，上下文不再只有"上游交付物"，还包含代码智能：

```javascript
// contextEngine.js — 增强版
export function buildStageContext(projectId, stageId, deliveryId) {
  const deliveryContext = getDeliveryGraphContext(projectId, stageId, deliveryId)
  const codeContext = getCodeGraphContext(projectId, stageId)

  return {
    // 上游交付物（已有）
    upstreamDeliverables: deliveryContext.context,

    // 代码智能（新增）
    codeIntelligence: {
      // 需求阶段：相关模块概览
      relevantModules: codeContext.modules,
      // 开发方案阶段：架构摘要
      architectureSummary: codeContext.architecture,
      // 开发阶段：目标代码片段
      targetCode: codeContext.snippets,
      // Review阶段：变更影响
      impactAnalysis: codeContext.impact,
      // 测试阶段：覆盖率缺口
      coverageGaps: codeContext.gaps,
    },

    // 团队知识资产（已有）
    knowledgeAssets: deliveryContext.assets,

    // 本体规则约束（已有）
    rules: deliveryContext.rules,
  }
}
```

### 4.5 索引管理 UI

在"项目配置"中新增"代码索引"面板：

- 添加仓库（本地路径 / Git URL）
- 索引状态（文件数、符号数、最后更新时间）
- 手动重建索引 / 增量更新（监听 git commit）
- 代码搜索测试框（输入查询，即时看结果）
- 架构可视化（模块依赖图、调用热力图）

### 4.6 Tauri 侧实现

```rust
// src-tauri/src/commands/code_index.rs

#[tauri::command]
async fn index_repository(
    project_id: String,
    repo_path: String,
    languages: Vec<String>,  // 过滤语言
) -> Result<IndexResult, String> {
    // 1. 遍历文件，按语言过滤
    // 2. 解析 AST（tree-sitter）
    // 3. 提取符号、调用关系、导入关系
    // 4. 计算复杂度指标
    // 5. 写入 SQLite code_graph 表
    // 6. 构建全文索引 + 向量索引
}

#[tauri::command]
async fn search_code(
    project_id: String,
    query: String,
    mode: SearchMode,  // FullText | Semantic | Pattern
    limit: u32,
) -> Result<Vec<CodeSearchResult>, String> {
    // 对标 codebase-memory-mcp 的 search_graph
}

#[tauri::command]
async fn trace_calls(
    project_id: String,
    function_name: String,
    direction: TraceDirection,  // Callers | Callees | Both
    depth: u32,
) -> Result<CallGraph, String> {
    // 对标 codebase-memory-mcp 的 trace_path
}

#[tauri::command]
async fn analyze_impact(
    project_id: String,
    changed_files: Vec<String>,  // git diff 的文件列表
) -> Result<ImpactReport, String> {
    // 变更影响分析：哪些函数/模块/路由受影响
}
```

---

## 五、流程引擎升级

### 5.1 从线性链到 DAG

当前流程是固定 9 阶段线性链。升级为有向无环图（DAG），支持并行线：

```
需求分析 → BRD → PRD ─┬→ 测试用例 ──────┐
                       ├→ 开发方案 → 开发 → Code Review → 自动化测试 → 交付
                       └→ 原型设计（可选）─┘
```

数据结构：

```javascript
// flowConfig 升级为 DAG 节点
{
  stage: 'prd',
  concept: 'Deliverable',
  label: 'PRD',
  agentId: 'a2',
  gate: { aiReview: true, humanReview: true, threshold: 75 },
  // 新增：后继节点（支持多个）
  next: ['test', 'dev-plan'],
  // 新增：前置依赖（所有前置完成才能进入）
  dependsOn: ['brd'],
}
```

### 5.2 阶段执行状态机

每个阶段的状态从简单的 pending/progress/complete 升级为：

```
idle → generating → awaiting-import → reviewing → gate-check → complete
  │         │              │              │            │
  │         ▼              ▼              ▼            ▼
  │    [内置AI生成]   [等待外部工具]  [AI评审中]   [门禁判定]
  │         │              │              │            │
  └─────────┴──────────────┴──────────────┴────────────┘
                        可回退重做
```

### 5.3 门禁引擎增强

```javascript
gate: {
  // 原有
  aiReview: true,
  humanReview: true,
  threshold: 75,
  // 新增
  requireTraceability: true,   // 必须有上游追溯关系
  requireTestCoverage: false,  // 开发阶段：测试覆盖率
  maxRetries: 3,               // AI评审最多重试次数
  autoAdvance: false,          // 门禁通过后是否自动推进
  notify: ['dingtalk-group'],  // 门禁通过后通知
}
```

---

## 六、知识图谱升级

### 6.1 存储：localStorage → SQLite（Tauri）

```sql
-- 实体表
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,        -- Requirement/Deliverable/CodeModule/...
  project_id TEXT,
  delivery_id TEXT,
  stage TEXT,
  label TEXT,
  properties JSON,             -- 灵活属性
  source TEXT DEFAULT 'builtin', -- builtin | qoderwork | workbuddy | cursor | manual
  created_at DATETIME,
  updated_at DATETIME
);

-- 关系表
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  relation TEXT NOT NULL,       -- DERIVED_FROM/IMPLEMENTS/VALIDATES/...
  source_id TEXT REFERENCES entities(id),
  target_id TEXT REFERENCES entities(id),
  project_id TEXT,
  properties JSON,
  created_at DATETIME
);

-- 索引
CREATE INDEX idx_entities_stage ON entities(stage, project_id);
CREATE INDEX idx_entities_delivery ON entities(delivery_id);
CREATE INDEX idx_edges_source ON edges(source_id, relation);
CREATE INDEX idx_edges_target ON edges(target_id, relation);
```

### 6.2 本体规则增强

在现有 5 条规则基础上，新增：

```javascript
// 来源追溯规则：记录产出来源
{
  id: 'rule-source-tracking',
  type: 'suggestion',
  label: '产出来源标记',
  description: '每个交付物应标记其产出来源（内置AI/外部工具/人工）',
}

// 一致性校验规则：外派产出必须与上游对齐
{
  id: 'rule-consistency-check',
  type: 'constraint',
  label: '上游一致性',
  description: '外派工具产出的交付物，AI评审时必须校验与上游交付物的一致性',
}

// 超时规则：外派任务超时提醒
{
  id: 'rule-delegate-timeout',
  type: 'suggestion',
  label: '外派超时提醒',
  description: '外派任务超过设定时间未回收产出时，提醒用户',
}
```

---

## 七、交互设计优化

### 7.1 阶段操作区重设计

当前阶段详情面板的操作区改为"执行模式选择器"：

```
┌─────────────────────────────────────────────────┐
│  PRD 阶段                          [当前进行中]   │
├─────────────────────────────────────────────────┤
│                                                 │
│  选择执行方式：                                   │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ 🤖 内置AI │  │ 🔗 外派   │  │ ✍️ 手动  │     │
│  │ 快速生成  │  │ 专业工具  │  │ 自行编写  │     │
│  └──────────┘  └──────────┘  └──────────┘     │
│                                                 │
│  [外派模式展开时]                                 │
│  选择工具：                                      │
│  ┌────────────────────────────────────────┐     │
│  │ ● QoderWork  推荐 · 擅长PRD           │     │
│  │ ○ WorkBuddy  已安装                    │     │
│  │ ○ Cursor     适合开发阶段              │     │
│  │ ○ 其他工具   复制Prompt手动使用         │     │
│  └────────────────────────────────────────┘     │
│                                                 │
│  [📋 复制上下文] [🚀 唤起工具] [📂 监听产出中...] │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 7.2 全局 Command Palette（Cmd+K）

```
> 生成 PRD          → 触发当前阶段内置AI生成
> 外派到 QoderWork  → 打包上下文 + 唤起工具
> 导入交付物        → 打开导入面板
> 评审             → 触发AI评审
> 推进             → 门禁检查 + 推进阶段
> 切换项目         → 项目列表
> 查看追溯         → 知识图谱可视化
```

### 7.3 系统托盘 + 通知

- 托盘图标显示当前交付进度（如 3/9）
- 外派任务完成时推送系统通知："QoderWork 已完成 PRD 生成，点击导入"
- 门禁通过时通知："PRD 评审通过（85分），可推进到测试用例阶段"
- 超时提醒："外派到 WorkBuddy 的任务已超过 30 分钟未回收"

### 7.4 拖拽交互

- 从 Finder 拖文件到阶段卡片 → 自动导入为该阶段交付物
- 阶段卡片之间拖拽 → 调整流程顺序（管理员模式）
- 从知识图谱拖实体到编辑器 → 插入引用

---

## 八、项目目录结构（Tauri 版）

```
flowforge-sdlc/
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── storage.rs       # SQLite 读写
│   │   │   ├── tool_bridge.rs   # 外部工具唤起/监听
│   │   │   ├── file_ops.rs      # 文件读写/监听
│   │   │   ├── git_ops.rs       # Git 操作
│   │   │   └── notify.rs        # 系统通知
│   │   └── db/
│   │       ├── mod.rs
│   │       ├── schema.sql
│   │       └── migrations/
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                          # React 前端（现有代码）
│   ├── components/
│   │   ├── ToolSelector.jsx     # 新增：工具选择器
│   │   ├── ContextPreview.jsx   # 新增：上下文预览
│   │   ├── DelegatePanel.jsx    # 新增：外派面板
│   │   ├── CommandPalette.jsx   # 新增：Cmd+K
│   │   ├── AiChatPanel.jsx      # 已有
│   │   ├── Sidebar.jsx          # 已有
│   │   └── TopBar.jsx           # 已有
│   ├── context/
│   │   ├── AppContext.jsx       # 已有（需拆分）
│   │   ├── ProjectContext.jsx   # 新增：拆出
│   │   └── DeliveryContext.jsx  # 新增：拆出
│   ├── data/
│   │   ├── ontology.js          # 已有（增强）
│   │   ├── stages.js            # 已有（DAG化）
│   │   └── tools.js             # 新增：工具注册表
│   ├── services/
│   │   ├── graph.js             # 已有 → 改为调 Tauri SQLite
│   │   ├── ai.js                # 已有（保留内置模式）
│   │   ├── contextEngine.js     # 新增：上下文打包
│   │   ├── toolBridge.js        # 新增：派发/回收
│   │   ├── codebaseIndex.js     # 已有 → 对接真实 MCP
│   │   └── repository.js        # 已有 → 对接真实 Git
│   ├── pages/
│   │   ├── Pipeline.jsx         # 已有（拆分重构）
│   │   ├── Dashboard.jsx        # 已有
│   │   ├── Projects.jsx         # 已有
│   │   ├── Agents.jsx           # 已有
│   │   ├── KnowledgeBase.jsx    # 已有
│   │   ├── ModelConfig.jsx      # 已有
│   │   └── Settings.jsx         # 已有
│   └── App.jsx
│
├── .flowforge/                   # 项目运行时数据（Git管理）
│   ├── context/                  # 外派上下文文件
│   ├── output/                   # 外部工具产出目录
│   └── flowforge.db             # SQLite 数据库
│
├── package.json
├── vite.config.js
└── tailwind.config.js
```

---

## 九、典型用户旅程

### 场景：PM 使用 QoderWork 完成 PRD

```
1. PM 打开 FlowForge，选择项目"智能客服系统"
2. 进入交付流水线，选择需求"对话引擎升级"，当前在 PRD 阶段
3. 点击"外派" → 选择 QoderWork
4. FlowForge 自动打包上下文：
   - 上游需求规格（88分）
   - 上游 BRD（85分）
   - PRD 模板和质量检查清单
   - 团队规则（PRD完整性规则）
5. 上下文复制到剪贴板，QoderWork 被唤起
6. PM 在 QoderWork 中粘贴/对话，完成 PRD 编写
7. QoderWork 输出 PRD.md 到 outputs 目录
8. FlowForge 文件监听检测到新文件，弹出通知：
   "检测到 QoderWork 产出，是否导入为 PRD 交付物？"
9. PM 确认导入
10. FlowForge 自动：
    - 注册到知识图谱（source: qoderwork）
    - 建立 DERIVED_FROM → BRD 的追溯关系
    - 触发 AI 评审（门禁要求）
    - 评审通过（82分 > 75分阈值）
    - 通知："PRD 评审通过，可推进到测试用例阶段"
11. PM 点击"推进"，流程进入下一阶段
```

### 场景：开发者使用 Cursor 完成编码

```
1. 开发者进入"开发"阶段
2. 选择"外派" → Cursor
3. FlowForge 将技术方案写入 .cursorrules：
   - API 接口定义
   - 数据库表结构
   - 编码规范要求
4. 唤起 Cursor，打开项目目录
5. 开发者在 Cursor 中基于技术方案编码
6. 完成后 git commit
7. FlowForge 检测到 git 变更：
   - 自动建立 IMPLEMENTS → 技术方案 的追溯关系
   - 提示："检测到新代码提交，是否触发 Code Review？"
8. 开发者确认，进入 Code Review 阶段
```

---

## 十、与现有 delivery-flow Skill 的关系

你已有的 `delivery-flow` skill 是 QoderWork 内部的流程编排器。FlowForge 与它的关系是：

- **FlowForge 是上层**：管理完整 SDLC 流程（需求→交付），持久化知识图谱
- **delivery-flow 是执行者之一**：在"开发"相关阶段（开发方案/开发/CR/自测），FlowForge 可以外派给 QoderWork，由 delivery-flow skill 在 QoderWork 内部编排执行

两者不冲突，是编排层级的不同：

```
FlowForge（交付编排器）
  └── 外派到 QoderWork
        └── delivery-flow skill（开发子流程编排）
              ├── it-prd-generator
              ├── it-impl-test-generator
              └── code-reviewer
```

---

## 十一、实施路线图

### Phase 1：Tauri 骨架 + SQLite（1周）

- 初始化 Tauri 项目，加载现有 React 前端
- 实现 SQLite 存储层，迁移 localStorage 数据
- 实现基础文件读写 Command
- 验证：项目数据持久化，重启不丢失

### Phase 2：Tool Bridge MVP（1周）

- 实现上下文打包引擎（contextEngine.js）
- 实现剪贴板派发 + 手动回收（最小可用）
- 实现文件监听回收（Tauri notify crate）
- 阶段操作区 UI 改造（三模式选择器）
- 验证：能从 FlowForge 外派到 QoderWork 并回收产出

### Phase 3：代码智能层（2周）

- 集成 tree-sitter，实现多语言 AST 解析（Java/TS/Go/Python）
- 实现代码索引引擎（符号提取、调用图、复杂度计算）
- 实现代码搜索（全文 BM25 + 模式匹配）
- 双图谱融合：CodeModule 实体与 Deliverable 建立 IMPLEMENTS 关系
- 各阶段上下文注入代码智能（需求影响分析、架构摘要、变更影响）
- 索引管理 UI（添加仓库、状态、搜索测试）
- 验证：在"开发方案"阶段自动注入项目架构摘要，在"Code Review"阶段输出变更影响

### Phase 4：流程引擎升级（1周）

- stages.js DAG 化（支持并行线）
- 门禁引擎增强
- 知识图谱来源追溯
- Command Palette
- 验证：PRD 完成后同时触发测试用例和开发方案

### Phase 5：深度集成 + 体验打磨（2周）

- Git 真实集成（clone/diff/log）+ git commit 触发增量索引
- 系统托盘 + 原生通知
- 拖拽导入
- 多窗口支持
- 团队数据共享（Git 仓库 / 钉钉云盘）
- 验证：完整的端到端交付流程（含代码智能增强）

---

## 十二、知识飞轮（Knowledge Flywheel）

FlowForge 不只是"用完就丢"的工具——每一次使用都在积累知识，让下一次使用更好。这是平台的核心竞争壁垒。

### 12.1 飞轮模型

```
        ┌─────────────────────────────────────────┐
        │                                         │
        ▼                                         │
   ┌─────────┐    ┌──────────┐    ┌─────────┐    │
   │ 使用平台 │───→│ 产出交付物 │───→│ 注册图谱 │    │
   └─────────┘    └──────────┘    └─────────┘    │
        ▲                              │          │
        │                              ▼          │
   ┌─────────┐    ┌──────────┐    ┌─────────┐    │
   │ 质量提升 │←───│ 上下文更丰│←───│ 模式沉淀 │    │
   └─────────┘    └──────────┘    └─────────┘    │
        │                                         │
        └─────────────────────────────────────────┘
```

每一圈循环，平台变得更聪明：

- 第 1 次写 PRD：AI 只有模板，产出 70 分
- 第 5 次写 PRD：AI 有前 4 次的 PRD + 评审反馈 + 用户修改痕迹，产出 85 分
- 第 20 次写 PRD：AI 已经"学会"了团队的写作风格、评审偏好、常见缺陷模式，产出 92 分

### 12.2 五层知识沉淀

| 层 | 沉淀什么 | 怎么沉淀 | 怎么反哺 |
|---|---|---|---|
| L1 交付物层 | 每次生成的 PRD/BRD/TS/测试用例 | 自动注册到交付图谱 | 作为下游阶段的上下文注入 |
| L2 评审层 | AI评审分数、维度得分、改进建议、人工评审意见 | 评审结果绑定到交付物实体 | 下次生成时注入"上次评审发现的问题"作为约束 |
| L3 修改层 | 用户对AI产出的编辑差异（diff） | 保存 original vs final 版本 | 提取"用户总是改什么"→ 修正生成模板 |
| L4 模式层 | 跨项目的共性模式（如"这个团队的PRD总需要时序图"） | 定期聚合分析所有交付物 | 更新阶段默认模板和检查清单 |
| L5 代码层 | 代码结构、架构模式、技术债、复杂度热点 | tree-sitter 索引 + git 变更追踪 | 需求阶段预警影响范围，开发阶段推荐实现路径 |

### 12.3 自动沉淀机制

以下过程对用户完全透明，无需额外操作：

**生成即沉淀**：每次 AI 生成或外部工具导入的交付物，自动注册到知识图谱，建立 DERIVED_FROM 追溯关系。不需要用户手动"保存"。

**评审即学习**：AI 评审的维度得分和改进建议，不仅用于当次门禁判定，还作为"质量信号"累积。当某类问题反复出现（如"PRD 总是缺少异常流程"），系统自动将其加入该阶段的检查清单。

**修改即训练**：用户编辑 AI 产出后保存，系统记录 diff。积累足够样本后，提取修改模式：
```javascript
// 修改模式提取示例
{
  stage: 'prd',
  pattern: '用户总是在"非功能需求"部分补充性能指标',
  frequency: 8,  // 8次中有7次用户补充了
  action: 'update_template',  // 自动更新模板，生成时主动包含性能指标
  confidence: 0.87,
}
```

**代码即知识**：每次 git commit 触发增量索引更新。代码图谱持续演化，自动识别：
- 新增模块（"最近2周新增了 payment-service"）
- 复杂度恶化（"OrderService 圈复杂度从 8 升到 15"）
- 架构漂移（"实际依赖关系偏离了技术方案中的设计"）

**跨项目继承**：团队级知识资产（规范、模板、最佳实践）在所有项目间共享。新项目创建时自动继承团队知识库，不需要从零配置。

### 12.4 知识资产自动演化

```javascript
// KnowledgeAsset 实体的自动演化
{
  id: 'ka_prd_template_v3',
  concept: 'KnowledgeAsset',
  label: 'PRD 模板 v3（自动演化）',
  properties: {
    type: 'template',
    version: 3,
    // 演化记录
    evolution: [
      { from: 'v1', to: 'v2', reason: '评审反馈：缺少验收标准', date: '2026-07-10' },
      { from: 'v2', to: 'v3', reason: '用户修改模式：总是补充时序图', date: '2026-07-20' },
    ],
    // 效果度量
    effectiveness: {
      avgScoreBefore: 72,  // v1 模板时平均评审分
      avgScoreAfter: 86,   // v3 模板时平均评审分
      sampleSize: 15,
    },
  },
}
```

### 12.5 飞轮度量看板

在 Dashboard 中展示知识积累状态：

- **知识图谱规模**：实体数、关系数、覆盖阶段数
- **质量趋势**：各阶段评审平均分随时间的变化曲线
- **模板演化**：哪些模板被自动更新过，效果如何
- **复用率**：新生成的交付物中，引用了多少历史知识
- **代码健康度**：复杂度趋势、技术债变化、测试覆盖率

### 12.6 隐私与边界

- 所有知识沉淀都在本地（SQLite + 文件系统），不上传任何云端
- 跨项目继承仅限同一台机器上的 FlowForge 实例
- 团队共享通过 Git 仓库显式同步，用户控制哪些知识资产共享
- 修改模式提取仅统计结构性模式，不记录具体业务内容

---

## 十三、技术选型总结

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2.x | 轻量（<10MB）、Rust 性能、原生 API |
| 前端 | React 18 + Vite 6（保留） | 现有代码复用 |
| 样式 | Tailwind 3（保留） | 现有代码复用 |
| 数据库 | SQLite（tauri-plugin-sql） | 零部署、文件级、SQL 查询 |
| 代码解析 | tree-sitter（Rust binding） | 多语言 AST、增量解析、高性能 |
| 代码索引 | 自研（BM25 + 调用图 + 复杂度） | 对标 codebase-memory-mcp 能力 |
| 文件监听 | notify crate（Rust） | 跨平台、高性能 |
| 进程管理 | tauri::api::process | 唤起外部工具 |
| 通知 | tauri-plugin-notification | 原生系统通知 |
| AI（内置） | OpenAI 兼容 API（保留） | 已有实现 |
| AI（本地） | Ollama localhost:11434 | 离线/隐私场景 |
| 团队同步 | Git 仓库 / 钉钉云盘 | 零后端成本 |
