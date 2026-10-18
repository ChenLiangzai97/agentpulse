# 受管 OpenCode /fork 独立设计（P1 增量 5）

日期：2026-10-18。状态：**设计稿，待 codex 评审后实施**。依据：任务书 §P1/§P0、FORK-VERIFICATION.md（原生语义实证）、opencode-control-provenance 架构、P4 事实模型（copyOf 契约）。

## 0. 已实证的原生事实（设计前提）

- `POST /session/{id}/fork {messageID?}` 是服务端真历史分叉：拷贝指定消息**之前**的全部消息（排除指定消息本身及其后），分支为全新 messageID、同 directory、parentID 为空；父会话不变。
- 分支与父会话同属**同一原生进程/实例**（同 provider instance、同 generation）。
- 每会话独立寻址：`/session/{childId}/abort` 只中止子会话当前轮，不影响父会话；进程级停止才影响全部。

## 1. 身份与绑定

- 子会话 = 新 AgentPulse `sessionId`（新 uuid，displayName「父名 · 分支」），**不**走 launch 流程。
- 受保护绑定：`session_control_bindings` 新行，`origin=agentpulse_launch`（沿用现有枚举，避免 SQLite CHECK 约束重建），`instance_id` = 父实例，`native_session_id` = 子原生会话 id，`generation` = 父实例当前代数。`uq_control_binding_native(instance_id, native_session_id)` 天然防重复绑定。
- 分叉谱系独立成表（可查询、不碰枚举）：

```sql
CREATE TABLE opencode_forks (
  child_session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  parent_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  fork_point_message_id TEXT,          -- 原生 msg_*；NULL = 全量拷贝
  request_action_id TEXT,              -- 触发它的 control action（幂等锚点）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_opencode_forks_parent ON opencode_forks(parent_session_id);
```

- 会话 metadata 仅存展示性 `forkOf`（父、分叉点、共享目录提示）；授权一律以绑定+谱系表为准，metadata 不授予权限（延续既有铁律）。

## 2. 控制流与幂等

1. `POST /sessions/:id/opencode/fork {messageId?, idempotencyKey}`（受管来源校验 + Actor 所有权，同既有 opencode 端点）。
2. 服务端创建 `control_action kind="opencode_fork"`，`idempotency_key=(actor, key)` 唯一（沿用 control_actions 既有幂等列）；重复/并发同键返回首个 action。
3. 动作进入实例既有控制队列（控制锁串行）——并发 fork 不会竞态。
4. Supervisor 执行原生 fork → 回报 `{nativeSessionId}` → 服务端建子会话+绑定+谱系行 → 快照通道自然开始上报子会话消息/审批。
5. 失败语义沿用 control action 状态机（queued/claimed/running/succeeded/failed）；原生进程重启窗口内的 fork 结果未知 → `unknown`，不自动重发（同既有对账原则）。

## 3. 停止语义（三档，UI 必须区分）

| 操作 | 原生映射 | 影响范围 |
|---|---|---|
| 中止本轮 | `/session/{id}/abort`（父或子各自） | 仅该会话当前轮 |
| 停止会话 | abort + 平台侧标记结束/归档（历史保留） | 仅该会话 |
| 停止运行实例 | 实例 stop（进程级，generation+1） | **该实例全部会话（含所有分支）**，UI 须列出受影响会话并要求确认 |

子分支停止/中止不影响父分支：由每会话独立寻址保证；实例级停止例外且显式化。

## 4. 审批/交互隔离

- `provider_interactions` 归属以**原生会话 id**路由：交互到达时按 payload 所属 native session 匹配到对应 AgentPulse 会话的绑定，父/子卡片互不串扰。
- 子会话审批仅对子绑定+当前 generation 有效（既有一次性消费/过期/代数失效规则不变）。

## 5. 事件复制映射（P4 copyOf 的受信写入路径）

1. fork 成功后，Supervisor 立即 `GET /session/{child}/message` 枚举拷贝消息。
2. 服务端与父会话消息按 **（顺序前缀 + 内容哈希）** 对齐生成 `child_native_msg_id → parent_native_msg_id` 映射；任一条不匹配即放弃该条映射（保守，宁缺勿错）。
3. 映射持久化（opencode_forks 附表或事件摄取时解析）；子会话事件入库时在事件 metadata 写入 `copyOf: <父事件id>`（经父 native msg id 解析到既有 events 行）。
4. worklog 事实抽取读取事件 `copyOf` → 事实 `copyOf = 父 sessionId:eventId`——P4 的真实 fork 去重自此启用（dedupeFacts 事件级语义已就位并有测试）。
5. 统计：拷贝事件不产生新 token/费用（原生已证拷贝行不调用模型）；成本归父会话发生时点。

## 6. UI

- `/fork` 命令 → 对话框：父会话名、分叉点选择（消息列表，默认全量）、共享目录警示（同目录文件不隔离）、实例级停止影响提示 → 确认后新页签打开子会话。
- 页签徽标：子会话标记「分支」；待交互徽标本批次一并实现（增量 3 遗留）。

## 7. 边界与显式排除

- 仅受管 origin 可发起 fork；外部/BotMux/legacy 会话的 fork 请求 403（永久只观察不变）。
- 跨机 fork 不做（原生 fork 是进程内操作；跨机属 P3 历史接续范畴）。
- fork 点为 assistant 消息时的排除语义（排除指定消息及其后）在对话框中明示，避免用户误以为"包含该消息"。

## 8. 验收清单（实现后逐项）

1. 单元：绑定/谱系创建、幂等（同键重放/并发）、映射对齐器（含不匹配放弃）、事件 copyOf 写入。
2. 探针：能力探针补"子会话 abort 不影响父"实证。
3. 浏览器（并入 4+6 终局验收）：真实 fork → 子会话回答继承上下文（暗号法）；停止子分支父继续输出；父/子审批各归各卡；copyOf 生效后 worklog 同日不重复计数。
4. 安全：伪造 metadata/旧 generation/外部 origin 的 fork 一律拒绝。
