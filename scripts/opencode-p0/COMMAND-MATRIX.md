# OpenCode 网页 /命令 实测记录（脱敏）

基线：CLI 1.18.35 隔离实例（--pure + 独立 XDG + OPENCODE_CONFIG 注入，本仓库 P0 fixture 流程）。
本文件记录网页命令菜单的协议事实与产品规则，作为评审与回归依据。

## 命令通道事实（实测）

- `POST /session/{id}/command` 仅适用于**原生命令**（自定义命令与 skills，source=command/skill）：
  实测自定义命令 `hello`（config/opencode/command/hello.md）被原生展开为用户消息并由模型执行。
- 同接口传 TUI 内置名（如 `model`）→ `500 UnknownError`：TUI 内置动作不可经 API 执行。
- `/command` 的 `model` 字段为字符串 `"providerID/modelID"` 形态（OpenAPI 定义），与
  `prompt_async` 的对象形态不同；`agent` 为字符串。
- `POST /session/{id}/prompt_async`：
  - 显式携带 `model {providerID, modelID}` → 会话默认模型被**原生切换并持久**（GET /session
    证实在实例重启后保持；作用域=该会话）。
  - `agent` 按请求生效，未见会话级粘滞 → 每条请求显式携带。
- 模型切换验证方式：**发送真实带模型消息 + 隔一条不带模型的普通消息**，从隔离实例数据库的
  message 记录取证（两条均为切换后的模型 = 原生粘滞）。绝不发送空 prompt 做验证。

## 产品规则（第二轮评审后收紧）

1. `/model` 选择只做本地持久（按会话键），不调用任何模型接口；随用户下一条真实消息显式携带。
   界面区分"已选择待生效"与原生已生效；文案不得宣称"切换零消耗"（发送即正常推理）。
2. `/agent` 每条请求显式携带；`opencode_command` 动作与普通 prompt 携带同一份待生效配置，
   两条通道配置一致。命令产生的消息/工具证据走既有采集与去重，无新通道。
3. `--pure` 隔离下 `GET /command` 仍会列出**全局 skills**（来源 ~/.agents/skills）。事实记录：
   - 读取范围：仅名称与描述文本（本轮目录存储还裁剪掉模板正文）；
   - 未执行任何插件代码；
   - 是否隐含扩大文件访问：未证实，按隔离例外对待。
   本轮网页菜单**仅开放 source=command 的实例原生命令**；skills 待来源策略评审后另行开放，
   不默认全量暴露为可执行。
4. 未知 `/xxx`：服务端正则拒绝 + 前端明示"不会作为消息发送"。
5. 目录存储脱敏：provider 仅存 id/name/裸模型 id（options/env 一律剥离）；曾出现过的
   options 回传形状已修复并清洗存量 metadata。

## 尚未支持（显式排除）

`/new`（走 AgentPulse 新建会话与受保护绑定）、`/share`（公开会话内容，本轮不开放）、
`/theme`（网页本地偏好）、`/undo`、`/compact`、`/export`（待逐项核实 API/语义/权限）。

## 2026-10-18 能力表补全（capability_probe.py 实测）

证据：[capability-evidence.json](capability-evidence.json)（原生 ID 已标签化）。基线同上：1.18.35 隔离实例 + 确定性 mock 模型，可复跑 `python3 capability_probe.py`。

- **/undo** ↔ 服务端 `POST /session/{id}/revert {messageID}` + `POST /session/{id}/unrevert`（2026-10-18 二次修订：初版的上下文结论证据不足已撤回，本版全部断言基于带唯一标记的历史断言——检查模型实收消息正文，断言失败探针非零退出）：
  - revert 将**指定消息本身及其后全部**内容从模型上下文排除。用户消息锚点与助手消息锚点均已验证：revert@turn3-user 后模型只见 turn1/2；revert@turn3-assistant 后 turn1/2 与（被替换重发的）turn3 用户消息可见；revert@turn2-assistant 后只见 turn1。
  - **撤销后继续对话的实测可行路径是以相同 messageID 重发**（TUI undo+edit 的替换流）。revert 后携带**新** messageID 的 prompt_async 返回 200 但在**本测试窗口（12 秒）内停滞**：无消息落库、无模型调用、服务日志无错；是否"永不完成"未证实（未做更长窗口/取消/断线恢复实验），也**未证明同 messageID 重发是唯一合法路径**。停滞 prompt 并未丢弃：unrevert 后其文本出现在模型上下文中（排队补投）。
  - **干净的 unrevert 恢复被撤内容**：revert 后立即 unrevert，被撤 turn 回到模型上下文。但**先发生停滞 prompt 再 unrevert**时：新 prompt 恢复可发、停滞 prompt 补投，被撤内容**不**回到上下文（边界事实，两次独立场景复现）。
  - 伪 messageID → **200 静默**（无校验、无变化）。
  - `/api/session/{id}/revert/stage|commit|clear` 分期端点存在；stage 对不在当前上下文的消息返回 404 `MessageNotFoundError`。
  - **候选适配方案（未定稿）**：网页 /undo 的一个候选实现是「revert + 同 messageID 重发（编辑）」，并在 revert 与重发之间不接受新 messageID 消息（会停滞并干扰 unrevert 恢复）。该方案待原生源码确认停滞机制、以及重复请求/取消/断线恢复验证后再定；/undo 维持不产品化，不扩大 P1 范围。
- **/compact** ↔ `POST /api/session/{id}/compact`：本版本实测 **503 "Session compact is not available yet"**（服务未提供，与鉴权无关）。网页暂不可映射 /compact。
- **会话级模型切换**：`POST /api/session/{id}/model`，ModelRef 必填 `{id, providerID}`（`providerID/modelID` 形态 400 `Missing key ["model"]["id"]`）。成功后 `GET /session` 的 `model` 字段持久为 `{id, providerID, variant}`，**另一会话不受影响**（并行会话保持原值）。与 prompt_async 携带模型的会话内粘滞互为补充。
- **会话级 agent 切换**：`POST /api/session/{id}/agent {agent}` → 200，但**无任何校验**：不存在的 agent 同样被写入并持久（GET /session 可见 `agent: "no-such-agent"`）。网页若做会话级 /agent 粘滞必须自行按目录校验，不能依赖原生拒绝。
- **TUI 控制端点在 headless 服务模式全部为无操作**并返回 true：`/tui/execute-command`（undo/new/model 实测无任何效果）、`/tui/select-session`（`/api/session/active` 恒为空 `{"data":{}}`）、`/tui/open-sessions`。不能用于网页驱动内置命令。
- **TUI 内置命令名经 `POST /session/{id}/command` 一律 500 UnknownError**：undo/compact/export/new/session/help/model/agent/share/theme 全量复测确认（与既有 `model` 单点结论一致）。
- **/export**：OpenAPI 162 路径中无对应服务端端点（TUI 本地行为），无 API 可映射。
- **/new**：API 等价物即 `POST /session`（hello.json 已证）；网页映射为 AgentPulse 新建会话 + 受保护绑定，不做原生透传。
- **/session 切换**：服务端无"激活会话"概念（headless 下 `/api/session/active` 恒空）；一切按会话 ID 寻址。网页 /session 选择器（5038e98）即产品实现，无需原生端点。
- **summarize**：`POST /session/{id}/summarize {providerID, modelID}` → true；存储新增摘要问答消息（消息数 +2）。
