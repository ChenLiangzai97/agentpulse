# 工作日志双视图浏览器验收证据（2026-10-18，第二版：纯种子隔离）

真实 Chrome（playwright channel=chrome，headless）驱动生产构建，**17/17 断言通过**。本版修复了第一版的隔离缺陷：仓库 `.env` 被 Bun 自动加载导致 observer 开启、真实会话与本机主机名进入证据。

隔离措施（种子脚本与服务器启动均已内置）：
- `delete process.env.DATABASE_URL`（禁止继承任何生产库连接串）
- `AGENTPULSE_OPENCODE_ENABLED=""` / `AGENTPULSE_OPENCODE_DB=""` 显式覆盖 .env，observer 关闭
- 清表前断言 `config.dialect === "sqlite"` 且 `SQLITE_PATH` 位于 `/tmp/agentpulse-wl-e2e/` 专用目录，否则拒绝执行
- 浏览器断言：范围预览**仅含两个种子会话**、无真实主机名模式

断言清单与截图：
1. `1-scope-preview.png` 范围预览：仅种子会话、三类事件计数、纳入标记、无主机名
2. `2-team-view.png` 团队日报：**四个小节（成果/进行中/阻塞/下一步）逐项断言**
3. `3-personal-view.png` 个人回顾：证据**可点击回链**（`/sessions/{id}?tab=activity#event-N`），实测点击跳转到 `e2e-main?tab=activity#event-1`；类别标签；自述与结果分离
4. `4-version-diff.png` 版本差异：非采用版本与采用版本的行级 diff
5. `5-manual-edit.png` 人工编辑：保存→渲染→已采用徽标→**刷新后仍保留**

回链说明：个人回顾中的证据引用是 markdown 超链接（AGEN-69 事件深链方案），点击打开该会话活动页签并高亮对应事件——不是纯文字引用。

复跑方式：
```bash
rm -rf /tmp/agentpulse-wl-e2e && mkdir -p /tmp/agentpulse-wl-e2e
cd /tmp/agentpulse-wl-e2e && echo '{"name":"wl-e2e","private":true}' > package.json && bun add playwright
cp /home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-browser.ts .
cd /home/ch/project/work_station/agentpulse
bun scripts/opencode-p0/worklog-ui-seed.ts
(SQLITE_PATH=/tmp/agentpulse-wl-e2e/e2e.db DATA_DIR=/tmp/agentpulse-wl-e2e/data DISABLE_AUTH=true \
  PORT=3100 DATABASE_URL= AGENTPULSE_OPENCODE_ENABLED= AGENTPULSE_OPENCODE_DB= bun run start &)
cd /tmp/agentpulse-wl-e2e && bun browser.ts
```

前端日期切换竞态已修复（`src/web/lib/latest-only.ts` 守卫：A→B 且 A 后返回时仅 B 生效，含单测）。
