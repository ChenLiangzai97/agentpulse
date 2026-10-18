# P1 日常会话工作台：现状勘察与增量计划

依据 [IMPLEMENTATION_TASKBOOK_2026-10-18.md](IMPLEMENTATION_TASKBOOK_2026-10-18.md) §P1。状态：勘察完成 + 首个切片（草稿隔离）已交付，实现待验收。

## 现状盘点（已有能力）

- 页签：`tabs-store.ts`（localStorage 持久化、每用户键、上限 12、含 managedState/cwd；超限剔除最旧）
- 命令：OpenCodeControls 已实现斜杠路由（/model 待生效本地持久、/session 选择器、/agent、自定义命令白名单、未知命令拒绝）——5038e98/770afac 交付并经 codex 二轮收紧
- 新建：新建会话主入口（最少配置：Agent + 目录，缺配置引导）已上线
- 受管运行时：managed_opencode 受保护绑定、审批卡片、交互队列（OPENCODE.md）

## 增量清单（按验收缺口）

| # | 增量 | 状态 |
|---|---|---|
| 1 | 草稿按会话隔离（切页签/刷新不丢，发送即清，容量有界） | ✅ v2 完成：持久化+viewer 隔离+身份/版本守卫+真组件浏览器证据 5/5 |
| 2 | 页签恢复可见性重校验（rehydrate 后对照会话列表/权限，隐藏不可见页签而非报错） | 待做 |
| 3 | 页签元数据：主机/目录/连接状态/待交互徽标（cwd 已有，补 host 与 pending 数） | 待做 |
| 4 | 关闭页签语义断言（仅收起 UI；达上限收起不停止会话——需浏览器证据） | 待做（P1 验收） |
| 5 | /fork 受管实现：原生 fork → 新受保护绑定 → 事件级 copyOf 映射（同时解锁 P4 真实 fork 去重） | 待做（最大件） |
| 6 | 浏览器 A/B 验收：两会话不同模型/agent 交错输入切换、网络目标断言、刷新恢复、关页签后台继续、fork 子会话答继承上下文 | 待做（P1 验收） |

## 增量 1 设计要点（v2，含评审修正）

- `usePromptDraftStore`：sessionId → 草稿；**localStorage 持久化，沿 tabs-store 的 viewer 隔离规则**（每用户键、未知身份不读写、切换身份清内存留磁盘）；LRU 50 会话、单条 12000 截断（与输入框 maxLength 一致，无静默丢稿）
- OpenCodeControls：挂载与 **sessionId 变化**时从 store 恢复（组件复用 A→B 不串稿）；发送捕获（会话身份, 草稿版本），完成时仅在身份未变且草稿未被改写时清空——A 的回调不能清 B，也不能清发送期间新写的草稿
- 单测 4 例（store 级：重载恢复 / viewer 隔离 / 版本守卫 / 容量上限）；**真组件浏览器证据 5/5**（worklog-ui-evidence/6-8 截图 + draft-isolation-browser.ts）：B 空稿无泄漏、页签切回恢复、刷新恢复、发送清空、清空持久
- 复跑：serve-managed-fixture（现直建 A/B 两个受管会话并携带 capabilities/心跳租约）→ draft-isolation-browser.ts <state.json>

## 后续顺序

1 → 2 → 3（小件合并一次提交）→ 5（fork，独立设计先行：绑定代数、审批隔离、停止语义、copyOf 写入路径）→ 4+6（浏览器验收合并）。
