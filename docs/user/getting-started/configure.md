# 配置

OpenClaw 支持交互式配置和手动配置文件两种方式。推荐优先使用交互式配置。

## 方式 1：交互式配置

```bash
openclaw onboard
```

或者：

```bash
openclaw configure --section channels
```

配置流程通常包括：

1. 选择 `dingtalk`
2. 选择注册方式：自动注册（显示授权 URL，扫码授权后自动获取凭证）或手动输入
3. 如果选择自动注册，按提示访问显示的授权 URL 完成钉钉扫码授权即可自动获取 `Client ID` / `Client Secret`
4. 如果选择手动输入，输入 `Client ID` 和 `Client Secret`
5. 确认凭证与钉钉开放平台一致（`clientId` 同时用作钉钉 API 中的 robot code；无需单独填写企业 ID 或钉钉应用 ID）
6. 选择消息模式
7. 选择私聊与群聊策略

## 方式 2：手动配置文件

在 `~/.openclaw/openclaw.json` 中配置。

最小示例：

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "messageType": "markdown"
    }
  }
}
```

如果不想把 `Client Secret` 直接写入配置文件，可以把 `clientSecret` 写成 SecretInput 引用。插件仍然兼容普通字符串；引用只在运行时需要真实密钥时解析。

环境变量示例：

```json5
{
  "secrets": {
    "providers": {
      "env": {
        "source": "env",
        "allowlist": ["DINGTALK_CLIENT_SECRET"]
      }
    }
  },
  "channels": {
    "dingtalk": {
      "clientId": "dingxxxxxx",
      "clientSecret": {
        "source": "env",
        "provider": "env",
        "id": "DINGTALK_CLIENT_SECRET"
      }
    }
  }
}
```

本地文件示例：

```json5
{
  "secrets": {
    "providers": {
      "local": {
        "source": "file",
        "path": "~/.config/openclaw/dingtalk-client-secret",
        "mode": "singleValue"
      }
    }
  },
  "channels": {
    "dingtalk": {
      "clientId": "dingxxxxxx",
      "clientSecret": {
        "source": "file",
        "provider": "local",
        "id": "value"
      }
    }
  }
}
```

插件把 SecretInput 交给 OpenClaw 宿主解析；文件路径来自 `secrets.providers`，不会把 `clientSecret.id` 当作路径读取。修改 provider 指向的文件后，建议重启 gateway，让 Stream 连接使用新的凭据。

卡片模式示例：

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "cardStreamingMode": "answer",
      "cardStreamInterval": 1000
    }
  }
}
```

手动修改后需要重启：

```bash
openclaw gateway restart
```

## 配置建议

- 大多数场景先从 `messageType: "markdown"` 开始
- 如果需要流式可视化回复，再切到 `card`
- 对高风险投递场景优先使用显式 ID，而不是显示名解析

## 深入参考

- [配置项参考](../reference/configuration.md)
- [安全策略](../reference/security-policies.md)
- [回复模式](../features/reply-modes.md)
