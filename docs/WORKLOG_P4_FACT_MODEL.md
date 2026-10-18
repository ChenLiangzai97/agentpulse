# 工作日志 P4：统一事实记录与双视图（设计与增量状态）

依据 [IMPLEMENTATION_TASKBOOK_2026-10-18.md](IMPLEMENTATION_TASKBOOK_2026-10-18.md) §P4。状态：**核心模块实现待验收，管线集成未开始**。

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

## 尚未实施（按任务书验收逐项）

1. 管线集成：`runWorklog` 改为 分片读取→事实抽取(JSON)→去重→持久化（`worklog.facts.{tz}.{date}`），替换现自由文本摘要；沿用租约/预算/100 次调用上限/脱敏。
2. 端点：事实读取、个人/团队双稿生成（POST 返回 202 + 轮询，沿用现有模式）、版本列表/采用、范围预览（纳入/排除会话清单）。
3. UI：WorklogPage 增加输出类型选择、范围预览、版本切换与差异采用、团队稿脱敏预览。
4. 跨天/DST/补传用例接入既有 worklog-service.test.ts 基建（mock 模型返回事实 JSON）。
5. 团队稿导出不赋予接收者原始会话权限（仅导出脱敏 Markdown，当前设计已满足，验收时补测试）。

## 边界重申

- 不做自动对外发送；交付仍走既有 document 接口与幂等键。
- 事实文本进入模型前过 `redact()`；evidence 引用不出现在团队稿。
- 用户编辑以 manual 版本追加，重新生成不覆盖已编辑稿。
