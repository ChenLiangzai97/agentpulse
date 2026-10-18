# 工作日志 P4：统一事实记录与双视图（设计与增量状态）

依据 [IMPLEMENTATION_TASKBOOK_2026-10-18.md](IMPLEMENTATION_TASKBOOK_2026-10-18.md) §P4。状态：**管线已集成，实现待验收（2026-10-18 第三轮交付）**。

## 模型

一条抽取管线产出持久事实（`worklog-facts.ts`），两种呈现共享同一事实集：

- `WorklogFact`：`id / sessionId / host / occurredAt(源事件发生时间) / category / text(脱敏截断) / evidenceEventId(证据事件 id) / projectHint / confidence / contentKey / lineageRoot(血缘根) / eventContentKey(源事件内容哈希)`。
- 五类事实严格区分：`user_goal`（用户目标）、`agent_claim`（助手自述，未经核实）、`tool_action`（实际执行）、`verified_result`（有验证证据）、`open_item`（未完成/待办）。
- **服务端权威字段（2026-10-18 第四轮评审修订）**：`occurredAt`、`eventContentKey`、`lineageRoot`、`id/contentKey` 全部由被引用的源事件派生，模型无法指定；采集范围扩展到 `tool_event`（真实工具证据进入分片）。
- **分类受证据类型与工具状态双重约束（第五轮评审修订）**：`verified_result`/`tool_action` 只能引用 tool_event 行，`agent_claim` 只能引用 assistant_message 行，`user_goal` 只能引用 prompt 行；且 `verified_result` 额外要求该工具事件**机械化分级为 completed_output**（eventType=PostToolUse 且 toolResponse 非空）——运行中（PreToolUse）、失败（PostToolUseFailure）、无输出的完成工具一律降级为 `tool_action`。`confidence=verified` 仅授予存活的 verified_result，模型无法凭标签授予。降级计入 factMeta.downgraded。
- **fork 去重改为保守保留（第五轮评审修订）**：内容相同 + 血缘命名不构成继承证明。去重仅在存在**可信复制映射**（`copyOf` 指向原始事件 `sessionId:eventId`，由能证明拷贝的采集路径写入）时发生，同组保留首见；当前无任何采集路径写入 copyOf，因此一律保留——同一事件多条事实、同会话重复执行相同命令、同父不同分支独立产生的相同内容均不删除。待 P1 受管 fork 落地记录事件级拷贝映射后再启用真实去重。
- **不可信输出防线**：模型输出为 JSON；`evidenceEventId` 必须落在该分片真实事件集合内，否则整条丢弃并计数；`text` 截断 400 字；**解析失败显式失败**（runWorklog 抛错、run 状态 failed），不再伪装为空日志。
- **个人回顾**：纯确定性渲染（无模型调用）——按会话分组、五类分节、证据以 `事件 #id` 可回溯、`agent_claim` 与 `verified_result` 标签隔离，防止"自述完成"被读成"业务完成"。
- **团队日报草稿**：确定性事实摘要（去证据噪音、类别标签、已验证标记）+ 单次模型调用按「成果/进行中/阻塞/下一步」四节产出；系统提示明确禁止把自述写成成果。
- **版本化**：`appendVersion` 只追加不覆盖；`source: facts|manual` 区分生成稿与人工编辑稿。

测试（第五轮后 34 用例）：`worklog-facts.test.ts` 19 用例——保守去重（无映射一律保留/单事件多事实/重复命令保留/同父兄弟分支不合并/copyOf 映射组合并/嵌套 child 剥离）、证据约束（助手消息 verified 降级、**运行中工具伪标 verified→tool_action、失败工具伪标 verified→tool_action、无输出完成工具不可 verified**、user_goal 错引降级、越界证据拒绝、confidence=verified 仅限存活 verified）、服务端派生时间、解析失败显式化、确定性双渲染、版本追加；`worklog-service.test.ts` 15 用例——含对抗 stub（HOSTILE 伪造 verified+confidence）、**运行中/失败工具服务级对抗**、工具输出支撑 verified（confidence=verified）、时间绑定源事件、解析失败 run=failed、保守保留服务级回归。

**测试环境注意**：模型 stub 走 loopback（127.0.0.1），代理环境变量会把请求路由到代理导致 502。复跑命令：

```bash
cd /home/ch/project/work_station/agentpulse
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
  bun test src/server/services/worklog-service.test.ts src/server/services/worklog-facts.test.ts src/server/routes/worklog.test.ts
```

## 管线集成（2026-10-18 第三轮）

- `runWorklog` 生成路径改为：分片（每行携带 `[#事件id]` 前缀）→ `FACT_EXTRACTION_SYSTEM_PROMPT` 抽取 JSON 事实（证据 id 必须落在分片内，否则丢弃并计数）→ 跨会话 `dedupeFacts` → 个人回顾确定性渲染 + 团队日报单次模型调用 → 双版本追加持久化。沿用既有租约、AI 开关、每日预算预留/结算、100 次模型调用上限（团队稿计入）、`redact()` 脱敏。
- `run.markdown` = 被采用版本（默认最新团队稿）的内容，文档投递与幂等键不变；`facts`/`factMeta`/`versions`/`adoptedVersionId` 随 run 持久化。
- 强制再生成（`runWorklog(..., {force: true})`）**追加**新版本、保留旧稿；旧个人稿逐字保留有断言。
- 端点：`GET /worklog/runs/:date`（事实+双视图详情）、`POST /worklog/runs/:date/adopt {versionId}`（切换导出版本；已投递锁定）；沿用 manage 权限与团队模式 admin 门。
- UI（WorklogPage）：事实统计行（条数/去重/无效引用/抽取模型）、版本切换页签（个人回顾/团队日报/人工编辑标记/已采用徽标）、"采用此版本用于导出"按钮。
- 测试：服务级 11 用例（含跨会话 fork 拷贝去重、再生成版本追加、采用切换投递内容、投递后锁定）+ 路由级 1 用例（真实 HTTP 详情/采用/404）；mock 模型按系统提示词区分抽取与团队渲染协议。

查看双视图证据：配置好模型服务后 `POST /api/v1/worklog/runs {"date":"..."}`，再 `GET /api/v1/worklog/runs/<date>` 即得 `versions[]`（个人回顾含 `事件 #id` 证据回链）与 `facts[]`；或在网页"工作日志"页切换页签查看。

## 仍开放（按任务书验收逐项）

1. 范围预览端点与界面（生成前显示纳入/排除会话清单）。
2. 人工编辑落为 `source:"manual"` 版本的 UI 入口（服务端 appendVersion 已支持）。
3. 版本差异视图（diff 预览后显式采用）。
4. 跨天/DST/离线补传的补充用例（现有日历边界用例保留，补传场景待补）。
5. 团队稿导出不赋予接收者原始会话权限（当前仅导出脱敏 Markdown，验收测试待补）。

## 边界重申

- 不做自动对外发送；交付仍走既有 document 接口与幂等键。
- 事实文本进入模型前过 `redact()`；evidence 引用不出现在团队稿。
- 用户编辑以 manual 版本追加，重新生成不覆盖已编辑稿。
