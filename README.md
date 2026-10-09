# dsh-time-reminder

给 DSH 的模型一只**可调精度**的时钟，外加**会话内计时器**。

## 解决什么

模型默认不知道"现在几点"，也不知道"距上一轮结束过了多久"。长时间干活时这让它无法判断
"这次等了 20 秒"还是"等了 20 分钟"。官方 `@deepseek-ai/dsh-time-context` 能做基础注入，但
**不提供工具**、且刷新间隔在加载时被闭包固定，会话中改不了。本插件把控制权交给模型和你。

## 三种时间模式（每会话独立，随会话日志持久化）

| 模式 | 行为 | 用途 |
|---|---|---|
| `cron`（默认） | 跨过 cron 触发时刻注入一次；默认 `0 0 * * *`（每天 00:00，按你的浏览器时区） | 日常：知道今天几号、大概几点 |
| `off` | **不自动注入**；工具照常可查时间与计时器 | 上下文要干净时 |
| `fine` | **每个步骤都注入**（含每次工具调用之后） | 精确计时、要步间耗时 |

## 工具

```
time_mode     mode: off | cron | fine        可选 cron: "<表达式>"
              切换精度；cron 表达式按会话时区解释

time_counter  action: start | lapse | list | note | scope | reset | remove
              name, note, inject, crossSession, toChildren, toParents, depth
              建/查/改计时器；可见性属性在调用时设置
```

`time_counter` 的属性：

| 属性 | 默认 | 含义 |
|---|---|---|
| `inject` | `false` | 是否加入每次自动读数 |
| `crossSession` | `false` | 是否让**其它会话**也能读到（给"同一件事开多个会话并行"的场景） |
| `toChildren` | `true` | 是否让**子代理**读到 |
| `toParents` | `false` | 是否让**父代理**读到 |
| `depth` | `2` | 可见性沿谱系穿透**几代**（1 = 直接父子，2 = 也含祖孙） |

## 注入读数长这样

```
Time sampled while preparing turn 12, step 1: 2026-10-09T01:23:45+08:00[Asia/Shanghai]
Time mode: cron (daily 00:00 Asia/Shanghai; previous reading 2026-10-08T00:00:03+08:00[Asia/Shanghai])
Elapsed since the preceding model-visible message: 3m7s
[counters] deploy=20m43s (开始部署)
```

第一行是时刻；第二行说明当前精度与"上次读数"（可追溯）；第三行是距上一条模型可见消息的间隔
（第 1 步）或距上一条读数的间隔（后续步）。第四行只在有计数器开了 `inject` 时出现。

## 挂载

```yaml
- id: time-context          # 官方那行必须禁用，否则每步会有两条读数
  disabled: true
- insert:
    - id: time-reminder
      name: 'dsh-time-reminder'
      config:
        defaultMode: cron          # off | cron | fine
        cron: '0 0 * * *'          # 默认每天 00:00
        timeZone: Asia/Shanghai    # 缺省时用浏览器时区，再缺省用进程时区
        fineIntervalMs: 0          # fine 模式的最小间隔；0 = 每步都注入
```

## 设计要点

- **状态落盘**：模式与计时器通过自定义会话事件 `time-reminder/state` 提交（每次提交携带完整状态），
  因此投影可由折叠日志重建，恢复会话后状态仍在。
- **满足"模型可见 ⟺ 已落盘"**：注入走 `createUserMessage` + 插件快照来源。
- **不破坏 KV 前缀**：读数追加在请求消息末尾。
- **不手搓 cron**：`dsh-schedule` 的完整实现是私有工作区包、插件解析不到，所以本仓库自带一个
  最小实现（`src/cron.ts`，支持 `*`、字面量、`a-b`、`a-b/n`、列表与 `@daily` 等宏）。

## 已知限制

- `fine` 模式每步一条读数，会累积到被压缩遮蔽为止（token 成本）——这也是它默认不启用的原因。
- `crossSession: true` 的计数器**不进会话日志**，历史回放时无法重建其当时取值。
- cron 判定用挂钟：系统时间回拨可能导致同一触发点重复注入或漏注入。
- 桌面端 profile 尚未挂载；目前只在 web profile 开发。

## 开发

```sh
node --test tests/cron.test.ts tests/reading.test.ts
```

测试只覆盖纯逻辑模块（`cron.ts` / `reading.ts`），不依赖 DSH 运行时。
`src/index.ts` 与 `src/visibility.ts` 需要 DSH 的 peer 依赖才能类型检查，目前尚未接入。
