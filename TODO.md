# 待办事项

## 未完成

- [ ] 日志总结的 LLM 配置：工作日志功能目前 enabled=false、provider/model 为空，仅有一个 Local Stub 占位模型。需配置真实模型提供方 + API Key + 模型名（可选：飞书文档自动投递），然后启用。

## 已完成

- [x] opencode 会话控制（第二阶段）：AgentPulse 自管会话可控制、BotMux 会话永久仅观察。P0 协议验证 GO → P1 受保护来源 → P2–P4 受管运行时/审批卡片 → P5 终局验收通过（661cbef 已推送，生产 3000 已部署）。
- [x] agentpulse 增加 opencode 会话跟踪（observe-only）：7/7 验收通过，含构建修复与时间线打磨
