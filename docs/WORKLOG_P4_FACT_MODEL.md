# 工作日志 P4：统一事实记录与双视图（设计与增量状态）

依据 [IMPLEMENTATION_TASKBOOK_2026-10-18.md](IMPLEMENTATION_TASKBOOK_2026-10-18.md) §P4。状态：**管线已集成，实现待验收（2026-10-18 第三轮交付）**。

## 模型

一条抽取管线产出持久事实（`worklog-facts.ts`），两种呈现共享同一事实集：

- `WorklogFact`：`id / sessionId / host / occurredAt(源事件发生时间) / category / text(脱敏截断) / evidenceEventId(证据事件 id) / projectHint / confidence(stated|verified|inferred) / contentKey(归一化内容哈希)`。
- 五类事实严格区分：`user_goal`（用户目标）、`agent_claim`（助手自述，未经核实）、`tool_action`（实际执行）、`verified_result`（有验证证据）、`open_item`（未完成/待办）。
- **fork 继承去重**：跨会话同日 contentKey 相同的事实视为历史拷贝，只计一次（首见优先）。类别参与哈希，同类同文才算拷贝。
- **不可信输出防线**：模型输出为 JSON；`evidenceEventId` 必须落在该分片真实事件 id 集合内，否则整条丢弃并计数；`text` 截断 400 字；`id/contentKey` 服务端派生，模型不能指定身份；解析容错包裹 JSON 的散文。
- **个人回顾**：纯确定性渲染（无模型调用）——按会话分组、五类分节、证据以 `事件 #id` 可回溯、`agent_claim` 与 `verified_result` 标签隔离，防止"自述完成"被读成"业务完成"。
- **团队日报草稿**：确定性事实摘要（去证据噪音、类别标签、已验证标记）+ 单次模型调用按「成果/进行中/阻塞/下一步」四节产出；系统提示明确禁止把自述写成成果。
- **版本化**：`appendVersion` 只追加不覆盖；`source: facts|manual` 区分生成稿与人工编辑稿。

测试：`worklog-facts.test.ts` 9 用例——去重（归一化等价/类别区分）、不可信输出（越界证据丢弃、散文包裹解析、超长截断、空文本拒绝）、固定事实集的确定性双渲染断言、版本追加保留旧稿。

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
