# 架构说明

English version: [`architecture.en.md`](architecture.en.md)

本文档是 `openclaw-channel-dingtalk` 的模块职责边界、增量演进规则与架构协作约定的权威来源。

它面向维护者、贡献者以及在本仓库内工作的 AI / 代码代理使用。当 `README.md`、`AGENTS.md` 或 `CONTRIBUTING*` 中出现架构摘要时，以本文和 [`architecture.en.md`](architecture.en.md) 为准。

## 目标

- 在仓库持续演进、并且存在多个进行中 PR 的情况下，保持功能增长可控。
- 在做大规模物理迁移之前，先明确新代码应该落在哪类模块。
- 降低 `src/` 根目录持续扩散、边界被侵蚀的风险。
- 在不改变既有运行时行为的前提下，支持渐进式重构。

## 工作规则

遵循 **先逻辑分区，后物理迁移**。

这意味着：

- 即使现有文件仍平铺在 `src/` 下，新功能也应先遵守本文定义的逻辑领域边界。
- 现有文件不需要为了“先满足目标目录结构”而强制搬迁。
- 修改旧代码时，优先做能改善边界的小步重构，而不是顺手做大规模结构改写。
- 大范围文件移动应尽量与行为改动拆分到不同 PR 中。

## 核心原则

1. `src/channel.ts` 是装配根。
   它负责 runtime、gateway、outbound 入口和公共导出，不应持续吸收新的业务逻辑。
2. 领域模块应只回答一类问题。
   除非职责天然不可拆分，否则不要在同一模块中混合路由、持久化、目标解析和发送策略。
3. 避免新的“杂物间”。
   不要默认把新逻辑继续塞进 `utils.ts`、`helpers.ts` 或新的根级 `*-service.ts`，除非它确实是跨领域复用能力。
4. 目标解析优先走确定性数据源。
   例如 `conversationId` 这类 ID，必须来自平台回调、持久化索引或明确的人为输入，不能靠模型猜测。
5. 保持已有低层模块边界稳定。
   已经职责明确的模块，应维持聚焦，而不是继续吸收相邻语义。

## 宿主版本感知行为

维护 DingTalk 插件时，还需要区分“插件主动实现的行为”和“宿主升级后自动生效的行为”。

- `before_agent_reply`：
  这是宿主 reply runtime 的 hook。DingTalk 只要继续走宿主 reply 分发链，升级到支持该 hook 的 OpenClaw 后就会自动进入这条链路，不需要插件单独接线。
- `audioAsVoice`：
  这是共享 outbound / reply payload 语义，不应再依赖 DingTalk 私有字段名或仅靠扩展名碰巧推断成功。相关兼容逻辑应放在 `messaging/` 领域。
- `contextVisibility`：
  这是宿主 channel-level 配置语义。插件需要在自己的 schema、manifest、setup / 文档中把它显式暴露出来，否则宿主虽然支持，DingTalk 通路仍然无法稳定消费。
- `taskFlow`：
  当前仓库不直接消费 `runtime.taskFlow`。除非要专门解决 AI Card run / stop 生命周期的跨阶段状态问题，否则不要把普通 reply 主路径硬迁到 TaskFlow。
- sub-agent session key：
  在当前宿主版本基线下，应直接依赖宿主提供的 `buildAgentSessionKey` helper，而不是继续在插件里拼接 fallback key，避免路由语义漂移。

## 逻辑领域

无论仓库当前是否已经物理重排，代码都应优先按以下逻辑领域理解和演进。

### Gateway

负责：

- Stream 客户端生命周期
- 回调注册与 ack
- 入站事件入口
- runtime 启停时序

示例：

- `src/channel.ts`
- `src/inbound-handler.ts`
- `src/connection-manager.ts`

不负责：

- 长期目标目录语义
- 与入站投递无关的跨功能持久化结构
- 通用目标查找规则

### Targeting

负责：

- `conversationId` 与 sender/group 身份处理
- session peer 解析
- 大小写敏感 ID 恢复
- 后续群目录和目标 alias 解析能力

示例：

- `src/session-routing.ts`
- `src/session-peer-store.ts`
- `src/peer-id-registry.ts`

不负责：

- 出站消息格式与投递策略
- AI Card 生命周期
- command 领域持久化

### Messaging

负责：

- 入站消息内容提取
- reply strategy 选择
- 文本 / markdown / media 出站发送
- 短生命周期消息上下文持久化

示例：

- `src/message-utils.ts`
- `src/send-service.ts`
- `src/reply-strategy*.ts`
- `src/message-context-store.ts`
- `src/media-utils.ts`

### Card

负责：

- AI Card 创建 / 流式更新 / 结束态流程
- 待恢复卡片状态与缓存
- 卡片特有的 fallback 行为
- v2 block 渲染、draft 流控、run usage 记录

示例：

- `src/card-service.ts`
- `src/card-callback-service.ts`
- `src/card-draft-controller.ts`
- `src/draft-stream-loop.ts`
- `src/run-usage-store.ts`

### Command

负责：

- slash 命令解析与分发相关领域逻辑
- feedback learning 策略与持久化
- 目标级规则与 target set
- 后续各类扩展 slash 命令能力

示例：

- `src/learning-command-service.ts`
- `src/feedback-learning-service.ts`
- `src/feedback-learning-store.ts`

### Platform

负责：

- 配置解析与 schema
- 认证与 token 缓存
- runtime getter / setter
- 共享 logger context
- 公共类型定义
- setup wizard 与设备自动注册

示例：

- `src/config.ts`
- `src/config-schema.ts`
- `src/auth.ts`
- `src/runtime.ts`
- `src/logger-context.ts`
- `src/types.ts`
- `src/device-registration.ts`
- `src/onboarding.ts`

## 计划中的目录结构

下面的目录结构是后续渐进迁移的目标态，用于指导新代码落位，不表示需要立即完成整体搬迁。

```text
src/
  channel.ts

  gateway/
    inbound-handler.ts
    connection-manager.ts

  targeting/
    session-routing.ts
    session-peer-store.ts
    peer-id-registry.ts
    group-directory-store.ts
    group-target-resolver.ts

  messaging/
    send-service.ts
    message-utils.ts
    media-utils.ts
    message-context-store.ts
    reply-strategy.ts
    reply-strategy-card.ts
    reply-strategy-markdown.ts
    reply-strategy-with-reaction.ts

  card/
    card-service.ts
    card-callback-service.ts
    card-draft-controller.ts
    draft-stream-loop.ts
    run-usage-store.ts

  command/
    learning-command-service.ts
    feedback-learning-service.ts
    feedback-learning-store.ts

  platform/
    auth.ts
    config.ts
    config-schema.ts
    runtime.ts
    logger-context.ts
    types.ts
    device-registration.ts
    onboarding.ts

  shared/
    persistence-store.ts
    dedup.ts
    utils.ts
```

说明：

- `src/channel.ts` 继续作为装配根和底层公共导出入口。
- 即使相邻旧文件还没有迁移，新模块也应优先参考这套领域结构落位。
- 现有文件不需要为了“对齐目录”而强制搬迁，除非这次改动本身确实能显著改善边界或降低耦合。
- `group-directory-store.ts`、`group-target-resolver.ts` 这类文件表示的是计划中的能力落点，不代表当前仓库已经存在这些文件。

## 重要既有边界

下面这些边界已经形成，应继续保持稳定。

### `peer-id-registry.ts`

用途：

- 当上游 session key 或输入把 DingTalk peer ID 小写化后，恢复其原始大小写

负责：

- `lowercased-id -> original-id` 恢复
- 观测到的 ID 的内存注册

不负责：

- 读取 OpenClaw agent session 文件
- 群显示名查找
- 人工 alias 存储
- `conversationId -> title` 目录状态
- 模糊目标匹配

### `session-peer-store.ts`

用途：

- 持久化 session peer override，用于合并或重定向 OpenClaw 的会话身份

负责：

- `sourceKind + sourceId -> logical peerId` override
- 由 owner 命令控制的会话共享行为

不负责：

- DingTalk 目标发现
- `groupDisplayName -> conversationId` 查找
- 群元数据目录
- 面向自然语言标签的出站目标解析

### 后续目标目录能力

凡是涉及以下解析能力：

- `groupDisplayName -> conversationId`
- `manual alias -> conversationId`
- 历史群名变更追踪

都应进入独立的 targeting 模块，例如：

- `src/group-directory-store.ts`
- `src/group-target-resolver.ts`

不要把这些职责继续塞进 `peer-id-registry.ts` 或 `session-peer-store.ts`。

## 新代码落位规则

新增代码时，遵循以下规则：

- 如果代码解决的是“这条消息指向哪个目标”，它属于 targeting
- 如果代码解决的是“目标已确定后如何发送”，它属于 messaging 或 card
- 如果代码只是负责模块装配，就放在 `src/channel.ts`，并保持轻量
- 如果一个模块同时开始承担“入站 payload 解析”和“持久化检索索引”，应考虑拆分职责
- 如果某个 helper 只对一个领域有意义，应留在该领域内，而不是上提到全局工具文件

## 渐进迁移策略

当前仓库在 `src/` 下仍有较多根级文件，这是过渡期内可接受的状态。

迁移策略如下：

- 不要求贡献者为了交付一个 bug fix 先做全仓文件搬迁
- 新功能应尽量沿着本文定义的目标边界落位
- 只要不会明显扩大 PR 范围，欢迎做机会式的小幅边界整理
- 文件迁移与行为改动最好拆成不同 PR
- 不应仅因为仓库尚未完成物理重排，就阻塞进行中的 PR

## Review Checklist

在评审或发起 PR 时，可以先问：

1. 这次改动是否把新的业务逻辑继续塞进了 `src/channel.ts`？
2. 这份新持久化状态本来属于某个既有领域，还是只是被挂到了“离得最近”的文件上？
3. 某个目标解析功能是否被错误地放进了 session 共享或大小写恢复模块？
4. 这次改动是否又引入了一个泛化 helper 文件，掩盖了领域边界缺失？
5. 这个行为是否可以通过新增一个小模块来实现，而不是继续放大一个无关模块？

## 测试文件维护

测试文件应遵循与源码相同的领域边界原则。

### 规模阈值

| 行数 | 处理 |
|------|------|
| <500 | 正常，无需处理 |
| 500-800 | 规划拆分，可在后续工作中执行 |
| >800 | 必须拆分后再合并 |

### 拆分策略

1. **识别功能域** — 按被测功能分组（如 quote handling、card lifecycle）
2. **提取共享 mock** — 在 `tests/unit/fixtures/` 创建 fixture 模块
3. **按域拆分** — 创建 `source-module-{domain}.test.ts`，每个文件 10-25 个测试
4. **保留核心流程** — 端到端 pipeline 测试留在主文件
5. **清理冗余** — 拆分前合并重复验证相同行为 ≥3 次的测试

### 命名规范

- 拆分文件：`inbound-handler-quote.test.ts`、`send-service-media.test.ts`
- Fixture 文件：`tests/unit/fixtures/inbound-handler-fixture.ts`

## 相关入口

- `README.md`
- `CONTRIBUTING.md`
- `CONTRIBUTING.zh-CN.md`
- `AGENTS.md`
