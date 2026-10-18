# 多主机会话控制与每日工作日志

AgentPulse 原有能力包括：实时查看 Claude Code、Codex CLI 和 Copilot CLI 会话；按主机、项目和用户筛选；查看对话与工具事件；启动托管任务；会话笔记、模板、搜索、AI Inbox、摘要与 MCP 控制接口。本次补充会话接管和个人工作日志链路。

## 会话管理

每台主机按项目原有安装方式运行一个 Supervisor，并将它注册到同一个 AgentPulse 服务。主机的 Agent CLI 和原始会话文件保留在该主机上；网页只通过已认证的 Supervisor 下发控制操作。

在会话详情中：

1. 选择该会话实际所在的主机，点击“绑定并恢复”。没有上报主机名的会话可以从所有已注册主机中选择。绑定要求目标主机在线；在团队模式下要求会话与目标主机的所有者或管理员权限。
2. 原终端正在执行时，先停止当前任务，再接管，避免两个独立控制端同时修改工作区。
3. 在底部输入消息。Codex 使用同一个 native thread，Claude headless 使用 `--resume` 继续同一会话。
4. 连接断开后可以点击“恢复原会话”。托管 Codex 在 Supervisor 重启或 app-server 控制连接断开后，会从本机保存的绑定自动恢复；恢复不会重发上一个任务。

工作目录必须位于该主机 Supervisor 的 `trustedRoots` 下。Codex 恢复前会读取本机 native thread，校验其目录与目标目录一致。绑定指向固定主机，不会将上下文文件复制到另一台机器。

### 审批

Codex 原生的命令执行与文件修改审批会出现在会话详情卡片中，包括原始请求参数。用户可以批准本次、拒绝、取消。请求仅对发起它的活跃控制连接有效，十分钟后取消；已消费或连接丢失的请求无法再次执行。提交后可在控制记录中查看主机执行结果。

未支持的原生请求类型返回协议错误，不会自动批准。Claude 目前沿用现有 CLI 权限与终端机制；其审批尚未接入网页卡片。Copilot CLI 继续仅支持观察，不能接管或发送消息。

### 离线行为

服务端暂时不可达时 Supervisor 保留运行中的 Agent。待发送的会话消息保存到本机 `.agentpulse/managed-outbox`，采用仅所有者可读写的文件；连接恢复后补传。每条补传消息有稳定 delivery ID，服务端用数据库唯一约束去重，并按实际发生时间入库，避免补传被计入错误日期。

本机 `.agentpulse/codex-recovery.json` 保存用于重新连接的会话 ID、目录与启动描述，不保存任务正文和环境变量。`AGENTPULSE_STATE_DIR` 可以指定此恢复文件所在目录。服务器与本机数据目录都应持久化。主机离线期间的控制指令保存在服务端队列，恢复在线后领取；执行结果未知的指令不会自动重新执行。

## 每日工作日志

侧边栏“工作日志”页面可配置：

- 是否自动运行、时区和每日时间；默认 `Asia/Shanghai`、次日 `00:05`，总结前一个完整自然日。
- 使用 Settings → AI 中已有的模型服务，填写模型名称。
- 在线文档 HTTP 接口和文档 ID。

每个会话详情页的“纳入每日工作日志”独立控制汇总范围，默认纳入。范围按当日真正发生的用户消息和 Agent 回复确定，不依据会话当前是否 active；完成、归档但当日有对话的会话也会纳入。跨天会话只读取指定日期的消息。

长对话分页读取、分块总结；内容进入模型前使用项目现有密钥脱敏规则。模型只整理已有事实，要求区分已完成与计划。调用遵循 AI 启用开关、暂停开关与已有每日费用预算，单次日志最多调用模型 100 次，超过则失败并提示缩小范围。

日志先持久化为草稿，再请求文档接口。界面支持手动生成预览、生成并写入、重试、删除未交付草稿。文档写入失败时复用已有总结，不重新调用模型；已交付日期直接返回原结果。如果生成草稿后排除了其中某个会话，旧草稿禁止导出，需删除草稿后重建。

调度器随 AgentPulse 服务启动，每分钟检查一次；停机后补最近七个完整自然日，自启用日期起计算。更早的缺失日期可手动补生成。多副本通过数据库租约避免并发运行同一日期；租约过期后允许恢复。在团队模式下，实例级日志的读取、配置与导出仅对管理员开放。

## 在线文档接口约定

实际在线文档接口尚未提供。本实现可直接调用符合以下约定的 HTTP 适配接口；如果现有接口字段不同，在该适配接口中转换即可。

服务端环境变量：

```bash
AGENTPULSE_WORKLOG_DOCUMENT_TOKEN=<document-api-token>
```

请求：`POST <documentUrl>`，`Content-Type: application/json`。配置 token 后附加 `Authorization: Bearer <token>`。token 不通过浏览器读取或保存，也不应写入接口 URL。

```json
{
  "version": 1,
  "operation": "upsert",
  "idempotencyKey": "agentpulse-worklog:Asia/Shanghai:2026-10-15:document-id",
  "documentId": "document-id",
  "date": "2026-10-15",
  "timezone": "Asia/Shanghai",
  "title": "工作日志 · 2026-10-15",
  "markdown": "# 工作日志 …",
  "sessionIds": ["session-id"]
}
```

同一个去重键同时放在 `Idempotency-Key` 请求头中。接口必须以该键实现创建或更新同一段内容；收到重复请求时不得追加重复段落。只有在文档写入成功后才返回 2xx。非 2xx、超时和重定向均视为失败。若接口已完成写入但响应丢失，下一次会发送同一个键，依靠接收端去重恢复。

首次接入可先手动“生成预览”，核对后“生成并写入”。这两个动作由用户在页面触发，自动模式需显式开启。

## API

| 方法 | 路径（前缀 `/api/v1`） | 用途 |
|---|---|---|
| POST | `/sessions/:id/bind` | `{ "supervisorId": "…" }` 绑定原会话 |
| POST | `/sessions/:id/resume` | 恢复原会话，返回控制 action |
| POST | `/sessions/:id/prompt` | 现有消息入口，新增 Codex 路由 |
| GET | `/sessions/:id/native-approvals` | 当前审批卡片 |
| POST | `/sessions/:id/native-approvals/:approvalId` | `{ "decision": "accept/decline/cancel" }` |
| GET / PUT | `/sessions/:id/worklog` | 获取 / 设置 `{ "included": true }` |
| GET / PUT | `/worklog/config` | 配置调度、模型与文档接口 |
| GET | `/worklog/runs` | 最近 60 份日志及状态 |
| POST | `/worklog/runs` | `{ "date": "YYYY-MM-DD", "deliver": false }` 生成，202 接受后查询状态 |
| DELETE | `/worklog/runs/:date` | 删除当前时区下未交付草稿 |

新增接口要求 manage 权限，延续原有认证机制；Supervisor 写入依然走现有会话所有权检查与本机排除规则。

## 验证范围

新增自动化测试使用真实 SQLite、模拟模型与文档 HTTP 服务、模拟 Codex WebSocket app-server，覆盖会话绑定与固定主机路由、消息恢复与去重、原生审批只消费一次、恢复不重发任务、自然日与 DST 边界、逐会话排除、写入失败重试、数据库租约与权限隔离。

真实主机上的 Codex/Claude 二进制和用户实际在线文档接口尚未联调。浏览器测试环境下载 Chromium 失败，因此当前验证包括 TypeScript、前后端生产构建、服务与 API 测试，不包含真实浏览器交互验收。全量测试中还存在当前执行环境的文件所有权操作失败和部分旧测试间环境状态干扰；具体结果记录在 PR 中。

## 评审修复：启动幂等与会话元数据原子更新（2026-10-18，待复核）

针对上轮评审剩余项「启动请求服务端幂等、metadata 目录并发更新、服务端会话配置与切换隔离」的实现与证据：

- **启动幂等**：`launch_requests` 新增 `idempotency_key`/`idempotency_owner` 列与 `(owner, key)` 唯一索引（drizzle 0014 双方言 + 旧版 SQLite 初始化路径同步追加）。`createValidatedLaunchRequest` 预查返回首个 launch，并发冲突由唯一约束兜底；键按 Actor 作用域隔离，服务端仍自铸 correlationId，非法键 400。测试见 `src/server/services/launch-idempotency.test.ts`（6 用例）。
- **metadata 单键原子更新**：快照目录（opencodeCatalog）、会话偏好（opencodePrefs）、快照事务内的 permissionWait/opencode/opencodeManaged 均改为方言原生单键更新（SQLite json_set / PG jsonb_set，PG 列为 json 需 jsonb 往返转换）。任何写入方不再整对象覆盖其他写入方的键。
- **服务端会话偏好**：`GET/PUT /sessions/:id/opencode/prefs`（model/agent），写入走受管来源校验（外部/BotMux/legacy 只读），请求 Actor 参与所有权检查；前端会话切换时清空目录防串扰。
- **修复 0014 迁移文件缺 `statement-breakpoint`**：此前 SQLite 全新库只执行了第一条 ALTER 即记账，实际缺列缺索引；已修复并验证全新库完整建列建索引。
- **测试与验证**：新增 `opencode-prefs-catalog.test.ts`（偏好读写、observe-only 拒写、目录/偏好/无关键交错回归）；`bun run typecheck` 通过；本机 PostgreSQL 14 实测偏好/目录/事务内单键写入、无关键保留、脱敏白名单与幂等两列全部通过。全量测试与本仓 HEAD 基线一致（新增失败为 0；既有失败为环境敏感的计时/漂移用例）。

仍待评审：浏览器断言质量、fork 授权/队列/交互/停止/恢复/统计边界。
