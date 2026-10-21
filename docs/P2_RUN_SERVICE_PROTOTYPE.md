# P2 机制演示：detached 假服务（不是真实 Agent 的存活证明）

范围：演示 detached 启停机制与 manifest/token/start-ticks 的核验形状；**不**证明
真实 OpenCode 在 supervisor 重启后存活，也**不**接入主路径。真实 OpenCode 托管、
统一重连解析器与错误注入仍开放。
产物：`scripts/opencode-p0/p2-agent.ts`（假运行服务）、`p2-launcher.ts`（启动后立即
退出的 supervisor 替身）、`p2-detach-probe.ts`（重连验证）。证据：
`scripts/opencode-p0/p2-detach-evidence.json`（`ok=true`）。

## 已验证（仅假服务，Linux 本机）
1. **launcher 退出后假服务存活**：launcher 以 `detached:true` 启动服务后退出；服务进程继续存活
   （manifest 仍可读，PID 存活）。
2. **认证重连（形状验证；身份字段为启动参数自报，尚未绑定真实原生会话）**：新进程读取 manifest，用私有 token 文件做 Basic 认证调用
   `127.0.0.1` 回环 `/identity`，返回 instance/generation/native session 与 manifest
   一致。
3. **身份不可伪造**：`/proc/<pid>/stat` 的 start ticks 必须与 manifest 完全一致；
   不匹配（模拟 PID 复用）拒绝。错误 token 返回 401。
4. **地址不接受客户端指定**：只接受 manifest 中的 `127.0.0.1` 回环地址。

## 未验证 / 开放（下一批）
- **真实 OpenCode 由独立运行服务托管**；统一重连解析器（同一实现）核验进程启动身份、
  instance/generation、原生身份与回环认证，并对错误 token/伪 start ticks/错代/错原生
  身份一律拒绝；supervisor 退出/重启后原生轮次仍运行且可接续的证据。
- `setsid`/systemd user service 方案；
- 断线重连的补拉游标、审批恢复、动作对账；
- 中央服务停止/重启与网络断开矩阵（任务书 P2 验收矩阵）；
- 资源限制、空闲回收与“等待审批不回收”；
- 双主机同目录误路由与旧 generation 攻击（复用 fork 的 generation fence 后再测）。
