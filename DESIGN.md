# dsh-time-reminder 设计

> DSH 插件。给模型一只**可调精度**的时钟，外加**会话内计时器**（计数器）。
> 目标 profile：**web**（桌面端后补）。

## 为什么要自己写

DSH 0.2.0 自带 `@deepseek-ai/dsh-time-context`，但它有两条硬限制：

1. **不提供任何工具**（`lib/index.js` 只注册 `agent/pre-step` 监听，导出 `Config/apply/inject/name`）；
2. **`refreshIntervalMs` 在 `apply` 里被闭包捕获**（`const refreshIntervalMs = config.refreshIntervalMs ?? 6e5`），
   会话中改不了——想切换精度只能改 profile 的 `cordis.patch.yml`。

所以本插件不做官方那行的包装，而是**自己实现注入与工具**，官方那行在本 profile 里禁用，避免两处重复注入。

## 三种时间模式（每会话独立，落盘持久化）

| 模式 | 行为 | 场景 |
|---|---|---|
| `cron`（默认） | 跨过 cron 触发时刻就注入一次；默认 `0 0 * * *`（每天 00:00，按浏览器时区） | 日常：模型知道"今天几号、大概几点" |
| `off` | **只关自动注入**；`time_*` 工具照常可用 | 只在需要时手动查时间/计时 |
| `fine` | **每个合格步骤都注入** | 精确计时、要步间耗时 |

`off` 不冻结计时器——计数器照常走，工具随时可查。

## 计数器（计时器）

一个计数器 = 一个基准时刻 + 描述 + 一组可见性属性。只存在于**本会话**的状态里（随会话日志持久化）。

```yaml
counters:
  - name: deploy
    startedAt: 1789125494884
    note: 开始部署
    inject: false           # 是否随时间注入到每步读数
    scope:
      toChildren: true      # 子代理可见
      toParents: false      # 父代理可见
      depth: 2              # 沿 parentSession 穿透几代（1 = 直接父子，2 = 也含祖孙）
```

**默认值均为保守**：只向下暴露两代、不向上暴露、不注入。

父子可见性沿 `session.header.parentSession` 上溯、`ctx.sessions.list()` 下探，`depth` 限代数。
同名时**近者胜**（自己的计数器永远遮蔽继承来的）。

## 状态如何落盘

每会话状态（模式 + 计数器）**不能只存在投影里**：投影从事件重放必须能推出同样的状态。
所以每次状态变更都追加一条自定义会话事件：

```
time-reminder/state   data: { mode, counters }
```

投影 `time-reminder` 消费该事件重建状态（`init` 用配置默认值）。这样：

- 会话日志自足 ⇒ 可重放、可审计；
- 恢复会话后模式与计时器仍在；
- 注入的消息走 `createUserMessage` + 快照来源，满足"模型可见 ⟺ 已落盘"。

## 注入读数形状

每个合格步骤追加一条 user 角色消息（连同请求末尾，**不破坏 KV 前缀**）：

```
Time sampled while preparing turn 12, step 3: 2026-10-09T01:23:45+08:00[Asia/Shanghai]
Time mode: cron (daily 00:00 Asia/Shanghai; last 2026-10-08T00:00:03+08:00)
Elapsed since the preceding model-visible message: 187s
[counters] deploy=1243s (开始部署)
```

最后一行只在**有计数器要求注入**时出现。

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `time_mode` | `mode: off \| cron \| fine`，可选 `cron`（cron 表达式） | 切换精度；写一条状态事件 |
| `time_counter` | `action: list \| start \| lapse \| note \| reset \| set` | 建/查/改计时器；属性（注入、跨会话、父子可见、层数）在调用时设置 |

`lapse` 返回该计数器自基准以来的时长；`set` 改属性。

## 与官方并存

web profile 里：

```yaml
- id: time-context
  disabled: true            # 官方那行的 id（需按 bundle 实际 id 填）
- insert:
    - id: time-reminder
      name: 'dsh-time-reminder'
      config: { … }
```

禁用官方是**必须**的：两处都在 `agent/pre-step` 追加读数，都开就是每步两条。

## 复用而非手搓

cron 解析用 `@deepseek-ai/dsh-schedule` 的 `parseCronInput` / `canonicalizeCronExpression` /
`resolveCronOccurrence` / `resolveDailyOccurrence`——DSH 自己已测试过，不重写。
时区统一走 `Intl.DateTimeFormat` 的 `resolvedOptions().timeZone` 规范化。

## 已知限制

- **`refreshIntervalMs` 式的节流在 `fine` 下不存在**：每步一条读数，会累积到压缩遮蔽为止（token 成本）。
- **跨会话计数器不进日志**：历史回放时它的取值无法重建（只有会话内计数器可重建）。
- **cron 判定用挂钟**：系统时间回拨可能导致同一触发点重复注入或漏注入；判定记录的是"上次注入时刻"。
- 桌面端 profile 尚未挂载。
