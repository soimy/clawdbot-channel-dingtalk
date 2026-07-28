# 连接问题

如果初始化阶段只看到 HTTP `400`，它通常不代表“单纯网络不通”。更常见的是请求已到达钉钉，但被应用配置、权限或当前状态拒绝。

## 推荐的最小检查

先运行仓库内的连接检查脚本：

```bash
bash scripts/dingtalk-connection-check.sh --config ~/.openclaw/openclaw.json
```

Windows PowerShell：

```powershell
pwsh -File scripts/dingtalk-connection-check.ps1 -Config ~/.openclaw/openclaw.json
```

如果配置中的 `clientSecret` 使用 SecretInput 引用，连接检查脚本不会代替 OpenClaw 宿主解析密钥。排查连接时请先在当前 shell 中解析出真实 secret，再用 `--client-id` / `--client-secret` 或 `-ClientId` / `-ClientSecret` 显式传入；插件运行时会把引用交给宿主配置的 SecretInput provider。

## 关键后台检查项

- 应用是企业内部应用
- 已发布，不是草稿
- 可见范围为全员员工
- 已启用机器人能力
- 消息接收方式为 `Stream`

## 详细手册

更完整的阶段性排查说明请直接阅读：

- 中文详版：[connection.zh-CN.md](connection.zh-CN.md)
- English version: [connection.en.md](connection.en.md)
