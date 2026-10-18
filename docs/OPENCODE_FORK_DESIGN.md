# 受管 OpenCode /fork 独立设计（P1 增量 5）

日期：2026-10-18；**v2 修订（同日）：按评审意见补齐单会话假设改造清单、幂等唯一约束与结果对账、copyOf 授信链、停止会话完整语义、双方言迁移与父删除规则**。状态：设计稿 v2，待评审；实施顺序=先隔离原型与测试，再接控制主路径。依据：任务书 §P1/§P0、FORK-VERIFICATION.md（原生语义实证）、opencode-control-provenance 架构、P4 事实模型（copyOf 契约）。

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

---

# v2 修订：评审四项缺口的落地设计

## A. 单会话假设改造清单（多会话共实例）

核心原则：**provider_instances 保持"进程"语义（session_id = 发起会话=父，不变）；session_control_bindings 升级为"每 AgentPulse 会话的寻址与授权权威"**。守卫不删除，改为按绑定解析：

| # | 现有单会话假设（代码位） | 改造 |
|---|---|---|
| A1 | `provider_instances.session_id` UNIQUE + `ownedOpenCodeInstance` 以 instance.sessionId 为会话 | 新增 `bindingForSession(sessionId)`：校验 binding.origin=agentpulse_launch、binding.instanceId、binding.generation==instance.generation、instance.state∈{reserved,running}；所有"以会话找实例"的路径改走绑定（父会话走既有绑定，等价兼容） |
| A2 | `validateOpenCodeReport`（observer/回报自举）要求 instance.sessionId===input.sessionId | 受管实例的子会话**不走 report 自举**（无 launch）；回报仍按父会话校验不变 |
| A3 | `acceptOpenCodeSnapshot` 归属 instance.sessionId | 改为按 snapshot.nativeSessionId 匹配该实例下的 binding（父或子），事件/目录写入对应 AgentPulse 会话；无匹配绑定且非父 → 拒绝（不静默建外部行） |
| A4 | legacy observer 会把子原生会话当外部会话摄取（opencode: 命名空间、永久只观察） | 摄取前置检查：native session id 已被任何 `uq_control_binding_native` 占用 → 跳过（受管域，不是外部会话）；已有重复行做一次性清洗迁移 |
| A5 | `managed_sessions.launch_request_id NOT NULL` | 迁移放宽为 NULL（drizzle 0015 双方言 + legacy ALTER）；子会话行 launch_request_id=NULL、correlation_source='opencode_fork'；控制锁/activeAction 语义按会话行各自独立 |
| A6 | Supervisor `provider.control(action)` 按 action.sessionId→instance.sessionId 的原生会话寻址 | provider 侧改为 binding 寻址：action 携带 nativeSessionId（服务端入队时按绑定解析并写入 action metadata）；provider 校验 (instanceId, nativeSessionId) 属于本 supervisor 的实例后才执行 |
| A7 | 恢复路径（Supervisor 重启/控制断开重连）按"实例→会话"一对一恢复 | 恢复枚举实例下**全部有效绑定**会话；generation 失效对同实例所有绑定同时成立（assert 时校验 binding.generation==instance.generation） |
| A8 | 空闲回收按实例/会话一对一判定 | 回收候选条件改为：实例下**所有**绑定会话均无 pending 交互、无 queued/running 动作、非 working；任一不满足即不回收 |

父子来源验证保持：外部/legacy/BotMux origin 不变；子会话绑定的创建仅由 fork 动作成功回报触发（见 B），不接受任何"自称子会话"的回报。

## B. 幂等与结果对账（可崩溃）

- **持久唯一约束**：`CREATE UNIQUE INDEX uq_fork_action_idem ON control_actions(requested_by_user_id, idempotency_key) WHERE action_type='opencode_fork' AND idempotency_key IS NOT NULL`（双方言 partial unique；SQLite 支持，PG 支持；legacy 路径补同款语句）。作用域=Actor（requested_by_user_id，solo 下 NULL 视为同一 owner，用 COALESCE 键或 owner 列冗余）。
- **请求体冲突**：action metadata 存 `requestHash`（messageId+parentSessionId 规范化哈希）；同键不同 hash → 409 `fork_key_conflict`。
- **结果台账**：fork 成功回报落地 `opencode_forks` 行（含 action_id）即为持久结果；动作状态以台账为准对账。
- **崩溃窗口对账**（原生 fork 已发生、回报丢失）：服务端在受理时生成 `forkTitle = agentpulse-fork:<actionId>` 并作为原生 fork 的 title 传入；对账时 Supervisor 按该 title 扫描实例的原生会话列表，命中者按 A3/C 流程采纳为该 action 的结果（并核验父前缀，见 C）；未命中 → 保持 unknown，**不自动重发**（沿用原则）。
- 锁串行仅去抖并发，不承担崩溃后去重——去重由唯一约束+台账+title 对账承担。

## C. copyOf 授信链（不靠事后同文猜测）

1. **受理时钉住父态**：服务端把父会话当前消息清单（原生 msg id、part 结构哈希、各事件 createdAt）与分叉点快照进 `opencode_fork_requests.parent_snapshot`（JSON，随请求持久化）。
2. **子初始快照关联**：fork 回报的子会话**首个**快照到达时，将其消息序列与 parent_snapshot 前缀逐位核验（按实证语义：省略 messageID=全量；指定 messageID=排除该消息及其后）。逐条建立映射：message→message、part→part（工具事件按 messageIndex+partIndex+toolName+内容哈希三元组对齐）。
3. **歧义即停**：任一位置哈希不等、part 数不齐、顺序断裂 → **停止推断**（映射截止于断点前），不跨缺口继续；无映射的子事件按普通新事件处理（不写 copyOf）。
4. **继承时间**：被映射的拷贝事件入库 `createdAt` 取 parent_snapshot 中对应父事件的原始发生时间（不落 fork 当日）；`copyOf=父事件id` 由父原生 msg id→events 解析。
5. 映射一次性构建后持久化（fork_requests.child_map），后续子快照增量不再推断（新消息都是真新消息）。

## D. 停止会话完整语义（不止 abort+归档）

`停止会话`（仅作用于目标绑定会话，其他分支不受影响）：
1. 取消该会话全部 queued/running control actions（标记 cancelled，Supervisor 领取侧跳过）；
2. 其绑定下 pending provider_interactions 全部置 cancelled（失效，不可再答复）；
3. managedSession 置 stopped、绑定保留（generation 不变）；`assertSessionControlOrigin` 增加绑定会话状态检查——stopped 绑定拒绝新动作（prompt/fork/command 一律 409 session_stopped）；
4. **恢复=显式操作**：UI「恢复此分支」→ managedSession 回 managed（绑定/代数不变，历史保留）；恢复后新动作可入队；
5. 实例级停止：generation+1 并显式失效该实例**全部**绑定（含父子），UI 列出受影响会话清单并二次确认；空闲回收见 A8。

## E. 迁移与双方言

- drizzle **0015**（sqlite + postgres 同内容）：`opencode_forks`、`opencode_fork_requests`、`uq_fork_action_idem` partial unique、`managed_sessions.launch_request_id` 放宽（PG 侧 DROP NOT NULL + ADD COLUMN 兼容；SQLite 重建表或新列可空+应用层保证）、父删除规则（见 F）所需列。
- 旧库 legacy init 路径追加等价语句（CREATE TABLE IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS + ALTER）。
- 一次性清洗：A4 的受管子会话若已被 observer 摄取为外部行，迁移时删除重复外部行（保留绑定权威行）。

## F. 父删除后的子分支规则

- `opencode_forks.parent_session_id` 改 `ON DELETE SET NULL`（可空），并在创建时**冗余不可变标签**（父 displayName、父原生会话 id、分叉点 msg id）——父被删除后谱系仍可追溯展示。
- 子会话授权不依赖父会话行：绑定指向 instance（进程）而非父 session → 父删除不影响子会话控制/审批/停止。
- 父删除时**不**级联停止子分支（显式独立操作）；子分支快照/事件自持。

## G. 实施顺序（隔离原型先行）

1. 原型 + 单测（不接控制主路径）：绑定寻址助手（A1/A3 纯函数）、fork 幂等/冲突/对账状态机（B）、前缀映射器（C，含断点即停与时间继承用例）、停止语义（D 的取消/失效/拒新）。
2. 评审通过后接主路径：0015 迁移 + 端点 + provider binding 寻址（A6）+ observer 跳过（A4）。
3. 浏览器终局验收（并入 4+6）：fork 继承上下文（暗号法）、停止子不影响父、审批各归各卡、copyOf 去重生效、真实组件 A/B 迟到响应场景。

---

# v2.1 实测修订（2026-10-18，真实协议/数据库证据）

## 1. forkTitle 对账前提被实测否定 → 改为 unknown + 用户采纳

隔离实例（1.18.35）四项实测：
- `POST /session/{id}/fork` 携带 `{"title": ...}` → 200 但 **title 被静默忽略**（响应 title 为原生自动命名 "…(fork #1)"，非调用方值）——OpenAPI `additionalProperties:false` 服务端未强执，但该字段不生效；
- 改名只能走**另行** `PATCH /session/{id} {title}`（实测 200 生效）→ **fork 与改名之间存在真实崩溃窗口**；
- title **可变**且**可多匹配**（把父改名成同一标记后列表命中 2 条）→ title 不构成唯一证据。

结论（按评审措辞收紧）：崩溃窗口（原生 fork 成功、回报丢失）**当前未验证可靠的自动对账手段**（title 实测否定是其一；内容前缀+时间窗在并发 fork 下不唯一）。策略：
- 该 action 保持 `unknown`，永不自动重发；
- UI 提供**用户中介采纳**——用户确认只解决"候选选择"，**不替代任何来源校验**。候选必须同时满足：
  1. 位于**该受管实例内**（instanceId 匹配本 action 目标实例）；
  2. 与本次 unknown action 关联（时间窗内创建、directory 与父一致）；
  3. **未被绑定**且未被任何其他驱动占用（`uq_control_binding_native` 无记录、无活跃外部 observer 归属）；
  4. 消息前缀与**实际执行前快照**（见 §3，非受理时镜像）匹配。
  采纳时再次校验 Actor、owner、supervisor/host、generation、原生身份与实际执行快照；全部通过才写 `opencode_forks` 台账并建绑定；采纳前候选保持只观察。

## 2. 父删除 FK 链实测（真实 SQLite + 真实 schema）

按设计插入父/子会话、共享 provider_instance、双方绑定、双方 managed 行、launch 后删除父会话，实测结果（SQLite 与 PostgreSQL 双方言，fk-chain-probe.ts 断言化可复跑）：
- 子会话行、**子绑定、provider_instances 行全部存活**（本 schema 的 instance→session 外键不级联删除实例）；
- 仅父自身的 managed_sessions 行随父级联消失（属预期）；
- launch 行存活。

结论（按评审撤回过强表述）：**仅观察到双方言下行存续**。**"子分支保持可控"未被证明**：
- 探针实测 `inspectOpenCodeProvenance` 对子绑定判定 `bindingValid=false`——现行单会话守卫（`instance.sessionId === sessionId`、`launch.launchCorrelationId === sessionId`）从**绑定创建起**就拒绝共享实例的子会话（与父删除无关）；
- 这正是设计 A1"绑定为权威"改造为**必需项**的直接证据；控制/审批/恢复链的父删除后行为属原型验证范围；
- 探针以父 launch 代替未来 NULL launch（0015 未落地），此差异已显式断言不隐藏；改造落地后"现行守卫拒绝"断言翻转为 valid。

## 3. copyOf 父快照核验窗口（按评审收窄）

受理时的中央镜像**不作为原生事实**：映射核验发生在**执行受控窗口**——Supervisor 在实际调用原生 fork 前一刻从实例拉取父消息清单（msg id + part 哈希 + 事件时间），与受理请求一并随 fork 动作存档；子首快照核验以此为准。中央镜像仅用于 UI 预览（分叉点选择）。

## 4. observer 跳过作用域（按评审收窄）

跳过条件 = **(来源实例所属 supervisor/host, native session id) 组合**命中受管绑定（`uq_control_binding_native` 按 instance 归属主机），不按裸 native id 跨来源跳过。既有外部重复行**不在迁移中删除**：先证明同源（同 host、同 native id、时间窗）且内容重复才合并，独有笔记/关联保留；无把握隔离保留并打标，交用户处置。
