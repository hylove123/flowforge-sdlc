# FlowForge SDLC v3 — 落地设计方案

> 版本：v3.0 | 日期：2026-07-23
> 架构策略：三件套（LangGraph.js + Cognee + Tauri 2.x）+ 自建领域层
> 设计原则：成熟开源组件优先，仅在差异化核心（SDLC 领域逻辑、Tool Bridge、飞轮策略）上自研

---

## 一、产品定位

FlowForge 是一个**本地优先的交付智能体（Delivery Agent）**，具备五大能力：

| 能力 | 实现方式 | 依赖组件 |
|------|---------|---------|
| 感知 | 代码索引（tree-sitter）+ 文件监听 + 外部工具产出检测 | Tauri Rust 侧 |
| 推理 | 本体规则 + 门禁评估 + 追溯链完整性校验 | Cognee 本体 grounding |
| 行动 | 生成交付物 / AI 评审 / 唤起外部工具 / 推进流程 | LangGraph 状态机 |
| 记忆 | 知识图谱（交付+代码）+ 团队知识资产 + 会话记忆 | Cognee remember/recall |
| 反思 | 策略评估 / 上下文评估 / 失败归因 / 自我修正 | LangGraph Reflection |

核心差异化：
- **本体驱动的 SDLC 流程**（非通用 Agent 平台）
- **Tool Bridge 外派模式**（跨工具边界的人机协作）
- **知识飞轮**（使用即积累，越用越聪明）

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    React 前端（现有 UI 资产）                      │
│  Pipeline · Dashboard · Projects · KnowledgeBase · Settings      │
├─────────────────────────────────────────────────────────────────┤
│                    Tauri 2.x 桌面壳                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Rust 后端                                                 │  │
│  │  ├── 文件系统 / 进程管理 / 系统通知                          │  │
│  │  ├── Git 操作（clone/diff/log/watch）                      │  │
│  │  ├── tree-sitter 代码索引                                  │  │
│  │  └── SQLite（tauri-plugin-sql）                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Node.js Sidecar（Tauri sidecar 进程）                      │  │
│  │  ├── LangGraph.js — DAG 状态机 / 反思循环 / Checkpoint      │  │
│  │  ├── Cognee — 知识图谱 / 本体生成 / 记忆 API               │  │
│  │  └── FlowForge 领域服务 — SDLC 逻辑 / Tool Bridge / 飞轮   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                                    │
    ┌────▼─────────┐                   ┌────▼─────────┐
    │  自主执行      │                   │  协作执行     │
    │  内置 LLM     │                   │  QoderWork   │
    │  代码检索     │                   │  WorkBuddy   │
    │  自动评审     │                   │  Cursor      │
    │  图谱推理     │                   │  Claude Code │
    └──────────────┘                   └──────────────┘
```

### 2.1 组件职责边界

| 组件 | 负责 | 不负责 |
|------|------|--------|
| **LangGraph.js** | DAG 编排、状态转移、checkpoint、反思循环、human-in-the-loop interrupt | 业务逻辑、知识存储、UI |
| **Cognee** | 知识图谱构建/查询、本体生成/grounding、记忆 API、向量+图谱混合检索 | 流程编排、代码解析、UI |
| **Tauri Rust** | 文件系统、进程唤起、Git 操作、tree-sitter 解析、系统通知、SQLite | AI 推理、知识图谱 |
| **自建领域层** | SDLC 阶段定义/模板/门禁规则、Tool Bridge、知识飞轮策略、上下文打包逻辑 | 状态机实现、图谱存储 |

### 2.2 进程通信

```
React 前端 ←──invoke──→ Tauri Rust（文件/Git/通知/SQLite）
React 前端 ←──invoke──→ Tauri Rust ←──IPC──→ Node Sidecar（LangGraph/Cognee/领域服务）
```

前端所有 AI/知识/流程操作统一通过 `invoke('sidecar_request', { method, params })` 调用，Rust 侧转发给 Node sidecar。

---

## 三、Agent Runtime：LangGraph.js 集成

### 3.1 为什么选 LangGraph

| 需求 | LangGraph 原生支持 |
|------|-------------------|
| DAG 流程（并行线、条件分支） | 图状态机，节点即阶段，边即转移 |
| 反思循环 | `langgraph-reflection` 包：critique → revise → re-evaluate |
| 断点恢复 | SQLite checkpoint，进程重启后从上次状态继续 |
| 门禁审批（human-in-the-loop） | `interrupt_before` / `interrupt_after` 节点 |
| 条件路由（评审通过/不通过） | conditional edge |
| Time-travel 调试 | checkpoint 回放 |

### 3.2 SDLC 流程图定义

```typescript
// sidecar/src/graph/sdlcGraph.ts
import { StateGraph, END } from '@langchain/langgraph'
import { reflection } from 'langgraph-reflection'

// 状态定义
interface SDLCState {
  projectId: string
  deliveryId: string
  currentStage: string
  deliverable: string | null
  reviewScore: number | null
  reviewFeedback: string | null
  executionMode: 'builtin' | 'delegate' | 'manual'
  contextPackage: object | null
  reflectionLog: ReflectionEntry[]
  retryCount: number
}

// 构建 DAG
const graph = new StateGraph<SDLCState>({
  channels: { /* ... */ },
})

// 节点：每个 SDLC 阶段
graph.addNode('req', reqStageNode)
graph.addNode('brd', brdStageNode)
graph.addNode('prd', prdStageNode)
graph.addNode('test', testStageNode)        // 可与 dev-plan 并行
graph.addNode('dev-plan', devPlanStageNode)  // 可与 test 并行
graph.addNode('dev', devStageNode)
graph.addNode('review', reviewStageNode)
graph.addNode('auto-test', autoTestStageNode)
graph.addNode('deploy', deployStageNode)

// 反思节点（每个阶段完成后触发）
graph.addNode('reflect', reflectionNode)

// 边：DAG 结构
graph.addEdge('req', 'brd')
graph.addEdge('brd', 'prd')
// PRD 完成后并行触发测试用例和开发方案
graph.addConditionalEdges('prd', routeAfterPrd, {
  parallel: ['test', 'dev-plan'],
})
graph.addEdge('test', 'review')       // test 完成后汇入 review
graph.addEdge('dev-plan', 'dev')
graph.addEdge('dev', 'review')
graph.addEdge('review', 'auto-test')
graph.addEdge('auto-test', 'deploy')
graph.addEdge('deploy', END)

// 每个阶段节点内部包含反思循环
// reflectionNode 在阶段完成后自动触发
```

### 3.3 阶段节点内部逻辑

每个阶段节点是一个子图（subgraph），内部执行：

```typescript
// sidecar/src/graph/stageNode.ts
async function stageNode(state: SDLCState, config: StageConfig) {
  // 1. 上下文组装（调 Cognee 获取知识）
  const context = await buildStageContext(state, config)

  // 2. 执行（根据模式）
  let output: string
  if (state.executionMode === 'builtin') {
    output = await generateWithLLM(context, config)
  } else if (state.executionMode === 'delegate') {
    output = await delegateAndWait(state, config)  // Tool Bridge
  } else {
    output = await waitForManualImport(state)       // 等待用户手动导入
  }

  // 3. AI 评审（如果门禁要求）
  let review = null
  if (config.gate.aiReview) {
    review = await aiReview(output, context, config)
  }

  // 4. 注册到知识图谱（调 Cognee）
  await cognee.remember({
    type: 'deliverable',
    stage: config.stageId,
    content: output,
    review,
    source: state.executionMode,
    deliveryId: state.deliveryId,
  })

  return { ...state, deliverable: output, reviewScore: review?.score }
}
```

### 3.4 反思循环（Reflection Engine）

```typescript
// sidecar/src/graph/reflection.ts
import { createReflection } from 'langgraph-reflection'

// 反思触发条件
const REFLECTION_TRIGGERS = {
  lowScore: (state) => state.reviewScore < state.gate.threshold,
  highEditRatio: (state) => state.userEditRatio > 0.4,
  stageComplete: (state) => state.currentStageCompleted === true,
  milestone: (state) => state.deliveryCompleted === true,
}

// 反思节点
async function reflectionNode(state: SDLCState) {
  const critique = await llm.invoke([
    { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({
        stage: state.currentStage,
        executionMode: state.executionMode,
        reviewScore: state.reviewScore,
        reviewFeedback: state.reviewFeedback,
        contextInjected: state.contextPackage?.summary,
        userEditRatio: state.userEditRatio,
        retryCount: state.retryCount,
      })
    },
  ])

  // 解析反思结论，生成策略调整
  const actions = parseReflectionActions(critique)

  // 应用策略调整
  for (const action of actions) {
    switch (action.type) {
      case 'fix_context_rule':
        await updateContextRule(action.rule)
        break
      case 'suggest_delegate':
        // 下次同类任务推荐外派模式
        await updateStrategyPreference(state.currentStage, 'delegate')
        break
      case 'update_checklist':
        await appendToChecklist(state.currentStage, action.item)
        break
      case 'retry_with_revision':
        // 将反思反馈注入下次生成
        state.reflectionFeedback = action.feedback
        break
    }
  }

  return { ...state, reflectionLog: [...state.reflectionLog, { critique, actions }] }
}

// 反思 System Prompt
const REFLECTION_SYSTEM_PROMPT = `你是 FlowForge 的反思引擎。你的任务是分析刚刚完成的阶段执行，找出可以改进的地方。

分析维度：
1. 策略评估：执行模式选择是否合理？（内置LLM产出低分是否应建议外派？）
2. 上下文评估：注入的知识是否命中？（评审反馈是否指出缺少某类信息？）
3. Prompt 评估：生成指令是否充分？（是否遗漏了关键约束？）
4. 流程评估：有无不必要的等待或重复？

输出 JSON 格式的改进行动列表。`
```

### 3.5 Checkpoint 持久化

```typescript
// sidecar/src/graph/checkpoint.ts
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'

// 使用 Tauri 管理的 SQLite 文件
const checkpointer = new SqliteSaver({
  dbPath: '{projectDir}/.flowforge/flowforge.db',
})

// 编译图时注入 checkpointer
const app = graph.compile({
  checkpointer,
  interruptBefore: ['review'],  // 门禁审批前暂停，等待人工确认
})

// 断点恢复：进程重启后从上次 checkpoint 继续
const config = { configurable: { thread_id: `${projectId}_${deliveryId}` } }
const currentState = await app.getState(config)
```

---

## 四、知识层：Cognee 集成

### 4.1 为什么选 Cognee

| 需求 | Cognee 原生支持 |
|------|----------------|
| 知识图谱自动构建 | 实体+关系自动提取，混合存储（图+向量+关系） |
| 本体生成 | 自动 ontology generation + grounding |
| 记忆 API | remember / recall / forget / improve |
| 本地部署 | SQLite + LanceDB + KuzuDB，零外部依赖 |
| 跨 Agent 知识共享 | 租户隔离 + 共享机制 |
| MCP 兼容 | 内置 MCP Server，天然对接外部 Agent |
| TypeScript 支持 | 官方 TS client |

### 4.2 初始化与配置

```typescript
// sidecar/src/knowledge/cognee.ts
import { Cognee } from 'cognee-ts'  // TypeScript client

const cognee = new Cognee({
  // 本地嵌入式模式，无需外部服务
  storage: {
    type: 'sqlite',
    path: '{projectDir}/.flowforge/cognee.db',
  },
  vectorStore: {
    type: 'lancedb',
    path: '{projectDir}/.flowforge/vectors/',
  },
  graphStore: {
    type: 'kuzu',
    path: '{projectDir}/.flowforge/graph/',
  },
  // LLM 配置（复用 FlowForge 的模型配置）
  llm: {
    provider: 'openai-compatible',
    endpoint: 'http://localhost:11434/v1',  // Ollama 或用户配置的 API
    model: 'deepseek-chat',
  },
  embedder: {
    provider: 'openai-compatible',
    endpoint: 'http://localhost:11434/v1',
    model: 'nomic-embed-text',
  },
})
```

### 4.3 Seed Schema（本体约束注入）

Cognee 默认自底向上生成本体。FlowForge 需要自顶向下约束——将现有 ontology.js 的 7 概念 + 14 关系作为 seed schema 注入：

```typescript
// sidecar/src/knowledge/seedOntology.ts
import { CONCEPTS, RELATIONS, ONTOLOGY_RULES } from '../domain/ontology'

export async function initializeOntology() {
  // 将 FlowForge 的领域本体作为 Cognee 的 seed schema
  await cognee.ontology.setSchema({
    concepts: CONCEPTS.map(c => ({
      name: c.id,           // Requirement, Deliverable, CodeModule, TestCase, Review, KnowledgeAsset, Agent
      properties: c.properties,
      description: c.description,
    })),
    relations: RELATIONS.map(r => ({
      name: r.id,           // DERIVED_FROM, IMPLEMENTS, VALIDATES, ...
      source: r.source,
      target: r.target,
      inverse: r.inverse,
    })),
    rules: ONTOLOGY_RULES.map(r => ({
      id: r.id,
      type: r.type,         // constraint | suggestion
      description: r.description,
    })),
  })

  // Cognee 在此约束内自动扩展（发现新的子类型、属性等）
  // 但不会超出 seed schema 定义的概念边界
}
```

### 4.4 知识操作 API

```typescript
// sidecar/src/knowledge/knowledgeService.ts

// === 沉淀（写入） ===

// 交付物注册（生成即沉淀）
export async function registerDeliverable(deliverable: {
  stage: string
  content: string
  source: 'builtin' | 'qoderwork' | 'workbuddy' | 'cursor' | 'manual'
  deliveryId: string
  projectId: string
  review?: { score: number; feedback: string; dimensions: object }
}) {
  await cognee.remember({
    type: 'Deliverable',
    stage: deliverable.stage,
    content: deliverable.content,
    metadata: {
      source: deliverable.source,
      deliveryId: deliverable.deliveryId,
      projectId: deliverable.projectId,
      reviewScore: deliverable.review?.score,
      createdAt: new Date().toISOString(),
    },
    // Cognee 自动：提取实体、建立关系、更新图谱
  })
}

// 代码模块注册（代码即知识）
export async function registerCodeModule(module: {
  name: string
  path: string
  symbols: string[]
  complexity: number
  calls: string[]
  imports: string[]
}) {
  await cognee.remember({
    type: 'CodeModule',
    ...module,
  })
}

// === 检索（读取） ===

// 阶段上下文检索
export async function recallStageContext(projectId: string, stage: string, deliveryId: string) {
  // 1. 上游交付物（按 DERIVED_FROM 链追溯）
  const upstream = await cognee.recall({
    query: `project:${projectId} delivery:${deliveryId} upstream deliverables`,
    filters: { type: 'Deliverable', projectId },
    graphTraversal: { relation: 'DERIVED_FROM', direction: 'upstream', depth: 3 },
  })

  // 2. 相关代码模块（按 IMPLEMENTS 关系）
  const codeContext = await cognee.recall({
    query: `project:${projectId} stage:${stage} relevant code`,
    filters: { type: 'CodeModule', projectId },
  })

  // 3. 团队知识资产（模板、规范、最佳实践）
  const assets = await cognee.recall({
    query: `stage:${stage} templates rules best-practices`,
    filters: { type: 'KnowledgeAsset' },
  })

  // 4. 历史反思记录（同类阶段的改进建议）
  const reflections = await cognee.recall({
    query: `stage:${stage} reflection improvements`,
    filters: { type: 'ReflectionLog', stage },
    limit: 5,
  })

  return { upstream, codeContext, assets, reflections }
}

// === 遗忘（清理） ===
export async function forgetObsolete(projectId: string, olderThan: string) {
  await cognee.forget({
    filters: { projectId, createdAt: { $lt: olderThan }, type: 'SessionMemory' },
  })
}

// === 改进（飞轮） ===
export async function improveFromFeedback(feedback: {
  stage: string
  pattern: string
  action: string
  confidence: number
}) {
  await cognee.improve({
    target: { type: 'KnowledgeAsset', stage: feedback.stage, assetType: 'template' },
    instruction: feedback.pattern,
    confidence: feedback.confidence,
  })
}
```

### 4.5 双图谱融合

Cognee 统一管理交付图谱和代码图谱，通过 IMPLEMENTS / VALIDATES 关系桥接：

```
┌─────────────────────────────────────────────────────────────┐
│                    Cognee Knowledge Graph                     │
│                                                             │
│  ┌─────────────────┐              ┌─────────────────┐      │
│  │  交付子图         │              │  代码子图         │      │
│  │                 │              │                 │      │
│  │  Requirement    │              │  Module         │      │
│  │  Deliverable    │◄─IMPLEMENTS──│  Class          │      │
│  │  TestCase       │◄─VALIDATES───│  Function       │      │
│  │  Review         │              │  Route          │      │
│  │  KnowledgeAsset │              │                 │      │
│  │  ReflectionLog  │              │  关系：CALLS     │      │
│  │                 │              │  IMPORTS        │      │
│  │  关系：          │              │  DATA_FLOW      │      │
│  │  DERIVED_FROM   │              │  CROSS_SERVICE  │      │
│  │  REQUIRES       │              │                 │      │
│  │  REVIEWED_BY    │              │                 │      │
│  └─────────────────┘              └─────────────────┘      │
│                                                             │
│  统一查询：                                                  │
│  "修改了 OrderService.cancel()，影响了哪条需求的哪个功能点？"   │
│  → 从 Function 节点沿 IMPLEMENTS 反查到 Deliverable          │
│  → 再沿 DERIVED_FROM 追溯到 Requirement                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 五、代码智能层

### 5.1 索引引擎（Tauri Rust 侧）

代码解析在 Rust 侧完成（性能），解析结果写入 Cognee 图谱：

```rust
// src-tauri/src/commands/code_index.rs

#[tauri::command]
async fn index_repository(
    project_id: String,
    repo_path: String,
    languages: Vec<String>,
) -> Result<IndexResult, String> {
    // 1. 遍历文件，按语言过滤（.java/.ts/.go/.py）
    // 2. tree-sitter 解析 AST
    // 3. 提取：函数/类/模块/路由 + 调用关系 + 导入关系
    // 4. 计算：圈复杂度、认知复杂度、参数数量
    // 5. 通过 IPC 发送给 Node sidecar → cognee.remember()
    // 6. 返回索引统计
}

#[tauri::command]
async fn incremental_index(
    project_id: String,
    changed_files: Vec<String>,  // git diff 输出
) -> Result<IndexResult, String> {
    // 增量索引：只解析变更文件，更新图谱
}
```

### 5.2 各阶段代码智能增强

| 阶段 | 代码智能用途 | 查询方式 |
|------|------------|---------|
| 需求分析 | 影响范围评估 | `cognee.recall({ query: "modules affected by {requirement}" })` |
| BRD | 技术可行性预判 | 检测架构中是否存在所需能力 |
| PRD | 现有 API 参考 | 按 Route 类型检索相关端点 |
| 测试用例 | 覆盖率缺口 | 高复杂度 + 无测试的函数 |
| 开发方案 | 架构理解 | 模块依赖图 + 核心调用链 |
| 开发 | 精准代码定位 | BM25 + 语义搜索 |
| Code Review | 变更影响分析 | git diff → 受影响调用方 |
| 自动化测试 | 回归范围推荐 | 调用图推导受影响测试 |
| 交付 | 变更清单生成 | git log → Release Notes |

### 5.3 索引管理

- 添加仓库：本地路径 / Git URL（Tauri 侧 git clone）
- 增量更新：监听 git commit（Tauri notify crate），自动触发 incremental_index
- 手动重建：全量重新解析
- 状态展示：文件数、符号数、最后更新时间、语言分布

---

## 六、Tool Bridge（自建核心）

### 6.1 工具注册表

```typescript
// sidecar/src/domain/tools.ts
export const TOOL_REGISTRY = [
  {
    id: 'qoderwork',
    name: 'QoderWork',
    launch: { uriScheme: 'qoderwork://chat', clipboard: true },
    contextChannel: 'clipboard',
    outputChannel: 'file-watch',
    outputDir: '~/.qoderwork/workspace/*/outputs/',
    bestFor: ['req', 'brd', 'prd', 'dev-plan', 'dev', 'review'],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    launch: { cli: 'workbuddy', clipboard: true },
    contextChannel: 'file',
    outputChannel: 'file-watch',
    outputDir: './.workbuddy/output/',
    bestFor: ['req', 'prd', 'dev', 'deploy'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    launch: { uriScheme: 'cursor://file', cli: 'cursor' },
    contextChannel: 'file',  // 写入 .cursorrules
    outputChannel: 'git-watch',
    bestFor: ['dev', 'review', 'auto-test'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    launch: { cli: 'claude', clipboard: true },
    contextChannel: 'cli-arg',
    outputChannel: 'file-watch',
    bestFor: ['dev', 'review', 'auto-test'],
  },
  {
    id: 'custom',
    name: '自定义工具',
    launch: { clipboard: true },
    contextChannel: 'clipboard',
    outputChannel: 'manual',
    bestFor: [],
  },
]
```

### 6.2 外派流程

```
1. 上下文打包（Context Engine）
   ├── 上游交付物摘要（cognee.recall → DERIVED_FROM 链）
   ├── 代码智能（cognee.recall → 相关模块/架构）
   ├── 当前阶段模板 + 质量检查清单
   ├── 团队规则
   ├── 历史反思建议（同类阶段的改进点）
   └── 输出为结构化 .md 文件

2. 派发（Tauri Rust 侧）
   ├── URI Scheme 唤起
   ├── CLI 调用
   ├── 剪贴板复制
   └── 文件投递（.cursorrules / 约定目录）

3. 回收
   ├── 文件监听（notify crate → 检测 outputDir 新文件）
   ├── Git 监听（检测新 commit）
   ├── 手动导入（拖拽/粘贴/选择文件）
   └── 剪贴板监听

4. 注册
   ├── cognee.remember() → 自动建立追溯关系
   ├── 触发 LangGraph 门禁评审节点
   └── 更新流程状态
```

### 6.3 上下文打包引擎

```typescript
// sidecar/src/domain/contextEngine.ts
export async function buildContextPackage(
  projectId: string,
  stageId: string,
  deliveryId: string,
  userInstruction?: string,
): Promise<string> {
  // 从 Cognee 检索上下文
  const { upstream, codeContext, assets, reflections } =
    await recallStageContext(projectId, stageId, deliveryId)

  // 组装结构化 Markdown
  return `# FlowForge 交付上下文

## 项目信息
- 项目：${projectName}
- 当前阶段：${stageLabel}
- 执行模式：外派

## 上游交付物
${upstream.map(d => `### ${d.label}（质量分: ${d.score}）\n${d.summary}`).join('\n\n')}

## 代码智能
${codeContext.summary}

## 当前阶段要求
- 目标：${stageConfig.guidance}
- 产出：${stageConfig.deliverables.join(', ')}
- 质量检查清单：
${stageConfig.qualityChecklist.map(c => `  - ${c}`).join('\n')}

## 团队规则
${assets.filter(a => a.type === 'rule').map(r => `- ${r.content}`).join('\n')}

## 历史改进建议
${reflections.map(r => `- ${r.pattern}（置信度: ${r.confidence}）`).join('\n')}

${userInstruction ? `## 用户补充指令\n${userInstruction}` : ''}

## 输出要求
请将产出保存为 Markdown 格式。完成后将文件放入：
\`{projectDir}/.flowforge/output/${deliveryId}/${stageId}.md\`
`
}
```

---

## 七、双模执行模型

每个阶段支持三种执行模式，用户可随时切换：

### 模式 A：内置执行（Independent）

FlowForge 自己调用 LLM API 完成工作。适用于轻量任务、快速迭代、离线场景。

- 内置 AI 对话（AiChatPanel）
- 一键生成交付物（LangGraph 节点内调 LLM）
- AI 自动评审（LangGraph 评审节点）
- 本地 LLM 支持（Ollama / llama.cpp）

### 模式 B：外派执行（Delegate）

将上下文打包后交给外部智能体。适用于复杂任务、需要特定工具能力的场景。

- 上下文自动打包（含代码智能 + 历史反思建议）
- 一键唤起外部工具
- 自动监听产出并回收
- 产出自动注册到知识图谱

### 模式 C：手动执行（Manual）

用户自行编写，FlowForge 提供模板和检查清单。

- 阶段模板下载
- 质量检查清单展示
- 手动导入（拖拽/粘贴/文件选择）
- 导入后同样触发评审和图谱注册

---

## 八、知识飞轮（自建策略层）

### 8.1 飞轮模型

```
使用 → 产出 → 沉淀(Cognee) → 上下文更丰富 → 质量提升 → 更多使用
  ↑                                                          │
  └──────────── 反思(LangGraph) ← 策略调整 ← 模式提取 ────────┘
```

### 8.2 五层知识沉淀

| 层 | 沉淀什么 | 存储位置 | 反哺方式 |
|---|---|---|---|
| L1 交付物 | PRD/BRD/TS/测试用例 | Cognee 图谱 | 下游阶段上下文注入 |
| L2 评审 | 分数、维度得分、改进建议 | Cognee 图谱（绑定交付物） | 下次生成时注入约束 |
| L3 修改 | 用户编辑 diff | SQLite（original vs final） | 提取修改模式 |
| L4 模式 | 跨项目共性模式 | Cognee KnowledgeAsset | 更新模板和检查清单 |
| L5 代码 | 结构、架构、技术债 | Cognee 图谱（CodeModule） | 需求预警 + 实现推荐 |

### 8.3 自动沉淀机制

**生成即沉淀**：LangGraph 阶段节点完成后，自动调 `cognee.remember()` 注册交付物。

**评审即学习**：评审结果绑定到交付物实体。当某类问题反复出现（frequency > 3），自动调 `cognee.improve()` 更新阶段检查清单。

**修改即训练**：用户编辑后保存 diff 到 SQLite。积累足够样本后提取模式：
```typescript
{
  stage: 'prd',
  pattern: '用户总是在"非功能需求"部分补充性能指标',
  frequency: 8,
  action: 'update_template',
  confidence: 0.87,
}
```

**代码即知识**：git commit 触发增量索引 → `cognee.remember()` 更新代码图谱。

**跨项目继承**：团队级 KnowledgeAsset 在所有项目间共享（同一 Cognee 实例，按 projectId 隔离 + 团队级共享层）。

### 8.4 知识资产自动演化

```typescript
// Cognee 中的 KnowledgeAsset 实体自动演化
{
  type: 'KnowledgeAsset',
  label: 'PRD 模板 v3（自动演化）',
  assetType: 'template',
  stage: 'prd',
  version: 3,
  evolution: [
    { from: 'v1', to: 'v2', reason: '评审反馈：缺少验收标准', date: '2026-07-10' },
    { from: 'v2', to: 'v3', reason: '用户修改模式：总是补充时序图', date: '2026-07-20' },
  ],
  effectiveness: {
    avgScoreBefore: 72,
    avgScoreAfter: 86,
    sampleSize: 15,
  },
}
```

### 8.5 飞轮度量看板

Dashboard 展示：
- 知识图谱规模（实体数、关系数、覆盖阶段）
- 质量趋势（各阶段评审平均分曲线）
- 模板演化记录
- 复用率（新交付物引用历史知识的比例）
- 代码健康度（复杂度趋势、技术债变化）

---

## 九、SDLC 领域定义（自建）

### 9.1 阶段定义

保留现有 9 阶段定义（stages.js），每个阶段包含：
- guidance（目标描述）
- qualityChecklist（质量检查清单）
- template（交付物模板）
- defaultConfig（skills/mcps/rules/model/temperature）
- gate（门禁配置）

### 9.2 DAG 流程配置

```typescript
// sidecar/src/domain/flowConfig.ts
export const DEFAULT_DAG = {
  nodes: [
    { id: 'req', label: '需求分析', next: ['brd'] },
    { id: 'brd', label: 'BRD', next: ['prd'] },
    { id: 'prd', label: 'PRD', next: ['test', 'dev-plan'] },  // 并行分叉
    { id: 'test', label: '测试用例', next: ['review'] },
    { id: 'dev-plan', label: '开发方案', next: ['dev'] },
    { id: 'dev', label: '开发', next: ['review'] },
    { id: 'review', label: 'Code Review', next: ['auto-test'], dependsOn: ['test', 'dev'] },  // 并行汇入
    { id: 'auto-test', label: '自动化测试', next: ['deploy'] },
    { id: 'deploy', label: '交付', next: [] },
  ],
}

// 项目可自定义流程（customFlow）
export function getProjectDAG(project) {
  return project.customFlow || DEFAULT_DAG
}
```

### 9.3 门禁配置

```typescript
gate: {
  aiReview: true,
  humanReview: true,
  threshold: 75,
  requireTraceability: true,   // 必须有上游追溯关系
  maxRetries: 3,               // AI 评审最多重试次数（含反思修正）
  autoAdvance: false,          // 门禁通过后是否自动推进
  notify: ['dingtalk-group'],  // 通知渠道
}
```

### 9.4 本体规则

保留现有 5 条规则 + 新增 3 条：
- `rule-source-tracking`：每个交付物标记产出来源
- `rule-consistency-check`：外派产出必须与上游对齐
- `rule-delegate-timeout`：外派超时提醒

---

## 十、交互设计

### 10.1 阶段操作区

```
┌─────────────────────────────────────────────────┐
│  PRD 阶段                          [当前进行中]   │
├─────────────────────────────────────────────────┤
│                                                 │
│  选择执行方式：                                   │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ 内置AI    │  │ 外派     │  │ 手动     │     │
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
│  [复制上下文] [唤起工具] [监听产出中...]           │
│                                                 │
│  ─── 反思面板（折叠） ───                        │
│  上次执行反思：                                   │
│  "建议注入最新版BRD而非最早版本"                   │
│  "复杂业务PRD推荐外派模式"                        │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 10.2 Command Palette（Cmd+K）

```
> 生成 PRD          → 触发当前阶段内置AI生成
> 外派到 QoderWork  → 打包上下文 + 唤起工具
> 导入交付物        → 打开导入面板
> 评审             → 触发AI评审
> 推进             → 门禁检查 + 推进阶段
> 查看追溯         → 知识图谱可视化
> 反思日志         → 查看历史反思记录
> 代码搜索         → 搜索项目代码
```

### 10.3 系统托盘 + 通知

- 托盘图标显示当前交付进度（如 3/9）
- 外派完成通知："QoderWork 已完成 PRD 生成，点击导入"
- 门禁通过通知："PRD 评审通过（85分），可推进"
- 超时提醒："外派任务已超过 30 分钟未回收"
- 反思建议："基于上次经验，建议使用外派模式完成此阶段"

### 10.4 拖拽交互

- 从 Finder 拖文件到阶段卡片 → 自动导入
- 从知识图谱拖实体到编辑器 → 插入引用

---

## 十一、项目目录结构

```
flowforge-sdlc/
├── src-tauri/                        # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── storage.rs           # SQLite 读写
│   │   │   ├── tool_bridge.rs       # 外部工具唤起/监听
│   │   │   ├── file_ops.rs          # 文件读写/监听（notify crate）
│   │   │   ├── git_ops.rs           # Git 操作
│   │   │   ├── code_index.rs        # tree-sitter 代码索引
│   │   │   ├── sidecar.rs           # Node sidecar 管理 + IPC
│   │   │   └── notify.rs            # 系统通知
│   │   └── db/
│   │       ├── schema.sql
│   │       └── migrations/
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── sidecar/                          # Node.js Sidecar（LangGraph + Cognee + 领域服务）
│   ├── src/
│   │   ├── index.ts                 # 入口：IPC server
│   │   ├── graph/
│   │   │   ├── sdlcGraph.ts         # LangGraph DAG 定义
│   │   │   ├── stageNode.ts         # 阶段节点逻辑
│   │   │   ├── reflection.ts        # 反思循环
│   │   │   └── checkpoint.ts        # SQLite checkpoint
│   │   ├── knowledge/
│   │   │   ├── cognee.ts            # Cognee 初始化/配置
│   │   │   ├── seedOntology.ts      # 本体 seed schema
│   │   │   └── knowledgeService.ts  # 知识操作 API
│   │   ├── domain/
│   │   │   ├── ontology.ts          # 本体定义（从 ontology.js 迁移）
│   │   │   ├── stages.ts            # 阶段定义（从 stages.js 迁移）
│   │   │   ├── flowConfig.ts        # DAG 流程配置
│   │   │   ├── tools.ts             # 工具注册表
│   │   │   ├── contextEngine.ts     # 上下文打包
│   │   │   ├── toolBridge.ts        # 派发/回收逻辑
│   │   │   └── flywheel.ts          # 飞轮策略（模式提取/模板演化）
│   │   └── llm/
│   │       ├── provider.ts          # OpenAI 兼容 API 调用
│   │       └── prompts.ts           # 阶段 System Prompts
│   ├── package.json
│   └── tsconfig.json
│
├── src/                              # React 前端（现有代码）
│   ├── components/
│   │   ├── ToolSelector.jsx         # 工具选择器
│   │   ├── ContextPreview.jsx       # 上下文预览
│   │   ├── DelegatePanel.jsx        # 外派面板
│   │   ├── ReflectionPanel.jsx      # 反思面板
│   │   ├── CommandPalette.jsx       # Cmd+K
│   │   ├── AiChatPanel.jsx          # 已有
│   │   ├── Sidebar.jsx              # 已有
│   │   └── TopBar.jsx               # 已有
│   ├── context/
│   │   ├── AppContext.jsx           # 已有（精简，重状态移到 sidecar）
│   │   └── SidecarContext.jsx       # 新增：sidecar 通信层
│   ├── pages/
│   │   ├── Pipeline.jsx             # 已有（拆分重构）
│   │   ├── Dashboard.jsx            # 已有（增加飞轮度量）
│   │   ├── Projects.jsx             # 已有
│   │   ├── KnowledgeBase.jsx        # 已有（对接 Cognee 查询）
│   │   ├── ModelConfig.jsx          # 已有
│   │   └── Settings.jsx             # 已有
│   └── App.jsx
│
├── .flowforge/                       # 项目运行时数据
│   ├── flowforge.db                 # SQLite（checkpoint + diff + 配置）
│   ├── cognee.db                    # Cognee 知识图谱
│   ├── vectors/                     # LanceDB 向量存储
│   ├── graph/                       # KuzuDB 图存储
│   ├── context/                     # 外派上下文文件
│   └── output/                      # 外部工具产出目录
│
├── package.json
├── vite.config.js
└── tailwind.config.js
```

---

## 十二、典型用户旅程

### 场景 1：PM 使用 QoderWork 完成 PRD

```
1. PM 打开 FlowForge，选择项目"智能客服系统"
2. 进入交付流水线，当前在 PRD 阶段
3. 点击"外派" → 选择 QoderWork
4. FlowForge 自动打包上下文（含代码智能 + 历史反思建议）
5. 上下文复制到剪贴板，QoderWork 被唤起
6. PM 在 QoderWork 中完成 PRD 编写
7. QoderWork 输出 PRD.md 到 outputs 目录
8. FlowForge 文件监听检测到新文件，弹出通知
9. PM 确认导入
10. FlowForge 自动：
    - cognee.remember() 注册到知识图谱
    - LangGraph 触发评审节点
    - 评审通过（82分 > 75分阈值）
    - LangGraph 触发反思节点（记录本次执行经验）
    - 通知："PRD 评审通过，可推进"
11. PM 点击"推进"，LangGraph 状态机推进到并行节点（测试用例 + 开发方案）
```

### 场景 2：开发者使用 Cursor 完成编码

```
1. 开发者进入"开发"阶段
2. 选择"外派" → Cursor
3. FlowForge 将技术方案 + 代码智能写入 .cursorrules
4. 唤起 Cursor，打开项目目录
5. 开发者在 Cursor 中编码，完成后 git commit
6. FlowForge 检测到 git 变更：
    - 增量索引更新（tree-sitter → cognee.remember()）
    - 自动建立 IMPLEMENTS 追溯关系
    - 提示："检测到新代码提交，是否触发 Code Review？"
7. 开发者确认，LangGraph 推进到 review 节点
```

### 场景 3：反思驱动的自动改进

```
1. 第 3 次使用内置 AI 生成 PRD，评审只有 65 分
2. LangGraph 触发反思节点：
   - 分析：注入的 BRD 是旧版本，缺少最新业务约束
   - 根因：context selector 按时间排序取了第一条，未校验版本
   - 行动：修正上下文规则（取最新版本）
3. 反思建议注入下次生成：
   - "确认上游交付物版本一致性"加入检查清单
   - 复杂业务 PRD 推荐外派模式
4. 第 4 次生成 PRD，评审 82 分（改进生效）
5. 飞轮度量看板显示：PRD 阶段平均分从 68 → 82
```

---

## 十三、与现有 delivery-flow Skill 的关系

```
FlowForge（交付编排器 — LangGraph DAG）
  └── 外派到 QoderWork
        └── delivery-flow skill（开发子流程编排）
              ├── it-prd-generator
              ├── it-impl-test-generator
              └── code-reviewer
```

FlowForge 是上层编排，delivery-flow 是执行者之一。两者不冲突。

---

## 十四、实施路线图

### Phase 1：Tauri 骨架 + Sidecar 通信（3天）

- 初始化 Tauri 2.x 项目，加载现有 React 前端
- 搭建 Node.js sidecar 进程 + IPC 通信
- 实现 SQLite 基础存储（tauri-plugin-sql）
- 前端 SidecarContext 通信层
- **验证**：前端 invoke → Rust → Sidecar → 返回结果

### Phase 2：LangGraph 流程引擎（4天）

- 定义 SDLC DAG 图（9 节点 + 并行线）
- 实现阶段节点（内置 LLM 生成 + 评审）
- 集成 checkpoint（SQLite 持久化）
- 实现 human-in-the-loop interrupt（门禁审批）
- 集成 langgraph-reflection（反思循环）
- **验证**：完整走通一个交付流程（含断点恢复 + 反思）

### Phase 3：Cognee 知识层（4天）

- 初始化 Cognee（SQLite + LanceDB + KuzuDB 本地模式）
- 注入 seed ontology（7 概念 + 14 关系）
- 实现 remember/recall/forget/improve API
- 交付物自动注册（生成即沉淀）
- 阶段上下文检索（recallStageContext）
- **验证**：生成 PRD 后自动注册，下次生成时能 recall 到上游知识

### Phase 4：Tool Bridge MVP（4天）

- 实现上下文打包引擎（contextEngine.ts）
- 实现剪贴板派发 + 文件监听回收（Tauri Rust 侧）
- 阶段操作区 UI 改造（三模式选择器）
- 产出自动注册到 Cognee
- **验证**：从 FlowForge 外派到 QoderWork 并回收产出

### Phase 5：代码智能层（5天）

- 集成 tree-sitter（Rust 侧，Java/TS/Go/Python）
- 实现代码索引 → cognee.remember() 注册
- 实现代码搜索（BM25 + 语义）
- 各阶段上下文注入代码智能
- Git commit 触发增量索引
- 索引管理 UI
- **验证**：开发方案阶段自动注入架构摘要，Review 阶段输出变更影响

### Phase 6：飞轮 + 体验打磨（4天）

- 修改模式提取（diff 分析 → 模板演化）
- 飞轮度量看板（Dashboard）
- Command Palette（Cmd+K）
- 系统托盘 + 原生通知
- 拖拽导入
- **验证**：完整的端到端交付流程（含代码智能 + 反思 + 飞轮）

**总计：~24 天（约 5 周，含缓冲）**

---

## 十五、技术选型总结

| 层 | 选型 | 理由 | 自建/引入 |
|---|---|---|---|
| 桌面壳 | Tauri 2.x | 轻量、Rust 性能、原生 API、sidecar 支持 | 引入 |
| 前端 | React 18 + Vite 6 + Tailwind 3 | 现有代码复用 | 保留 |
| Agent Runtime | LangGraph.js (@langchain/langgraph) | DAG 状态机、反思循环、checkpoint、HITL | 引入 |
| 反思 | langgraph-reflection | 现成 critique loop | 引入 |
| Checkpoint | @langchain/langgraph-checkpoint-sqlite | SQLite 持久化、断点恢复 | 引入 |
| 知识图谱 | Cognee (cognee-ts) | 自动图谱构建、本体生成、记忆 API、本地嵌入式 | 引入 |
| 图存储 | KuzuDB（Cognee 内置） | 嵌入式图数据库，零部署 | 引入 |
| 向量存储 | LanceDB（Cognee 内置） | 嵌入式向量库，零部署 | 引入 |
| 代码解析 | tree-sitter（Rust binding） | 多语言 AST、增量解析、高性能 | 引入 |
| 文件监听 | notify crate（Rust） | 跨平台、高性能 | 引入 |
| AI（内置） | OpenAI 兼容 API | 已有实现 | 保留 |
| AI（本地） | Ollama localhost:11434 | 离线/隐私场景 | 保留 |
| SDLC 领域 | 自建（ontology/stages/gates/templates） | 业务差异化 | 自建 |
| Tool Bridge | 自建（contextEngine/toolBridge） | 独创设计 | 自建 |
| 飞轮策略 | 自建（flywheel.ts） | 独创设计 | 自建 |
| 团队同步 | Git 仓库 / 钉钉云盘 | 零后端成本 | 保留 |

---

## 十六、与 v2 设计的差异对照

| 模块 | v2（纯自建） | v3（三件套） |
|------|------------|------------|
| 流程引擎 | 自建 DAG 推进逻辑 | LangGraph 图状态机 |
| 反思机制 | 未设计 | langgraph-reflection |
| 断点恢复 | 未设计 | LangGraph SQLite checkpoint |
| 知识图谱 | 自建 graph.js（localStorage） | Cognee 自动构建 |
| 本体引擎 | 硬编码 ontology.js | Cognee ontology grounding + seed schema |
| 记忆系统 | 未设计 | Cognee remember/recall/forget/improve |
| 代码索引 | 自建（Rust + SQLite） | 自建解析 + Cognee 存储 |
| Tool Bridge | 自建 | 自建（不变） |
| 飞轮 | 自建 | 自建策略 + Cognee 存储 |
| 工期 | ~8-9 周 | ~5 周 |

---

## 十七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Cognee TS client 成熟度 | 可能有 bug 或 API 变动 | 锁定版本 + 封装适配层，必要时降级为 REST 调用 |
| LangGraph.js 功能滞后于 Python | 部分高级特性可能缺失 | 核心功能（图/checkpoint/reflection）已稳定，高级特性可用 Python sidecar 替代 |
| Sidecar 进程管理复杂度 | 崩溃恢复、资源占用 | Tauri 2.x 原生 sidecar 管理 + 健康检查 + 自动重启 |
| Cognee 本体生成与预定义冲突 | 自动扩展可能偏离领域约束 | seed schema 作为硬约束，定期校验本体一致性 |
| 三件套集成胶水代码 | 调试困难 | 统一 IPC 协议 + 结构化日志 + LangSmith 可选追踪 |

---

## 十八、隐私与边界

- 所有数据在本地（SQLite + LanceDB + KuzuDB + 文件系统），不上传任何云端
- LLM 调用走用户自配置的 API（支持本地 Ollama，完全离线）
- 跨项目继承仅限同一台机器上的 FlowForge 实例
- 团队共享通过 Git 仓库显式同步，用户控制共享范围
- 修改模式提取仅统计结构性模式，不记录具体业务内容
- Cognee 租户隔离：项目间数据互不可见（除非显式共享）
