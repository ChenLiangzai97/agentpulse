# P5 — BotMux 能力矩阵与分期迁移设计（设计交付，未启用）

状态：**设计待评审**。本轮不重写 BotMux，不修改外部/BotMux/legacy 只观察守卫。
来源约束：`docs/IMPLEMENTATION_TASKBOOK_2026-10-18.md` P3/P5 段与 AGENTS.md 的
“外部/BotMux/legacy 永久只观察”规则。

## 1. 能力矩阵（现状 → 可迁移面）

| 能力 | AgentPulse 现状 | BotMux 依赖面 | 迁移可行性 | 依赖 |
| --- | --- | --- | --- | --- |
| 会话身份 | `sessions` + `session_control_bindings`（instance/native/generation） | bot 会话与消息路由 | 高：新绑定 + 旧/新身份映射 | P2 实例身份核验 |
| 控制写入 | 受管 OpenCode：permit/结果 CAS/停止代数 | BotMux 控制器 | 仅在新控制方独占后 | P3 交接证据 |
| 历史对话 | events 事实/工作日志 | BotMux 存储 | 只读预检 + 显式导入 | 原生导出/导入实测 |
| 模型来源 | 配置/目录/插件清单（只读发现） | BotMux provider 配置 | 逐项选择，不复制密钥 | 配置兼容性矩阵 |
| 进程生命周期 | OpenCode 运行时（隔离目录/回环认证/资源限制） | BotMux 常驻进程 | P2 运行服务原型之后再谈 | P2 |
| 审批/交互 | provider_interactions（pending→resolved/expired） | BotMux 审批 UI | 迁移后重新建立，不搬 pending | 原生不支持项标失效 |
| 日报/回顾 | P4 worklog（事实模型 + 双视图） | 无 | 独立实施 | — |

矩阵结论：可复用面集中在**身份/绑定、控制门控、事实记录**；BotMux 特有的消息路由、
审批 UI 与常驻进程**不直接搬运**。任何“复制历史 prompt 冒充恢复”的做法禁止。


## 1a. BotMux 日常能力盘点（`botmux v3.34.0`，2026-10-21）
> 证据口径：`botmux --help` / `botmux send --help` 的**实际输出快照**见
> `scripts/opencode-p0/botmux-help-snapshot.txt`；未在该快照中声明的行为标“未知”，
> 不以推测补全。help 描述 **不等于运行实测**；运行行为需按验收用例实测。

| 能力 | BotMux 实际行为（证据） | AgentPulse 覆盖 | 缺口 | 优先级 | 复用/重写 | 验收用例 |
| --- | --- | --- | --- | --- | --- | --- |
| 身份/路由 | `actor current --json`：仅本 turn、脱离进程树拒绝、只给企业**用户名**（不暴露 open_id/邮箱）；`list`/`observe` 输出 session/worker JSON；`bots list` 给 open_id | sessions + bindings（instance/native/generation）、Actor | 用户名可重名/可改名，**不能直接映射为授权 userId**；BotMux 的已验证 turn 身份未接入 AgentPulse Actor 链 | P1 | 复用 Actor 概念；授权主体只接受受信稳定标识（如 open_id/union_id 的服务端解析）或保持**未知**，显示名仅用于展示 | 伪造 turn/跨进程 actor 被拒；同名不同主体不共享授权 |
| 会话桥接 | `list`、`observe`（失败保持 unknown，不回退缓存）、`delete`/`delete stopped`、`resume`、`suspend`（杀 CLI 保会话，下条消息冷启动）、`term-link` | 受管会话/停止代数/恢复（开放） | 冷启动续上下文与 AgentPulse 停止/恢复语义未对齐；suspend 属“停止运行实例” | P1 | 复用 resume 语义，映射 suspend/resume 到停止/恢复状态机 | 关闭浏览器/刷新/中央重启后同一 native 身份；suspend→消息→新进程且不重发 |
| 附件与交付回执 | `send --images/--files/--videos/--video-covers/--card-file/--card-json`；`--response-kind progress|final|auxiliary`；`turn-send-ledger inspect|resolve --outcome delivered|not-delivered`；`history` 带 resources、`quoted` 下载附件 | events/attachments（web 侧）、无 IM 回执 | 无“发出去但回执未知”的本地账本；附件权限模型缺失 | P1 | 复用 BotMux 账本语义，落 AgentPulse 交付状态（unknown→人工 resolve） | 模拟响应丢失：状态保持 unknown，不重发；resolve 后仅补一次 |
| 审批问答 | `ask buttons [--multi]`；`auth request`/`auth wait`（本轮发起人授权，5 分钟）；`--attention`（authz/decision/blocked） | provider_interactions（pending→resolved/expired） | 审批身份未与 turn Actor 绑定；按钮 key 与 AgentPulse 审批 id 未映射 | P1 | 重写审批 UI 适配层，审批结果写回 provider_interactions | 旧 Actor/过期审批/重复点击拒绝；审批人身份可验证 |
| 定时任务 | `schedule add <schedule> <prompt>`（--calendar/--day-type/--model/--reasoning-effort/--new-topic/--silent）；`update/remove/pause/resume/run` | 无调度器 | 无任务幂等键/去重、无“已投递但结果未知” | P2 | 重写调度器，任务键=(bot,chat,schedule,promptHash) | 同一 tick 重复触发只执行一次；重启后不重复补跑 |
| 交接协作 | `continuation start`（实验性，TTL/次数）、`role switch`（限 ~/botmux-roles）、`tabs`、`card stream` | 无 | 交接/续跑协议未定义 | P2 | 以 P3 交接状态机对接，不直接复用实验特性 | 续跑不重发已完成轮；角色切换目录受限 |
| 插件 | `plugin install`（不执行代码/不启动 service）、`enable/disable`、`plugin service`、`--plugin-card-action` 白名单 | 无 | 插件与 AgentPulse 工具/权限模型未映射 | P3 | 只读清单 + 逐项选择，不自动复制密钥 | 未启用插件不能触发 action；安装不执行代码 |
| 运维恢复 | `autostart`（systemd/launchd/Task）、`worker-budget`、`mojo-containment list|revoke`、`turn-send-ledger`、`sandbox-network-policy`、`dashboard rotate` | 受管实例资源限制/停止 | 进程存活与身份核验未共用证据源（P2） | P2 | 复用 P2 运行服务的身份四元组 | 关闭/重启 supervisor 后同一进程身份可验证；PID 复用拒绝 |

未知项（help 未声明，需源码/实测）：`schedule` 的并发与去重语义；`ask buttons` 的
回调签名校验；`history/quoted` 的附件权限边界；`continuation` 的失败回滚；插件
service 与 AgentPulse 运行服务的端口/资源冲突。

## 1b. 网页 / 飞书共用控制服务协议（设计）
- **Actor**：唯一来源是“已验证 turn 身份”（BotMux `actor current`）或 web 登录会话；
  两者都映射为 AgentPulse Actor（userId/label/scope），禁止由请求体自报身份。
- **Binding**：控制动作必须携带 `(sessionId, instanceId, generation, nativeSessionId)`；
  服务端与受管绑定逐项比对；不匹配拒绝（复用现有四条 fence）。
- **动作去重**：`(actor, idempotencyKey)` + 规范化请求哈希；同体重放、异体 409；
  跨端（web/飞书）同键共享同一记录，不按入口分表。
- **审批身份**：审批动作绑定“发起 turn 的 Actor”，非当前任何操作者；旧 Actor/
  过期审批/重复点击一律拒绝；审批结果只写 provider_interactions 一次。
- **附件权限**：附件读取按会话 owner + 显式 include 规则；BotMux 附件 key 与
  AgentPulse 附件记录建立受保护映射，不暴露本机路径或 token。
- **交付未知**：发送结果三态（delivered/not-delivered/unknown），unknown 不自动
  重发；`resolve=delivered` 后**不得补发**，只有确认 `not-delivered` 才允许受
  幂等键约束的重试（`turn-send-ledger resolve --outcome ...` 的语义）。

## 1c. 灰度、兼容与回滚
- **单测试会话灰度**：只对 `AGENTPULSE_P5_CANARY_SESSION` 指定的一个会话启用新
  链路；其他会话保持旧路径；灰度开关默认关闭。
- **回滚**：灰度会话回滚 = 停用新链路、保留只读迁移记录；未释放旧侧时禁止双写；
  失败进入 quarantined。
- **配置兼容**：BotMux 配置逐项映射（模型/插件/环境），未知项保持只读并在预检
  报告中列缺；密钥/令牌不迁移。
- **定时任务去重**：任务键 + tick 幂等表；重启后按游标补跑，不重复已 delivered 的 tick。
- **成本/风险分级**：P0 只读预检（低风险）；影子比较（低）；终端交接（中，需
  独占证据）；BotMux 交接（高，需释放 API 与 P2）；生产迁移（最高，另行评审）。

## 2. 分期迁移（只在评审通过后逐期启用）

### Phase 0 — 只读发现与预检（可提前，无控制权变化）
- 只读列出：来源（终端/BotMux）、主机、native ID、目录、版本/配置/插件、驱动状态。
- 预检输出：兼容性、缺失能力、需要人工确认的项；默认只读。
- 产物：发现卡片 + `preflight` 记录（不写会话、不建绑定）。
- 退出条件：发现结果可复现；不触碰旧守卫。

### Phase 1 — 影子比较（仍只读）
- 同一来源的只读事件与 AgentPulse 事实模型并行生成，比较字段/时间/去重结果。
- 不建立可写绑定；差异作为迁移阻塞项。
- 退出条件：影子差异清单清零或明确接受。

### Phase 2 — 终端显式交接（先普通终端）
- 状态机：`discovered → preflight → source_released → importing → verified → active`，
  失败进入 `failed`/`quarantined`。
- `source_released` 需要**可验证证据**：原驱动已停止写入（进程/句柄/写入游标），
  不是“看起来空闲”。
- `importing`：原生导出/导入或服务接续，保留目录/对话/模型来源/父子关系；
  新侧仅在新绑定建立后获得写权限；重复接入幂等。
- `verified`：上下文抽样比对 + 只读校验；`active` 后仅新控制方可写；旧 Actor/
  generation/伪造 metadata/仍活跃旧驱动一律拒绝。
- 回滚：仅在新侧已释放后允许恢复旧侧；不能证明独占则隔离，禁止双写。

### Phase 3 — BotMux 交接（条件启用）
- 前置：P2 运行服务原型通过（重启不杀 Agent、认证重连、实例身份核验）。
- 必须使用 BotMux 的**显式交接/释放机制**或由用户操作释放，并取得可验证证据。
- 不能证明独占时停在 Phase 0/1；不修改旧写入守卫。
- 配置/插件逐项选择；不自动复制密钥、不继续加载 BotMux 控制插件。

## 3. 安全不变量（每期都必须成立）
1. 单一写者：迁移期间源端不得继续驱动；无法证明则只读预检。
2. 身份可验证：实例身份由（instance id, generation, native id, 进程启动时刻）共同
   证明，不能只看 PID。
3. 映射不可变：旧/新身份映射与迁移记录保留；旧观察记录不改写为可写。
4. 失败隔离：任何一步失败进入 `failed`/`quarantined`，不隐式提权、不双写。
5. 秘密不迁移：密钥/令牌由用户重新配置，迁移只搬配置结构。

## 4. 验收证据要求
- Phase 0：发现清单 + 预检记录（可复跑）。
- Phase 1：影子差异报告。
- Phase 2/3：交接前后状态机记录、独占证据、上下文抽样、幂等重放、失败隔离样本。
- 每个真实样本至少一个；终端与 BotMux 分开列出。

## 5. 可执行后续清单
1. P2 运行服务原型：重启 supervisor 不杀 Agent；认证重连；身份四元组核验（阻断 PID 复用）。
2. P3 只读预检：`botmux list/observe/history/actor` 只读清单 + 兼容性报告（不改守卫）。
3. P1 浏览器 4+6 终局与停止/恢复端到端证据。
4. 本设计的评审：确认未知项清单与灰度开关命名。
5. 仅在评审通过后：单会话灰度 → 影子比较 → 终端交接 → BotMux 交接。

## 6. 风险与开放问题
- BotMux 是否提供可验证的释放/交接 API（未实测）。
- 原生导出/导入的完整性（P0 仅证明 `/export` 无 API）。
- 运行服务与 BotMux 常驻进程的共存/端口冲突（依赖 P2）。
- 旧 Actor/generation 的拒绝需要与 P2 的实例身份核验共用同一证据源。
