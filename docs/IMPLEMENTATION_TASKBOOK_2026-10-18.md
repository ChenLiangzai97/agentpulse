# AgentPulse 集中管理与日志总结开发任务书

日期：2026-10-18。方案与任务分解：StationAgent-codex；实施：StationAgent-opencode。

## 1. 授权、依据与交付范围

依据 [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) §1–9，以及用户本轮指令“除了即时通信软件那一条，其他几条也设计一下方案，出一份任务书，给 StationAgent-opencode 开发”。本轮新增授权为这些目标制定方案并按本任务书分期开发；不再沿用“仅发送提醒”的旧任务范围。本文是实施方案，不把设计选择冒充用户原话。

近期交付：个人使用的跨机会话工作台、原生命令、可信历史接续、独立执行生命周期、个人回顾及团队日报草稿。完整替代 BotMux 纳入能力盘点与迁移设计；不直接全面实施长期编排系统，不切换正在使用的生产驱动。

明确排除：§10 的 IM 主工作台/改造 IM 客户端选型，自动对外发送日报，多人登录改造，完整事项/项目任务编排。既有飞书入口的未来兼容设计属于 BotMux 替代路线，不等于本轮建设 IM 软件。

现状基线为本地 7ab6a09；该提交是实现待验收。本文检查了需求、工作日志、tabs-store、OpenCode runtime 接口及项目约束，未完成代码评审或真实运行验收。优先复用现有控制、队列、观察、日志和页签能力，不另起平行系统。

## 2. 总体架构与数据契约

采用现有 React 工作台 → Hono 会话控制服务 → 固定主机 Supervisor → 主机侧独立运行服务 → OpenCode 的分层。网页只表达操作与呈现结果；中央服务持久化身份、操作和交付状态；主机侧运行服务持有原生连接、执行权、输出日志和审批。Supervisor 管理连接与上报，不能因自身重启杀掉运行服务。

逻辑身份区分：平台 sessionId、固定 hostId、来源 sourceInstanceId、nativeSessionId、providerInstanceId、bindingGeneration。不得仅凭 native ID 或目录字符串合并/路由。控制校验继续使用受保护绑定；metadata 只供展示，不授予权限。API 沿用既有 Actor、scope、所有权与 trustedRoots 检查。

控制动作持久化稳定 actionId/idempotencyKey、目标绑定代数、预期状态、结果。建议状态为 queued/claimed/running/succeeded/failed/unknown/cancelled；状态变化单调，超时不等于未执行。租约过期不能自动重发非幂等动作，unknown 需对账或用户处理。原生端若不支持幂等/查询，崩溃窗口必须如实标为 unknown，不能声称 exactly-once。

输出使用稳定事件身份与游标去重补拉，迟到事件不能覆盖新状态。审批绑定 native request、连接/运行代数、截止时间，一次性消费；失效应提示重新请求，不重放旧批准。

迁移需兼容 SQLite 与 PostgreSQL、旧库初始化和全新库；凭据留在执行主机私有配置，不进入浏览器、摘要、普通元数据或 Git。

## 3. 工作包与验收

### P0：收尾基线与实测能力清单

先核对工作区、分支、未提交内容和 7ab6a09 diff；不覆盖其他人的修改。复核启动幂等、metadata 原子更新、会话偏好隔离及迁移修复；补齐浏览器断言与 fork 边界证据。旧代码存在不代表通过，环境未覆盖要列缺口。

形成原生命令/API 能力表：/model、/agent、/new、/session、/fork、/help、自定义命令，逐项记录版本、请求、响应、错误、是否产生推理、恢复语义与实测证据。以本机安装版本和仓库 fixture 实测；升级版本必须重验，不能据记忆假设 API。

验收：SQLite 全新/升级库及 PostgreSQL 实测列和索引；并发同 Actor 同键只得到同一启动、不同 Actor 隔离；并发 metadata 更新保留无关键；快速切换不串模型、目录或审批。fork 覆盖越权、重复请求、并发队列、父子审批隔离、停止子分支不影响父分支、恢复与继承统计去重。记录基线与新增失败，不能只写“全绿”。

### P1：日常会话工作台与命令

沿用 tabs-store 和现有详情组件。一个页签绑定一个真实会话，显示主机/目录、连接状态、运行状态和待交互提示。草稿、滚动位置按 sessionId 隔离；页签恢复后重新校验会话可见性。关闭页签仅收起界面，达到页签上限不得停止被收起的会话。

新建入口默认 Agent 与目录，跨机时明确目标主机；有效 profile 和模型作为默认值，缺配置给出可操作引导。模板是高级预设。命令输入先解析：/model、/agent 更新会话级真实配置且不发多余 prompt；/new 建立新会话开页签；/session 切换真实历史身份；/fork 用经验证原生 fork 继承上下文并开独立分支。/help 显示当前主机实际能力，自定义命令仅调用已验证目录，未知命令明确报错。文案沿现有 zh-CN/en i18n 层完整汉化。

切换/异步请求用会话身份和请求代数丢弃旧响应。发送时捕获该会话的配置快照，不能从当前全局 UI 读取别的页签设置。fork 显示父会话、分叉点和共享目录提示，不承诺文件系统隔离。

验收：真实浏览器创建 A/B 两个会话，设不同模型/agent，交错输入和切换，断言网络请求目标及原生执行配置；刷新恢复页签；关闭页签后后台继续输出；真实 fork 后子会话能回答继承的上下文且新增对话不写入父会话。禁止用仅检查 HTTP 200、DOM 有文本或 mock 返回作为完整端到端验收。

### P2：跨机执行与生命周期解耦

主机侧采用可独立启动/重连的运行服务，优先验证 Linux 用户服务方案；保留现有隔离目录、认证回环访问、资源限制及受保护绑定。先用小型原型证明 Supervisor 重启不杀 Agent，再迁移运行时；不要只改变父进程退出处理便宣布解耦完成。运行服务恢复凭据、实例身份和进程身份需可验证，不能只凭 PID 重连；原生服务认证地址不接受客户端任意指定。

中央队列保留操作结果，主机端落盘事件后上报并等待确认。断线显示“失联/结果待确认”，不能写成完成；恢复补拉游标与审批，并对账动作。区分“中止当前轮次”“停止会话”“停止运行实例”，共享实例停止应明确影响范围。空闲回收不得杀正在工作/等待审批的会话，显式停止之外的资源回收规则需在界面和文档说明。

验收矩阵：关闭浏览器、刷新、中央服务停止/重启、网络断开、Supervisor 正常重启和强制退出。前述场景中长任务保持同一原生身份，重连后输出完整且任务不重发。主机重启、Agent 崩溃和运行服务自身崩溃另测并标中断/unknown，不承诺进程继续存在。对原生不支持恢复的 pending 交互明确失效。双主机同目录字符串不能误路由，旧 generation 不能控制新实例。

### P3：普通终端与 BotMux 历史安全接续

分两步交付：先只读发现与迁移预检，再实现显式交接。发现卡片列来源、主机、native ID、目录、版本/配置/插件兼容性和驱动状态；默认只读。运行中的来源不能直接接管。

交接状态建议 discovered → preflight → source_released → importing → verified → active，失败进入 failed/quarantined。保留原始来源记录和迁移记录；新建受保护的接续绑定及旧/新身份映射，不把现有外部观察记录改成可写。原生导出/导入或服务接续方式必须先实测；禁止复制一段历史 prompt 冒充恢复。配置与插件逐项选择，不自动复制密钥或继续加载 BotMux 控制插件。

对普通终端核验原驱动已停止写入；对 BotMux 使用其明确交接/释放机制或由用户操作释放，并取得可验证证据。仅“进程看似空闲”或一次 PID 查询不足以证明控制权移交。迁移期间源端不得继续驱动；无法证明独占时停在只读预检，继续交付其他工作包。用户授权做接续方案不等于授权现在停止正在运行的 BotMux。

验收：终端与 BotMux 各至少一个真实历史样本，保留目录、对话、模型来源、父子关系和可验证上下文；接续后仅新控制方可写；重复接入幂等；失败无隐式提权。旧 Actor、旧 generation、伪造 metadata、仍活跃旧驱动均拒绝。回滚只在新侧已释放后允许恢复旧侧；未能安全恢复则隔离，不能双写。

注意：当前 AGENTS.md 的外部/BotMux/legacy 永久只观察规则持续有效。P3 的新绑定路径须先提交专门安全设计与实验，明确与旧规则的关系；未评审前不修改既有写入授权守卫。优先实现预检与隔离迁移原型，控制边界变化独立评审。

### P4：个人回顾与团队日报

复用 worklog-service，抽离统一事实记录再渲染两个视图，不维护两套采集。建议事实包含来源事件身份、会话/主机、发生时间、项目线索、事实类别、证据引用与置信状态；分开用户目标、Agent 自述、实际工具执行、验证结果和未完成项。

日期使用可配置 IANA 时区和半开区间 [当日零点,次日零点)，默认 Asia/Shanghai；分页读取，跨天取发生时间，补传不改成接收日。fork 继承事件引用原来源，不重复记作当日工作/费用。项目只按显式关联或可靠证据归组，不能靠相似标题强行合并。

个人版展示目标、操作、尝试、决策、验证和未完成项，可展开原始证据；团队版为成果、进行中、阻塞、下一步，默认草稿。生成前选择日期、会话范围和输出类型；范围预览显示纳入/排除项。团队内容有脱敏预览，不能泄露凭据、隐藏上下文、私人路径或未经选择的会话。

草稿、人工编辑、重新生成版本分开存；重新生成产生新版本，保留旧稿，显示差异后显式采用。保留事实快照/来源引用与生成配置版本，模型失败不覆盖已有稿。支持 Markdown 下载/复制；调用沿用 AI 开关、kill switch、费用预算，缺模型明确提示。既有自动投递能力不得因升级自动开启；本轮默认不对外发送。

验收：跨天、DST、离线补传、归档但当日活跃会话、分叉继承去重、事实与自述区分、已排除会话不进入团队稿、敏感信息处理、引用可回溯、人工编辑不被覆盖、生成失败/预算受限仍可读取旧稿。团队稿导出不赋予接收者原始会话权限。用固定事实集验证内容约束，避免依赖模型随机措辞判断通过。

### P5：完整替代 BotMux 的分期设计交付

本轮产出真实能力矩阵和迁移设计，不全面重写。从实际使用场景、已安装 CLI help/skill、配置与可审计代码盘点：身份/路由、会话桥接、附件/交付回执、审批/问答、定时任务、交接协作、插件、运维/恢复等；每项列当前行为、证据、AgentPulse 覆盖、缺口、优先级、复用或重写方案、测试用例。不得把枚举当全量，未知标待核验。

提出网页/飞书共用控制服务的入口协议：统一 Actor、session binding、动作去重、审批身份和附件权限；平台适配层只翻译入口，不另持执行权。设计灰度迁移到单个测试会话、回滚、配置兼容、定时任务去重和交付结果不确定的处理。

验收：用户日常流程逐项有去向；给出后续可执行开发清单与成本/风险分级。生产切换、关闭旧 bot、复制凭据及启用自动发消息均不在本任务书执行范围，未来以具体迁移方案单独授权。

## 4. 顺序、交付与验收报告

顺序：P0 → P1；P2 是 P3 激活交接的前置，P3 只读预检可提前；P4 可独立实施；P5 先交设计文档。每包独立提交/PR，勿一次大改。P0 的发现影响其他包时先修回归；非相关既有失败记录基线，不能改测试把它藏掉。

每包提交包括：实现/迁移、针对性测试、复现命令与结果、原生版本、支持与失败边界、升级与回滚步骤、截图或浏览器记录、剩余项。状态为待开发/实施中/实现待验收/验收通过；实施者自报不能自升级为验收通过。向本话题报告 commit 和证据，由 codex 复核；用户最终体验验收仍需实际使用。

必要检查按变更选择：typecheck、Biome、相关服务/组件回归；结构变化跑 architecture；前端/服务入口变化跑生产 build；双数据库与初始化变化实测两方言全新/升级路径。浏览器不可用、原生版本不匹配或跨机环境缺失时列为未验证，不用模拟证据替代。

首批行动：核对工作区并提交 P0 剩余问题清单；开始 P1 与 P4 的具体实现；P2/P3 先完成可验证原型和设计记录，再接入主路径。无需为日常可逆实现重复请求授权；真正需要停止旧驱动、迁移真实会话或改变旧授权守卫时提交具体对象、影响及回滚方案。

## Status snapshot — 2026-10-27

Implemented & committed (acceptance status in parentheses):
- P1 drafts, async drafts, build provenance/hash gate, causal turn correlation
  (native `parentID`), two tab-close entries — implementer run 14/14 (independent browser run pending).
- Fork: acceptance route + finalize + trusted-child ingestion (own native
  snapshots, generation/host checks, copyOf, idempotency) + browser inheritance
  / isolation / STOP boundary — implementer 12/12 + model-request 暗号 proof
  (independent browser run pending).
- OpenCode observe-only hint keyed on server capability, with per-cause copy
  (external/not_owner/unavailable/unknown) — 14/14 unit + both page types.
- P2 real detached daemon A/B reconnect on the same native session/messageID —
  implementer real-CLI run (independent run pending).
- P3 read-only preflight (discovery, status, redaction) — base only.
- P5 migration design + help snapshot — design only.

Open / not accepted:
- Stop → resume → real new turn (controlled operator entry), killed-instance
  relaunch/rebuild, same-action/token/epoch reconciliation before clear.
- P2 main path integration; reconnect cursor, approvals, action reconciliation;
  resource reclamation; multi-host failure matrix.
- P3 terminal discovery + real config/plugin compatibility preflight.
- PG upgrade/interleave probes need independent acceptance re-run.
- Product entries (fork/resume, external safe continuation) remain CLOSED.
