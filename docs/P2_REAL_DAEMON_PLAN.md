# P2 真实运行服务切片 — 实施计划（未实现，待新会话执行）

状态：设计/交接文档。**未实现**，不可当作 P2 验收。
基础已交付（HEAD 7be901f）：
- `run-service-resolver.ts`：manifest 绑定、回环、start ticks、token、identity 一致性（6/6）。
- `run-service-connection.ts`：受保护 store（root/instances/实例链、无 symlink、owner/权限、
  O_NOFOLLOW+inode、排他临时文件）、回环适配器（Basic、禁重定向、绝对截止+销毁连接、
  64 KiB 上限）（8/8）。

## 目标证据（只此一项可关闭本切片）
1. 守护进程托管**真实 OpenCode**（mock 模型即可），launcher/supervisor 退出后守护进程
   与原生轮次继续存活。
2. 新进程用 `connectRunService` 认证重连，拿到**同一 nativeSessionId**，并能取回**同一
   turn** 的完成结果（messageID 关联，时间与内容来自运行时）。
3. 反例：错 token、伪 start ticks、错 generation、错 nativeSessionId、服务自报身份漂移、
   重定向、非回环全部拒绝（走同一解析器/适配器）。

## 文件与职责
- `scripts/opencode-p0/p2-real-daemon.ts`
  - 参数：`root instanceId generation cwd profilePath`。
  - 用 `OpenCodeRuntimePool.start({instanceId, generation, sessionId: instanceId, cwd})` 启动真实
    OpenCode（**由守护进程持有**，非 supervisor）。
  - `token=randomBytes(24)`；`store.write(instanceId, manifest, token)`，manifest 含
    `nativeSessionId`、`pid`、`startTicks`、`url`（`127.0.0.1:0` 实际端口）、`tokenPath`。
  - API（全部 Basic 认证，仅回环）：`GET /identity`、`POST /prompt {messageID,text}`、
    `GET /messages`、`POST /abort`、`POST /shutdown`。
  - 收到 SIGTERM 时 `runtime.stop()` 后退出；`/shutdown` 同。
- `scripts/opencode-p0/p2-real-launcher.ts`：`spawn(process.execPath,[daemon,...],
  {detached:true, stdio:"ignore"}).unref()`，打印 `launchedPid`，退出。
- `scripts/opencode-p0/p2-real-probe.ts`（opt-in；需要 opencode + mock）：
  1. 起 mock 模型、写 profile；launcher 退出。
  2. 等 manifest；`connectRunService(root, instanceId, expected)` → ok。
  3. `POST /prompt {messageID:"msg_p2_turn", text:"P0_ABORT"}`（长轮次）。在**该轮仍在
     运行**时让 supervisor A 退出（A 只是发起方，不持有守护进程）。
  4. 由一个**独立的 supervisor B 进程**（不是同一探针进程的再次调用）用
     `connectRunService` 重连 → 同一 nativeSessionId；B 轮询 `/messages` 直到
     `msg_p2_turn` 的**终态**出现（最后助手步骤 completed 且 finish 属于白名单
     `stop`/空、无 running 工具；或取消标记）→ 取回**同一在飞轮次**的结果。
     仅“轮次完成后再次 connect”只证明结果可重读，**不作为**本切片证据。
  5. 反例：错 token(401)、伪造 manifest.startTicks、错 generation、错 native、服务自报
     漂移、非回环 URL、重定向 → 解析器/适配器明确拒绝。
  6. finally：`/shutdown`（认证）失败则按 start ticks 核验后 SIGKILL；删除临时目录。

## 已知风险
- `Bun.spawn` 的 stdio 管道在 supervisor 退出后可能触发 SIGPIPE：守护进程必须
  `stdio:"ignore"`（launcher 已 detached）并自行持有 opencode 子进程。
- OpenCode 的 XDG 隔离目录由 pool 创建在 `root/opencode-state`；重启对账需与现有
  `manifest.json`/`reconcile` 逻辑对齐（本切片只证明存活与同一 turn 可取回）。
- 不能把 `/identity` 自报字段当证据：解析器要求与 manifest 及期望三方一致。
