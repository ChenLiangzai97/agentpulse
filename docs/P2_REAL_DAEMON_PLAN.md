# P2 真实运行服务切片 — 实施记录

状态：**已实现并实测**（脚本级原型，未接主路径）。基线 `0724e02`（分支
`feat/multi-host-sessions-worklog`）。实测环境：Linux 本机、OpenCode 1.18.35、
Python 3 回环 mock 模型；OpenCode 与全部进程均为真实进程，mock 仅替代模型。
未迁移生产、未接入 supervisor 主路径、未改变 fork/resume 入口，也未放宽
external/BotMux/legacy 只观察守卫。

## 目标证据（本切片只以此关闭）
1. 守护进程托管**真实 OpenCode**（mock 模型即可），launcher/supervisor 退出后
   守护进程与原生轮次继续存活。
2. 新进程用同一 `connectRunService` 认证重连，拿到**同一 nativeSessionId**，并在
   轮次**仍在飞时**连上，取回**同一 turn**（messageID 关联）的终态结果，时间与
   内容来自运行时。
3. 反例：错 token、伪 start ticks、错 generation、错 nativeSessionId、服务自报
   身份漂移、非回环、重定向、路径重定向全部拒绝（走同一解析器/适配器）。

## 产物

- `scripts/opencode-p0/p2-real-daemon.ts`
  - 用 `OpenCodeRuntimePool.start({instanceId, generation, sessionId, cwd})` 启动并**持有**
    真实 OpenCode；只向控制面暴露 `{messages, status}` 子集。
  - `token=randomBytes(24)`、自身 `startTicks`，经 `startRunServiceDaemon` 写受保护
    manifest（`nativeSessionId`、`pid`、`startTicks`、`127.0.0.1` 实际端口、token 路径）。
  - SIGTERM/SIGINT 与 `/shutdown` 都先 `runtime.stop()` 再退出；`/shutdown` 失败
    保持可观察（沿用 daemon 既有语义）。
  - 启动阶段/就绪/失败写入同目录私有 `daemon-status.json`，供探针在 manifest 出现
    前区分“启动失败”和“仍在启动”。
- `scripts/opencode-p0/p2-real-launcher.ts`
  - `spawn(process.execPath,[daemon,...],{detached:true,stdio:"ignore"}).unref()`，
    打印 `{launchedPid,startTicks}` 后立即退出；不持有守护进程或 OpenCode。
- `scripts/opencode-p0/p2-real-supervisor.ts`
  - `--role a`：用 `connectRunService` 认证后 `POST /prompt`（`P0_ABORT` 长轮次），
    等到运行时确认 `busy`、用户消息存在且轮次未终态，**在该轮在飞时退出**。
  - `--role b`：独立 OS 进程，用同一解析器重连，先确认**仍 busy（在飞）**，再轮询
    `/messages`，以运行时 `turnTerminal`（completed + finish 白名单 + 无 running tool）
    取回同一 messageID 的终态、时间与文本。
- `scripts/opencode-p0/p2-real-probe.ts`（opt-in；需本机 OpenCode + Python 3）
  - 起回环 mock 模型、写私有 profile、detached 启动守护进程。
  - 等 manifest，`connectRunService` 初连；核对守护进程与 OpenCode 的 pid/start ticks
    与 `serve --pure` 命令行。
  - 跑 A → 断言 A 退出后守护进程/OpenCode 仍存活、mock 请求已开始、轮次仍 busy 且
    未终态 → 跑 B → 断言同一 nativeSessionId/messageID 的终态。
  - 反例全部走真实 manifest + `resolveRunService` + `requestRunService`。
  - `finally` 先按 start ticks 核验身份，再 `/shutdown`（认证），必要时 SIGTERM/SIGKILL；
    原生子进程优先用 `stopRecordedOpenCodeProcess`（pid+start ticks+cwd+cmdline+env），
    回退也只杀已核验 ticks 且含 `serve --pure` 的进程；mock/launcher 同样核验后回收；
    有存活进程时保留 root 并标 `ok=false`。
- `src/supervisor/providers/run-service-connection.ts`
  - 把原来只支持 `/identity` 的适配器抽成同一个 `requestRunService`：回环、
    Basic、**不跟随重定向**、绝对截止、64 KiB（identity）/8 MiB（messages）上限。
  - 新增同源路径校验（`//host` 或绝对 URL 直接 `run_service_invalid_path`，凭据不会
    被重定向）；`/prompt`、`/messages`、`/shutdown` 复用同一适配器。

## 实测命令与结果（2026-10-23）

```bash
P0_OPENCODE_BIN=<opencode> bun scripts/opencode-p0/p2-real-probe.ts
bun test src/supervisor/providers/run-service-{connection,daemon,resolver}.test.ts
bun run typecheck
```

结果（`scripts/opencode-p0/p2-real-evidence.json`，`ok=true`）：

- launcher 退出后守护进程启动真实 OpenCode；manifest 的 pid/start ticks 与
  `/proc` 一致，OpenCode cmdline 为 `serve --pure`。
- supervisor A 在 `status=busy`、用户消息已存在、`turnTerminal=false` 时退出（exit 0）。
  A 退出后立即观测：守护进程与 OpenCode 均存活（start ticks 不变）、mock 模型请求已
  开始、同一 turn 仍 `busy` 且未终态。
- supervisor B 为独立进程，同一解析器重连时 `connectedWhileInFlight=true`；15.1s 后取回
  同一 `nativeSessionId`、同一 `messageID` 的终态：assistant `parentID`=该 messageID，
  `finish=stop`、无错误、`completedAt` 来自运行时、文本 `P0_DONE`。
- 拒绝证据：
  - 错 token → resolver `authentication_failed`；适配器 HTTP 401。
  - 伪造 manifest start ticks → `process_gone_or_reused`。
  - 错 generation / 错 nativeSessionId → `identity_mismatch`。
  - 回环但自报身份漂移的服务 → `identity_mismatch`（不信任自报）。
  - 非回环 URL → resolver `not_loopback`；适配器 `run_service_not_loopback`。
  - 跨源路径重定向 → `run_service_invalid_path`（请求未发出）。
  - HTTP 302 → `run_service_redirect_refused`（不跟随、不复用凭据）。
- 单元测试 18/18 通过；`bun run typecheck` 通过；脚本另用临时 tsconfig 做了
  `tsc --noEmit`（通过）。Biome 对改动文件通过。
- `finally`：`/shutdown` 200；守护进程、OpenCode、mock 均回收；临时 root 删除。
- `bun run check:architecture` 在 `check:ownership-guards` 处失败，指向未改动的
  `src/server/services/opencode-fork-service.ts:272`（基线既有问题，未在本切片修复）。

## 仍未覆盖（明确不在本切片）
- `setsid`/systemd user service 安装、开机/崩溃自动拉起、资源限制与空闲回收；
- 中央服务停止/重启、网络断开矩阵、断线补拉游标与动作对账；
- 审批/问题在重连后的恢复（本切片只有普通文本轮次）；
- 双主机同目录误路由、旧 generation 攻击的跨实例围栏；
- fork/resume 入口与主路径接入、生产迁移、external/BotMux/legacy 守卫变更。
