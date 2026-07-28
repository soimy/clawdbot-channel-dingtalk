# 配置项参考

本页汇总常用配置项及其作用。更完整的场景说明请结合功能页一起阅读。

## 主要配置项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用插件 |
| `clientId` | string | 必填 | 钉钉 AppKey；同时作为钉钉 API 请求中的 `robotCode` |
| `clientSecret` | string \| SecretInput | 必填 | 钉钉 AppSecret；可直接填写字符串，也可引用环境变量或文件 |
| `dmPolicy` | string | `open` | 私聊策略 |
| `groupPolicy` | string | `open` | 群聊策略 |
| `allowFrom` | string[] | `[]` | 私聊白名单 |
| `groupAllowFrom` | string[] | - | 群聊发送者白名单 |
| `groups` | object | - | 群级配置 |
| `displayNameResolution` | string | `disabled` | 是否允许基于本地目录做显示名解析 |
| `contextVisibility` | string | 宿主默认值 | 是否限制宿主补充上下文、引用上下文与历史上下文的可见性 |
| `bypassProxyForSend` | boolean | `false` | 发送链路是否绕过全局代理 |
| `learningEnabled` | boolean | `false` | 是否开启学习信号采集 |
| `learningAutoApply` | boolean | `false` | 是否自动注入学习结果 |
| `learningNoteTtlMs` | number | `21600000` | 会话级学习笔记 TTL |
| `mediaUrlAllowlist` | string[] | `[]` | 允许下载的远程媒体目标 |
| `journalTTLDays` | number | `7` | 引用回溯日志保留天数 |
| `ackReaction` | string | - | 原生处理中表情反馈 |
| `messageType` | string | `markdown` | 回复模式：`markdown` 或 `card` |
| `cardTemplateId` | string | - | 已弃用。AI 卡片模板 ID 由预置模板固定，如需覆盖可通过环境变量 `DINGTALK_CARD_TEMPLATE_ID` |
| `cardTemplateKey` | string | `content` | 卡片内容字段名 |
| `cardStreamingMode` | string | `off`（生效值） | 卡片流式模式：`off` / `answer` / `all` |
| `cardStreamInterval` | number | `1000` | 卡片实时更新节奏（毫秒，最小 `200`） |
| `cardAtSender` | string | - | 群聊中卡片完成后追加 @发送者 的消息文本；非空时生效 |
| `cardRealTimeStream` | boolean | `false` | 已弃用；仅兼容旧配置，`true` 会回退到 `cardStreamingMode: all` |
| `aicardDegradeMs` | number | `1800000` | 卡片连续失败后的降级时间 |
| `debug` | boolean | `false` | 是否输出调试日志 |
| `mediaMaxMb` | number | - | 入站媒体大小上限 |
| `maxConnectionAttempts` | number | `10` | 最大连接重试次数 |
| `initialReconnectDelay` | number | `1000` | 初始重连延迟 |
| `maxReconnectDelay` | number | `60000` | 最大重连延迟 |
| `reconnectJitter` | number | `0.3` | 重连抖动因子 |

## 关于 `clientId` 与钉钉 `robotCode`

钉钉开放接口的请求体里仍会携带 `robotCode` 字段。本插件不提供单独的 `robotCode`、`corpId` 或钉钉应用 `agentId` 配置项：`clientId` 会作为机器人代码用于相关 API 调用。

## 关于 `clientSecret` 与 SecretInput

`clientSecret` 可以继续使用普通字符串：

```json5
{
  "clientId": "dingxxxxxx",
  "clientSecret": "your-app-secret"
}
```

也可以使用 SecretInput 引用：

```json5
{
  "clientId": "dingxxxxxx",
  "clientSecret": {
    "source": "env",
    "provider": "env",
    "id": "DINGTALK_CLIENT_SECRET"
  }
}
```

SecretInput 对象字段：

| 字段 | 说明 |
| --- | --- |
| `source` | 密钥来源：`env` 或 `file` |
| `provider` | `secrets.providers` 中已配置的宿主 provider 名称 |
| `id` | provider 内的密钥标识；`env` 为允许的环境变量名，`file` 的 `singleValue` 模式固定为 `value` |

> **注意**：v3.6.2 起，`source` 只支持 `env` 和 `file`，不再支持 `exec`（已移除进程执行路径以通过 OpenClaw 安装安全扫描）。

语法限制：

- `provider` 不能为空，最长 `1024` 字符，不能包含 `:` 或 `>`
- `id` 不能为空，最长 `1024` 字符，不能包含 `>`
- provider 的路径、权限和允许范围由 OpenClaw 宿主配置管理

解析时机：

- 获取 DingTalk access token 时，如果 token 缓存未命中，会解析 `clientSecret`
- 启动 Stream 连接时，会为每个账号解析一次运行时凭据
- 状态展示、配置向导展示等路径只显示规范化引用，不会解析密钥
- 运行时解析统一委托给 OpenClaw SecretInput provider

安全边界：

- 插件不会把 SecretInput 的 `id` 当作环境变量或本地路径直接读取
- 环境变量 allowlist、文件路径和访问策略由 `secrets.providers` 控制

如果 SecretInput 解析失败，插件会在发起 DingTalk API 请求前抛出本地错误，并在日志中带上 `source` / `provider` / `id` / 失败原因，方便定位配置问题。

## 关于 `displayNameResolution`

- `disabled`：默认值，只允许显式 ID
- `all`：允许本地学习目录参与群名和显示名解析

启用后要注意两类风险：

- 误投风险：重名、改名、旧目录数据都可能导致误解析
- 权限扩散风险：当前没有 owner-only 粒度

对敏感通知和不可撤回消息，建议优先使用显式 ID。

## 关于 `contextVisibility`

- `all`：沿用宿主当前的补充上下文行为
- `allowlist`：只保留宿主 allowlist 范围内的补充上下文
- `allowlist_quote`：优先保留显式引用 / 回复上下文，同时过滤额外补充上下文

如果你只想让模型看到“用户明确引用的那条消息”，通常 `allowlist_quote` 是最稳妥的高级模式。

它和 `displayNameResolution` 的职责不同：

- `contextVisibility` 控制“宿主把多少上下文送进 reply runtime”
- `displayNameResolution` 控制“插件是否允许根据本地学习目录解析群名或显示名”

前者影响模型可见上下文，后者影响目标解析与投递安全；两者不要混用。

## 关于 `ackReaction`

启用后，插件会在处理开始时对用户原消息添加原生文本表情反馈，处理结束后自动撤回。

常见配置：

- `""`：关闭
- `"🤔思考中"`：固定“思考中”
- `"emoji"`：使用固定 emoji 模式
- `"kaomoji"`：按输入语气选择颜文字

## 关于 `cardStreamingMode` / `cardRealTimeStream` / `cardStreamInterval`

- `cardStreamingMode=off`：关闭答案实时流式，增量更新最少。
- `cardStreamingMode=answer`：只实时推送答案内容。
- `cardStreamingMode=all`：答案片段实时推送到 content key；思考/工具内容实时更新 block 列表，答案在边界或结束时固化到 block 列表。
- `cardRealTimeStream` 已弃用，仅保留兼容：
- 未设置 `cardStreamingMode` 且 `cardRealTimeStream=true` 时，生效为 `all`。
- 同时设置时，以 `cardStreamingMode` 为准。
- `cardStreamInterval` 控制实时更新节奏（毫秒），在 `answer` / `all` 下生效；值越小，更新越频繁，API 调用通常越高。

## 关于连接参数

连接相关配置用于提升 Stream 连接鲁棒性：

- 最大尝试次数
- 指数退避延迟
- 随机抖动
- 发送链路代理绕过

## 关于上游群聊默认行为

OpenClaw 2026.5.7 之后，群聊默认 `messages.groupChat.visibleReplies=message_tool` 会将 source reply delivery 解析为 `message_tool_only`。这对普通群聊消息是合理默认，但 DingTalk 插件的 card / markdown / sessionWebhook strategy 本身就是可见回复承载面。

插件已从 v3.6.2 起在 card 和 markdown/sessionWebhook reply strategy 中显式声明 `sourceReplyDeliveryMode: "automatic"`（PR #553、PR #565），确保 final answer 回到正确的回复策略路径，不会被上游默认值误导向 message tool。

**用户无需额外配置**。如果你在群聊中观察到回复丢失或出现空卡片 + 额外 fallback 消息，请确认插件版本不低于 v3.6.2。

## 相关文档

- [配置](../getting-started/configure.md)
- [安全策略](security-policies.md)
- [AI 卡片](../features/ai-card.md)
