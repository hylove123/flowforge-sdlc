# FlowForge SDLC Agent 平台能力调研报告

## 执行摘要

FlowForge 是一个**前端驱动的 SDLC 交付流程编排平台**（React + Vite SPA），已初步具备以下 Agent 平台特征：

- ✅ **AI 能力层**：OpenAI 兼容 API 集成 + 分阶段系统提示词
- ✅ **流程编排**：DAG 编排引擎 + 并行执行规划（前端模拟）
- ✅ **知识图谱**：本体驱动的链路追溯 + 实体关系管理
- ✅ **Agent 模型**：智能体配置 CRUD + 阶段分配
- ✅ **前端执行**：交付物生成、评审、流程推进（客户端驱动）
- ⚠️  **存储**：纯浏览器 localStorage + 无后端依赖

**关键差距**：无真实的分布式 Agent 运行时、无工具调用框架、无真实代码库集成、记忆机制仅为浏览器会话级。

---

## 一、现有能力清单（按模块）

### 1.1 整体架构

| 层级 | 技术栈 | 状态 |
|------|--------|------|
| **前端框架** | React 18.3 + React Router 6.28 | 完整 SPA 应用 |
| **状态管理** | React Context + useReducer | 全局 AppContext |
| **UI 组件库** | shadcn/ui + Tailwind CSS 3.4 + Lucide 图标 | 完整设计系统 |
| **构建工具** | Vite 6.0 + 多阶段 Docker 构建 | 开发/生产流程完备 |
| **部署模型** | Docker nginx 单镜像 + compose 编排 | 纯前端部署，无后端 |
| **测试框架** | Vitest 4.1 + Testing Library + Playwright E2E | 测试基础设施到位 |

### 1.2 AI 能力层

**文件**: `/src/services/ai.js` (547 行)

#### 模型管理 (真实实现)
- **自定义模型注册**：添加/编辑/删除/激活 OpenAI 兼容 API
- **存储**：localStorage `flowforge_custom_models` / `flowforge_active_model`
- **支持配置**：API 地址、Token、模型 ID、启用/禁用、连接测试

**ModelConfig.jsx 支持项**：
```
- 模型名称（腾讯云混元、GPT-4o 等）
- API 地址（https://api.lkeap.cloud.tencent.com/v1）
- Token（API Key）
- 模型 ID（hunyuan-pro / gpt-4o / deepseek-chat 等）
- 启用/禁用开关
- 连接测试（POST /chat/completions 验证）
```

#### 对话能力 (真实实现)
- **非流式调用**：`callLLM(messages)` → POST
- **流式调用**：`streamChat(messages)` → SSE 逐 chunk 解析
- **舞台感知**：`streamStageChat()` 注入阶段系统提示词
- **知识注入**：`getAIContext()` 自动追踪上游交付物

#### 生成能力 (真实实现)
- **交付物生成**：`generateDeliverable()` 支持模板 + 用户指令 + 图谱上下文 + 会话历史
- **流式生成**：`streamGenerateDeliverable()` 支持长交付物流式输出
- **AI 评审**：`aiReview()` 返回 JSON 评分（0-100分）+ 四维度评估

#### 系统提示词 (配置化实现)
9 个预定义阶段提示词（需求分析师、商业分析师、产品经理、测试工程师、架构师等）

**评分**：8/10 — OpenAI 集成完整；但纯客户端调用（无后端审计）

---

### 1.3 流程编排能力

**文件**: `/src/data/flowEngine.js` (496 行) + Pipeline.jsx (1895 行)

#### DAG 编排引擎 (前端模拟实现)
- **节点定义**：含 position、dependsOn、config（skills/mcps/rules/model/gate/guidance）
- **核心能力**：
  - `buildDefaultDAG()` — 标准流程（需求→BRD→PRD→并行(测试+开发方案→开发)→CR→自测→交付）
  - `validateDAG()` — 循环检测 + 孤立节点检查
  - `topologicalSort()` / `getParallelGroups()` — 拓扑排序 + 并行组识别
  - `dagToStageList()` / `dagToFlowConfigFull()` — DAG ↔ 旧版 flowConfig 互转

- **执行模型**：前端模拟（无真实执行运行时）
  - 支持阶段手动推进（Pipeline.jsx 按钮驱动）
  - 无自动触发、无异步编排
  - 所有状态存储于 AppContext（内存 + localStorage）

**评分**：5/10 — DAG 编排在前端完全模拟，无真实执行运行时

---

### 1.4 知识图谱能力

**文件**: `/src/services/graph.js` (575 行) + `/src/data/ontology.js` (408 行)

#### 本体定义 (完整实现)
**7 个 CONCEPTS**：
- Requirement、Deliverable、CodeModule、TestCase、Review、KnowledgeAsset、Agent

**6 个 RELATIONS** (双向)：
- DERIVED_FROM / DERIVES、IMPLEMENTS / IMPLEMENTED_BY、VALIDATES / VALIDATED_BY、REVIEWED_BY / REVIEWS

**追溯链检索** (真实实现)：
- `getAIContext()` — 根据流程配置 + 项目 + 阶段，自动检索上游交付物
- 返回格式：`[{ stageLabel, entityLabel, content, qualityScore }, ...]`
- 自动注入 AI 聊天/生成的系统提示词

**评分**：8/10 — 本体设计完整；但数据量有限（仅 localStorage）

---

### 1.5 代码库索引能力

**文件**: `/src/services/codebaseIndex.js` (181 行)

#### 当前状态 (完全 Mock 实现)
- `startIndexing()` — 模拟 2 秒延迟后返回模拟统计
- `searchCodebase()` — 返回模拟搜索结果
- 存储：localStorage `flowforge_codebase_index`

**评分**：2/10 — 完全 Mock，无真实代码解析

---

### 1.6 Agent 能力

**文件**: `/src/pages/Agents.jsx` (760 行)

#### Agent 模型 (CRUD 实现)
- **结构**：id, name, description, model, systemPrompt, temperature, skills, mcpTools, rules, assignedStages
- **管理**：创建/编辑/删除/启用停用/导出/导入

#### 能力标注 (配置但无执行)
- **Skills**：可配置名称 + URL/文件，但无调用机制
- **MCP Tools**：可配置，但无工具调用框架
- **Rules**：可配置，但无规则引擎

**评分**：4/10 — Agent 配置完整，但缺少执行运行时

---

### 1.7 数据持久化

| 数据 | 存储 | 是否真实 |
|-----|------|---------|
| 自定义模型 | localStorage `flowforge_custom_models` | ✅ 真实 |
| 知识图谱 | localStorage `flowforge_knowledge_graph` | ✅ 真实 |
| DAG 流程 | localStorage `flowforge_dag_list` | ✅ 真实 |
| 代码索引 | localStorage `flowforge_codebase_index` | Mock |
| 消息历史 | React state（内存） | 不持久 |

**当前**：零后端，纯浏览器 localStorage（5-10MB 上限）

---

## 二、与完整 Agent 平台的差距

| 能力维度 | 完整 Agent 平台应有 | FlowForge 当前 | 缺口 |
|---------|------------------|--------------|------|
| **Agent 运行时** | LangGraph/AutoGen 真实编排 | 前端模拟 DAG | **严重** |
| **工具调用框架** | function_calling / MCP 实现 | 仅配置存储 | **严重** |
| **RAG 知识库** | 向量索引 + 混合检索 | localStorage 图 + Mock 代码索引 | **严重** |
| **记忆系统** | 短期+长期+工作内存 | 会话级内存 | **严重** |
| **工作流引擎** | 真实异步编排、重试、回滚 | 前端同步、手动推进 | **严重** |
| **可观测性** | 日志聚合、调用链追踪 | console.log + localStorage | **严重** |
| **本体知识** | 领域本体 + 规则引擎 | 完整 SDLC 本体 | ✅ 已有 |
| **追溯链** | 全链路追踪 | 追溯链引擎完整 | ✅ 已有 |

---

## 三、关键文件清单

### 核心逻辑
- `/src/context/AppContext.jsx` — 全局状态（1129 行）
- `/src/services/ai.js` — LLM 集成（547 行）
- `/src/services/graph.js` — 知识图谱（575 行）
- `/src/data/flowEngine.js` — DAG 编排（496 行）
- `/src/data/ontology.js` — 本体定义（408 行）

### 页面组件
- `/src/pages/Pipeline.jsx` — 交付流程（1895 行）
- `/src/pages/ProjectConfig.jsx` — 项目配置（1566 行）
- `/src/pages/Agents.jsx` — Agent 管理（759 行）

### 配置与部署
- `/Dockerfile` — 多阶段构建
- `/docker-compose.yml` — 容器编排
- `/DESIGN-v3.md` — 未来演进规划（Tauri + LangGraph）

---

## 四、推荐演进方案

### 短期（2-4 周）— 客户端完善
1. IndexedDB 替代 localStorage
2. 对话历史落库 + 会话管理
3. 模型成本追踪

### 中期（1-2 月）— 后端基础设施
1. Tauri 2.x 桌面壳 + Node.js Sidecar
2. LangGraph.js 真实执行运行时
3. tree-sitter 代码索引 + 向量检索

### 长期（2-4 月）— 平台完整性
1. 多租户 / RBAC 权限体系
2. MCP 工具框架
3. 分布式追踪 + 性能分析

---

## 结论

**FlowForge 是优秀的 SDLC 流程 UI + 本体框架，但不是真正的 Agent 平台。**

- ✅ **优势**：本体完整、追溯链完善、OpenAI 灵活、DAG UI 直观
- ❌ **劣势**：无真实执行运行时、无工具调用、无真实知识库、纯客户端部署

**推荐接入框架**：
- **LangGraph.js** — 运行时基础（DAG 状态机 + Checkpoint）
- **Cognee** — 知识图谱 + 向量检索
- **Tauri 2.x** — 桌面化 + 文件系统访问
