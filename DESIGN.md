# dsh-time-reminder 设计

> DSH 插件。给模型一只**可调精度**的时钟，外加**会话内计时器**（计数器）。
> 目标 profile：**web**（桌面端后补）。

## 为什么要自己写

DSH 0.2.0 自带 `@deepseek-ai/dsh-time-context`，但它有两条硬限制：

1. **不提供任何工具**（`lib/index.js` 只注册 `agent/pre-step` 监听，导出 `Config/apply/inject/name`）；
2. **`refreshIntervalMs` 在 `apply` 里被闭包捕获**（`const refreshIntervalMs = config.refreshIntervalMs ?? 6e5`），
   会话中改不了——想切换精度只能改 profile 的 `cordis.patch.yml`。

所以本插件不做官方那行的包装，而是**自己实现注入与工具**，官方那行在本 profile 里禁用，避免两处重复注入。

## 四种时间模式（每会话独立，落盘持久化）

| 模式 | 行为 | 场景 |
|---|---|---|
| `cron`（默认） | 跨过 cron 触发时刻就注入一次；默认 `0 0 * * *`（每天 00:00，按浏览器时区） | 日常：模型知道"今天几号、大概几点" |
| `off` | **只关自动注入**；`time_*` 工具照常可用 | 只在需要时手动查时间/计时 |
| `turn` | **每轮恰好一次**，在该轮第一步（用户消息之后那一步），报"距上一条模型可见消息"的间隔 | 每轮都要知道"距上轮结束多久"，但不想每步都注入 |
| `fine` | **每个合格步骤都注入** | 精确计时、要步间耗时 |

`off` 不冻结计时器——计数器照常走，工具随时可查。

粒度实测（10 个真实会话、1563 轮、29624 步）：平均每轮 **18.95 步**，其中 94.6% 的步紧跟工具结果、
仅 2 步紧跟用户消息。因此 `turn` 是"每轮 1 条"，`fine` 是"每轮约 19 条"。

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

⚠️ **这两个开关的方向曾经装反**（2026-10-09 实机挖出，已修）：实现里"子看父"错误地读祖先的
`toParents`、"父看子"错误地读后代的 `toChildren`，于是默认姿势变成**向上暴露、向下隐藏**，与本
文件的"只向下暴露两代"正好相反。单元测试当时是照实现写的，33 条全绿也没拦住它——只有实机能判别
（`toChildren=true, toParents=false` 的计数器子代理看不到、`toChildren=false, toParents=true` 的
父看不到，而两个都开就都能看到）。修法是两处条件互换；用例语义跟着翻，并新增 `pushTargets` 用例。

## 计数器变动的推送

**任何会改动计数器的动作**（`start`/重启、`reset`、`note`、`scope`、`remove`）都要让"看得见它"的
会话立刻知道，而不是等它们下一次读数。只读动作（`lapse`/`list`）不推。

- **收件人 = 变更前后可见集合的并集**：`scope` 收窄或 `remove` 时，原来看得见的会话也要收到"它走了"
  （`pushTargets` 对新旧两份计数器各算一次，按会话 id 去重）。
- **投递走宿主的 inbox 缝**：`ctx.agents.get(id)` 拿到对方 Agent，再
  `inject(message)`（投到下一个 pre-step、**不唤醒**，默认）或 `steer(message)`（投到最近一步并唤醒
  idle 的对方）。配置项 `counterNotice: inject | steer | off`，默认 `inject`——不会把已经收工的
  子代理重新吵醒。对方不在驻留中时投不进去，跳过即可（它的状态本来就从日志折叠）。
- **来源必须是 `form: 'relay'` + `senderSessionId`**：折叠只把 `form: 'notice'` 的消息当读数，
  否则这条通知会被当成"我刚读过时间"，把收件人的 cron 判定与 turn 节奏带偏。
- 通知正文由 `counterNoticeText` 生成（纯函数、可单测），套 `<system-reminder>` 框后投递。

## 倒计时（`time_countdown`）

一次性定时器：`in`（相对时长）或 `at`（会话时区里的钟点，二者给且只给一个），到点做一件事。

- **默认 `wake`，不是 `inject`**：倒计时的意义是"到点让事情发生"，而空闲会话不主动跑——
  `inject` 只是把通知排进它下一步（可能永远等不到），`wake`（`agent.steer`）才会把它拉起来开一轮。
  想省 token 的场合可以显式选 `inject`。
- **触发凭据 = 那条通知本身**：通知来源带 `countdown` 标记（仍复用 `form: 'notice'`，因为它是"刚刚发生
  的一件事"，客户端折叠行也需要 `summary`）。折叠看到它就给该倒计时盖上 `firedAt`，
  于是重启不会重复触发，插件也不需要第二个存储，更不需要自造事件类型。
- **通知绝不能算读数**：`foldUserMessage` 先查 `countdown` 标记再查 `form`——有标记就是"某倒计时已触发"，
  没有才按读数记 `lastInjectionAt`。否则一次触发会顺手重置 cron/turn 节奏（这与推送通知用 `relay`
  是同一类防护）。
- **`at` 只在配置时区里解析**：折叠没有请求可读浏览器时区，若工具按浏览器时区、折叠按配置时区，
  两者会算出不同的触发点，重启后就会重排一个已经触发过的倒计时。所以两条路径都用配置时区
  （折叠把它当**入参**，见 `applySessionEvent(state, event, timeZone)`，而不是读环境）。
- **定时器全部是重建出来的，不是持久化的**：宿主不存任何 job。三条重建路径——
  插件装载时遍历驻留会话、会话每一步（pre-step）、以及每 60 秒的兜底扫描（覆盖"装载时投影还没驱动"
  的会话）。超过 `setTimeout` 上限（≈24.8 天）的倒计时分段续排。
- **错过的会补发**：装载时若 `firesAt` 已过，立即触发并在通知里写明迟了多久——模型若以为提醒是准时的
  就会把后续安排算错。失败方向是**至少一次**（已投递但触发凭据尚未落盘的窗口里崩溃会重复一次），
  与官方会话日志上传同一取向：宁可重复，绝不静默跳过。
- **推迟原因必须"观察"，不能"推断"**：第一版把 `lateMs > 0` 当作"宿主没在运行"的证据，实测两次全是误判——
  定时器只迟了几十毫秒（`formatDuration` 还把它渲染成误导性的 `0s late`），真正让通知晚到的是
  **会话自己正卡在一个 155 秒的工具调用里**，通知只能等那一步结束。现在三个原因各有独立观测量：
  武装时 `firesAt` 已过（补发）／回调迟到 ≥2s（进程被挂起或阻塞）／触发时 `agent.status === 'running'`
  （会话在途，通知等步边界）。三者正交、可同时成立；都不成立时通知**不加任何解释**。
- **冷会话靠 `sessionController.resolveAgent` 恢复**：`sessions.list()` 只列活会话、`sessions.get()`
  不按需恢复，所以"宿主重启后把冷会话叫醒"必须另找一条缝——官方给的那条缝就是 Host Web 会话控制器的
  `resolveAgent`（文档原话 "Resolve **or resume** one ordinary Session for another Host API domain"），
  `dsh-schedule` 的投递正是走它（`schedule/src/runtime.ts:101`）。本项目按同一办法做：触发时若
  `ctx.agents.get(id)` 取不到 Agent，就 `ctx.get('sessionController')?.resolveAgent(id)` 再回注册表取一次。
  它是**可选服务**，所以走 `ctx.get` 而不是声明注入（仓库约定：可选服务用 `ctx.get`），
  也因此在没有它的组合里（headless / 纯 SDK）倒计时只能等会话自己变活。
  ⚠️ 实测补充（2026-10-11 调试日志）：**它可能比本插件挂得晚**。冷启动时插件加载那一刻
  `verdict:"no-controller"`，20 秒后会话才由**客户端重连**恢复，投递虽成功但 `resumedHere:false`
  ——不是我们做的。因此又注册了 `ctx.inject(['sessionController'], …)`：服务一出现就重新对账
  （那才是"恢复成为可能"的时刻），否则只能等 60 秒扫描、甚至永远等不到。
- **待办表：只当索引，不当真值**（`src/pending.ts`）：行 = `{sessionId, name, firesAt, onFire, note?, wroteAt}`，
  存在 `<DSH_HOME>/time-reminder/countdowns.json`（Config 可改路径或关掉）。它只回答"哪些会话还欠倒计时"，
  因为插件**看不见没被恢复的会话**（`sessions.list()` 只列活会话、`get()` 不恢复、没有枚举已存会话的 API）——
  这正是"宿主重启 + 没人打开那个会话"这一格唯一能补上的办法。启动对账：读表 → 逐个 `resolveAgent` →
  折叠日志判断 → 仍欠则武装、已触发/已取消/改期则删行或改行 → 做不到就留到下一轮（60 秒扫描也跑一次）。
  解码手写（不引 zod）、坏行一律丢弃；写入 `tmp` + `rename`，写失败只 `warn`（提醒照常投递）。
  于是"陈旧的表项凭空造出提醒"在结构上不可能：任何动作都以折叠结果为准。
- **只有在真的投进收件箱之后才记账**：定时器回调是异步的（可能要等一次 resume），
  成功才写进内存的 `delivered` 集合并把该行从待办表删掉；失败/抛错就保持 pending，
  交给下一次 sync（步边界/扫描/对账）重试，绝不静默吞掉提醒。
- **超阈值警告已删除**：先前 `remaining ≥ 10m` 会附一条"请去插件页启用官方 `自动化任务`"的警告。
  有了待办表 + `resolveAgent` 之后长倒计时自己就能跨重启投递，那条警告只剩噪音，故整条移除；
  剩下的唯一缺口（组合里没有 `sessionController` 时无法恢复会话）写进 README 的已知限制，不塞给模型。

## 状态如何落盘

每会话状态（模式 + 计划 + 计数器 + 读数历史）**不写自己的事件类型**：DSH 0.2.0 的公开
API 无法给事件打 `ignorable` 标记（`Session.append()` 只接受 `surfaceOp` / `sourceEventSeqs`），
而读路径规定"事件类型不在词表内、且没有该标记 ⇒ 拒绝解释整个日志"。插件只要写一条，
那个会话**重启后就打不开**（2026-10-09 实测：1 条 `time-reminder/state` 锁死 5341 条事件的会话）。

所以状态改为**折叠日志里已有的事件**（`src/fold.ts`，纯函数、可单测）：

| 状态字段 | 来源事件 | 规则 |
|---|---|---|
| `mode` / `cron` | `tool/call` name=`time_mode` | 等配对的 `tool/result` 报告成功才采纳；参数非法则不采纳（工具当时也报错） |
| `counters` | `tool/call` name=`time_counter` | 同上；新基准 = 该 `tool/call` 的 `time` |
| `countdowns` | `tool/call` name=`time_countdown` | 同上；触发时刻按配置时区从调用时刻算出（`in` 加时长 / `at` 取下一次钟点） |
| 倒计时"已触发" | `user/message`（`source.countdown`） | 插件自己投出的那条触发通知；`snooze` 会清掉该标记 |
| `lastInjectionAt` / `lastTurnInjectionAt` | `user/message`（`source.kind = dsh-time-reminder`） | 就是插件自己注入的那条读数 |
| `lastMessageAt` | `assistant/message` / `tool/result` | 步 1 的间隔基准 |
| `pending`（在途调用） | `tool/call` → `tool/result` | `callId` 配对；失败即丢弃；`turn/start`/`turn/end` 清空 |

于是：

- 会话日志自足 ⇒ 可重放、可审计（同一个日志折两遍得到同一个状态）；
- 恢复会话后模式与计时器仍在，且与工具当场产生的状态**由同一个纯函数**得出
  （`timeModeChange` / `counterChange` 同时被工具与折叠调用），不会出现两份实现漂移；
- 注入的消息走 `createUserMessage` + 快照来源，满足"模型可见 ⟺ 已落盘"；
- 日志里**不再出现任何插件自有的事件类型**，装载路径与读路径都不再有兼容风险。

代价（写进"已知限制"）：状态只能从"落进日志的东西"恢复；新计数器基准取调用被记录的
时刻，与进程内 `Date.now()` 可能差几毫秒（显示精度到秒）。

## 注入读数形状

每个合格步骤追加一条 **user 角色**消息（追加在请求末尾，**不破坏 KV 前缀**）——`agent/pre-step` 的
决策类型只收 `UserMessage[]`，所以"真正的 system/developer 消息"在这条钩子上不可用；塞进系统提示词又会
每步打掉整段 KV 缓存。正文因此**框成 `<system-reminder>` 块**（与 AGENTS.md 同一套框法），
让模型按"系统上下文"读：

```
<system-reminder>
Time sampled while preparing turn 12, step 3: 2026-10-09T01:23:45+08:00[Asia/Shanghai]
Time mode: cron (daily 00:00 Asia/Shanghai; last 2026-10-08T00:00:03+08:00)
Elapsed since the preceding model-visible message: 187s
[counters] deploy=1243s (开始部署)
</system-reminder>
```

最后一行只在**有计数器要求注入**时出现。正文里出现的 `</system-reminder>` 会被转义成 `<\/system-reminder>`
（计数器备注是自由文本），防止提前闭合——与 workspace 指令注入同一条规则。

**GUI 可见性**走来源声明：`source = { kind: 'dsh-time-reminder', form: 'notice', summary: '<mode> reading · <时刻>' }`。
客户端按 `form` 选渲染器：`notice` 会把摘要放到**折叠行**上（"不展开就能读到"），展开是完整正文；
`snapshot`（官方 time-context 用的那个）不记录摘要，折叠行只剩生产者名，读数等于看不见。

## 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `time_mode` | `mode: off \| cron \| turn \| fine`，可选 `cron`（cron 表达式） | 切换精度；改动由这次调用的调用/结果在日志里留痕 |
| `time_counter` | `action: start \| lapse \| list \| note \| scope \| reset \| remove` | 建/查/改计时器；属性（注入、跨会话、父子可见、层数）在调用时设置 |
| `time_countdown` | `action: start \| snooze \| cancel \| list`，`in`/`at`、`onFire: wake \| inject`、`note` | 一次性倒计时；默认到点唤醒本会话 |

`lapse` 返回该计数器自基准以来的时长；`scope` 改可见性与是否注入。

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

## 时区与 cron

时区统一走 `Intl.DateTimeFormat` 的 `resolvedOptions().timeZone` 规范化（`reading.ts`）。
cron 解析**没有**复用 `@deepseek-ai/dsh-schedule`：那是私有工作区包，插件在 profile 里解析不到，
所以 `src/cron.ts` 自带一个最小实现（`*`、字面量、`a-b`、`a-b/n`、列表、`@daily` 等宏）。

## 已知限制

- **`refreshIntervalMs` 式的节流在 `fine` 下不存在**：每步一条读数，会累积到压缩遮蔽为止（token 成本）。
- **跨会话计数器不进日志**：历史回放时它的取值无法重建（只有会话内计数器可重建）。
- **状态只能从落进日志的东西恢复**：失败的 `time_mode` / `time_counter` 调用不改变状态；
  新计数器的基准取 `tool/call` 被记录的时刻，与进程内 `Date.now()` 可能差几毫秒（显示到秒，看不出）。
- **cron 判定用挂钟**：系统时间回拨可能导致同一触发点重复注入或漏注入；判定记录的是"上次注入时刻"。
- 桌面端 profile 尚未挂载。
