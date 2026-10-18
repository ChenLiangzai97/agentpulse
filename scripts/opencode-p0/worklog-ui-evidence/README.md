# 工作日志双视图浏览器验收证据（2026-10-18）

真实 Chrome（playwright channel=chrome，headless）驱动生产构建（`bun run start`，端口 3100，
独立 SQLite），10/10 断言通过：

1. `1-scope-preview.png` 范围预览：列出当日窗口内会话、三类事件计数、纳入标记
2. `2-team-view.png` 团队日报视图：四节 Markdown 渲染
3. `3-personal-view.png` 个人回顾视图：`事件 #id` 证据回链、类别标签、自述与结果分离
4. `4-version-diff.png` 版本差异：非采用版本与当前采用版本的行级 diff
5. `5-manual-edit.png` 人工编辑：保存为 manual 版本并自动采用（已采用徽标）

复跑方式：
```bash
rm -rf /tmp/agentpulse-wl-e2e && mkdir -p /tmp/agentpulse-wl-e2e
bun scripts/opencode-p0/worklog-ui-seed.ts          # stub 模型 + 种子 + 生成双视图
(cd /home/ch/project/work_station/agentpulse && SQLITE_PATH=/tmp/agentpulse-wl-e2e/e2e.db \
  DATA_DIR=/tmp/agentpulse-wl-e2e/data DISABLE_AUTH=true PORT=3100 bun run start &)
# 另一处安装 playwright 后：bun scripts/opencode-p0/worklog-ui-browser.ts
```

注意：服务器会启动 legacy observer，把本机真实 opencode 会话采集进该独立库（预览表中的
非种子会话即来自该路径），不影响断言与生产数据。
