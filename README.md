# dsh-time-reminder

给 DSH 的模型一只**可调精度**的时钟，外加**会话内计时器**。

## 解决什么

模型默认不知道"现在几点"，也不知道"距上一轮结束过了多久"。长时间干活时这让它无法判断
"这次等了 20 秒"还是"等了 20 分钟"。官方 `@deepseek-ai/dsh-time-context` 能做基础注入，但
**不提供工具**、且刷新间隔在加载时被闭包固定，会话中改不了。本插件把控制权交给模型和你。

## 四种时间模式（每会话独立，随会话日志持久化）

| 模式 | 行为 | 用途 |
|---|---|---|
| `cron`（默认） | 跨过 cron 触发时刻注入一次；默认 `0 0 * * *`（每天 00:00，按你的浏览器时区） | 日常：知道今天几号、大概几点 |
| `off` | **不自动注入**；工具照常可查时间与计时器 | 上下文要干净时 |
| `turn` | **每轮恰好一次**，在该轮第一步（即你发消息之后那一步）；给出距上一条模型可见消息的间隔 | 想每轮都知道"距上轮结束多久"，又不想每步都注入 |
| `fine` | **每个步骤都注入**（含每次工具调用之后） | 精确计时、要步间耗时 |

粒度谱：`off` < `cron`（按时间）< `turn`（每轮 1 条）< `fine`（每步约 19 条，实测均值）。

## 工具

```
time_mode       mode: off | cron | turn | fine   可选 cron: "<表达式>"
                切换精度；cron 表达式按会话时区解释

time_counter    action: start | lapse | list | note | scope | reset | remove
                name, note, inject, toChildren, toParents, depth
                建/查/改计时器；可见性属性在调用时设置

time_countdown  action: start | snooze | cancel | list
                name, in（"10m"/"1h30m"/"90s"）, at（"15:30"）, onFire, note
                一次性倒计时：到点把自己叫醒（或只投一条通知）
```

`time_counter` 的属性：

| 属性 | 默认 | 含义 |
|---|---|---|
| `inject` | `false` | 是否加入每次自动读数 |
| `toChildren` | `true` | 是否让**子代理**读到 |
| `toParents` | `false` | 是否让**父代理**读到 |
| `depth` | `2` | 可见性沿谱系穿透**几代**（1 = 直接父子，2 = 也含祖孙） |

计数器只存在于自己会话的状态里（随会话日志持久化），不跨会话共享。
`cron` 表达式同样是**每会话状态**：用 `time_mode` 改过之后，恢复会话仍然沿用。

### 倒计时（`time_countdown`）

一次性定时器，`in` 给相对时长（`90s` / `10m` / `1h30m` / `2d`），`at` 给**会话时区**里的钟点
（`15:30`，今天已过就顺延到明天）；两者**必须给且只给一个**。`snooze` 用 `in` 把它往后挪
（会清掉"已触发"标记，重新变回待触发），`cancel` 删掉。

**已触发的不是"删掉"而是"收起来"**：`list` 默认只列**待触发**的（触发记录留着，
`includeFired: true` 才显示，最近 10 条、新的在前）。这样 `list` 始终是"还欠什么"的视图，
而不会随响过的提醒越积越长；同时"**顺延刚响过的那条**"（`snooze` 会清 `firedAt` 重新武装）
和"我刚才那条到底响了没"仍然可查 —— 记录一旦真删，这两种用法就都没了。

到点做什么由 `onFire` 决定：

| `onFire` | 默认 | 行为 |
|---|---|---|
| `wake` | ✅ | 投一条通知**并唤醒**该会话（空闲的会话会被拉起来开一轮）——这样"到点执行动作"才真的发生 |
| `inject` | | 只把通知排进该会话的下一步，**不唤醒**（省 token，但空闲会话可能很久之后才看到） |

**持久化与重启**：倒计时折进同一份会话状态（`stateVersion: 3`），**会话日志仍是唯一真值**；
另有一份**待办索引表**（`<DSH_HOME>/time-reminder/countdowns.json`，可用 `pendingTable` / `pendingPath` 配置）
只回答一个问题——"哪些会话还欠一条倒计时"。它存在的理由：插件**看不见没被恢复的会话**
（`sessions.list()` 只列活会话、`get()` 不恢复、没有枚举已存会话的 API），
宿主重启后若没人打开那个会话，光靠折叠根本不知道有这么条倒计时在等。

于是重启后的路径是：**读表 → 对每个待办会话 `resolveAgent`（resolve-or-resume）→ 折叠日志判断是否还欠 →
该武装的武装、该丢的行丢掉**。表里的行**不是真值**：倒计时被取消、已触发、或时间被改过，都会在对账时
按折叠结果修正，所以一行陈旧数据不可能凭空造出提醒。宿主当时没运行的倒计时会在启动后**立刻补发**
（通知里注明迟了多久）；失败方向是**至少一次**：极窄的窗口里可能重复提醒一次，但不会静默丢掉。

**它不会带偏读数节奏**：触发通知来源带 `countdown` 标记且 `form: 'notice'`，折叠把它当作
"这个倒计时已触发"的凭据，而**不**当作读数——所以触发不会重置 `cron` / `turn` 的节奏。
待触发的倒计时会出现在读数里（见下），让模型知道自己排了什么。

**通知会说明"为什么不是准点到的"**，而且原因是**触发那一刻观察到的**，不是猜的：

| 观察到的情况 | 通知里补的那句 |
|---|---|
| 定时器在触发点**之后**才被武装（装载/扫描补发） | `It came due before this session's countdown timers were running again, so this is the first chance to deliver it (12m0s late).` |
| 回调本身迟了 ≥2 秒 | `The timer went off 7s late, so the process was suspended or blocked at that instant.` |
| 触发时 `agent.status === 'running'`（会话正卡在某一步里） | `This session was in the middle of a step, so the notice waited for that step to end.` |
| 都不成立（准点 + 会话空闲） | 什么都不加——没有延迟需要解释 |

后两条可以同时成立，那时两句都会出现；**2 秒以内的抖动不算迟到**（否则会写成误导性的 `0s late`，
并把原因错记到宿主头上——实测两次的真相都是"定时器准点，只是我当时卡在工具调用里"）。

**冷会话会被自动恢复**：触发时若会话不在驻留中（`ctx.agents` 里没有 Agent），插件走宿主会话控制器的
`resolveAgent` —— 文档原话是"**Resolve or resume** one ordinary Session for another Host API domain"
（`api/session-controller/src/index.ts`），官方 `dsh-schedule` 投递时用的同一个办法（`schedule/src/runtime.ts:101`）。
这是可选服务（web profile 才有），所以用 `ctx.get('sessionController')` 读。

⚠️ 实测到的细节：**这个服务可能比本插件挂得更晚**——冷启动时插件加载那一刻它还是 `undefined`
（调试日志里的 `reconcile.row … verdict:"no-controller"`），20 秒后会话才由**客户端重连**恢复
（`deliver.done … resumedHere:false`）。所以除启动对账外还注册了
`ctx.inject(['sessionController'], …)`：**服务一出现就再对账一次**——那才是"恢复成为可能"的时刻。
没有这个控制器的组合（headless / 纯 SDK）里，表仍能"找到"会话，但无法把它恢复成活会话，
倒计时只能等会话自己回来（见下面的已知限制）。

### 计数器变动会推送给"看得见它"的会话

`start`（含重启）/ `reset` / `note` / `scope` / `remove` 都会给相关会话送一条
`<system-reminder>` 通知（`lapse` / `list` 这类只读动作不送）。收件人是**变更前后可见集合的并集**——
所以把 `scope` 收窄、或直接 `remove` 时，原来看得见的那些会话也会收到"它走了"。
通知的来源是 `form: 'relay'` + `senderSessionId`，**不会被当成时间读数**（否则会把对方的 cron/turn 节奏带偏）。

投递方式由配置决定（见下）：`inject`（默认，投到对方下一个步骤、**不唤醒**）、
`steer`（投到最近一步并唤醒 idle 的对方）、`off`（不送）。对方会话不在驻留中（例如已收工的子代理）时投不进去，
但它的状态本来就从日志折叠，等它下次醒来照样能看到。

## 注入读数长这样

读数以 `<system-reminder>` 块注入（与 AGENTS.md 同一套框法，模型按"系统上下文"读，而不是"用户说的话"）：

```
<system-reminder>
Time sampled while preparing turn 12, step 1: 2026-10-09T01:23:45+08:00[Asia/Shanghai]
Time mode: cron (daily 00:00 Asia/Shanghai; previous reading 2026-10-08T00:00:03+08:00[Asia/Shanghai])
Elapsed since the preceding model-visible message: 3m7s
[counters] deploy=20m43s (开始部署)
[countdowns] build in 4m12s (看 GH Actions)
</system-reminder>
```

第一行是时刻；第二行说明当前精度与"上次读数"（可追溯）；第三行是距上一条模型可见消息的间隔
（第 1 步）或距上一条读数的间隔（后续步）。第四行只在有计数器开了 `inject` 时出现；
第五行只在有**待触发倒计时**时出现（最近的优先，最多列 5 条）。

**用户也看得见**：来源声明为 `form: 'notice'` 并带一行摘要（如 `turn reading · 2026-10-09T01:23:45+08:00`），
GUI 里那条折叠的"上下文注入"行**不展开就能读到"什么读数、什么时候"**，展开是完整读数。
（官方 `@deepseek-ai/dsh-time-context` 用 `form: 'snapshot'`，它不记录摘要，折叠行只剩生产者名——读数在，但一眼看不见。）

## 顶栏小钟（PoC）

浏览器半边：**会话头部工具区**一枚小钟图标（挂在 `conversation.session.header.utilities` 槽位，
`order: 118`，即 SSH 胶囊右侧），**鼠标悬停**展开一张卡片显示当前时间（每秒走动）、日期与浏览器时区。
它只读本机时钟：**不发任何网络请求、不读会话数据**。

产物是手写的 `client/index.js`（**不参与 TypeScript 构建**——`scripts/build.mjs` 只处理 `src/`），
由 `package.json` 的 `dsh.client` 清单加载：`platform: web` + `inject` 列出所需的客户端包
（`dsh-client-ui-slots` 提供槽位服务、`dsh-client-ui-conversation` 定义那个槽位），入口走
`exports["./client"]`。**不需要在 `cordis.patch.yml` 里加行**——宿主行照旧，客户端半边靠清单发现
（与已发布的 `dsh-ssh-remote` 同一套形态）。

这是**最小可行性验证**：只为确认"客户端半边加载 + 槽位注册"这条通路可用。不需要时删掉
`package.json` 里的 `dsh.client` 块（或整个 `client/` 目录）即可，宿主半边完全不受影响。

正文里若出现 `</system-reminder>`（计数器备注是自由文本，可能带）会被转义成 `<\/system-reminder>`，防止提前闭合。

## 挂载

```yaml
- id: time-context          # 官方那行必须禁用，否则每步会有两条读数
  disabled: true
- insert:
    - id: time-reminder
      name: 'dsh-time-reminder'
      config:
        defaultMode: cron          # off | cron | turn | fine
        cron: '0 0 * * *'          # 默认每天 00:00
        timeZone: Asia/Shanghai    # 缺省时用浏览器时区，再缺省用进程时区
        fineIntervalMs: 0          # fine 模式的最小间隔；0 = 每步都注入
        counterNotice: inject      # 计数器变动通知：inject（不唤醒）| steer（唤醒）| off
```

## 设计要点

- **状态由日志折叠得出，插件不写自己的事件类型**：模式/计划来自 `time_mode` 的调用
  （`tool/call` 的参数，**等对应的 `tool/result` 报成功**才采纳），计时器同理来自
  `time_counter` 的调用，注入历史来自插件自己注入的那条 `user/message`
  （`source.kind = dsh-time-reminder` + `source.form = notice`）。
  > 为什么不是"插件自造一条 `time-reminder/state` 事件"：DSH 0.2.0 的公开 API
  > **无法给事件打 `ignorable` 标记**（`Session.append()` 只接受 `surfaceOp` /
  > `sourceEventSeqs`），而读路径的规则是"不认识的事件类型 + 没有该标记 ⇒ 拒绝解释
  > 整个日志"。插件一写，那个会话重启后就打不开——2026-10-09 实测踩到。
- **满足"模型可见 ⟺ 已落盘"**：注入走 `createUserMessage` + 插件快照来源，落成 `user/message`。
- **不破坏 KV 前缀**：读数追加在请求消息末尾。
- **读数用 form 自证身份**：只有 `source.form = notice` 的消息才被折叠认成"读数"；
  跨会话推送的通知用 `form = relay`，不会污染收件人的 cron/turn 节奏。
- **倒计时的触发凭据就是那条通知本身**：它带 `countdown` 标记，折叠据此把该倒计时标成"已触发"，
  于是重启不会重复触发——插件不需要第二个存储，也不需要自造事件类型。
- **`at` 在"配置时区"里解析，不在浏览器时区里**：折叠没有请求可读浏览器时区，只有配置时区能让
  "工具当场算出的触发点"和"重启后折叠出的触发点"一致（否则恢复会话会重排一个已经触发过的倒计时）。
- **不手搓 cron**：`dsh-schedule` 的完整实现是私有工作区包、插件解析不到，所以本仓库自带一个
  最小实现（`src/cron.ts`，支持 `*`、字面量、`a-b`、`a-b/n`、列表与 `@daily` 等宏）。

## 已知限制

- `fine` 模式每步一条读数，会累积到被压缩遮蔽为止（token 成本）——这也是它默认不启用的原因。
- 计数器**不跨会话共享**：只在本会话谱系内（父/子，受 `toParents`/`toChildren`/`depth` 控制）可见。
- **谱系遍历只认"活会话"**：子会话结束后不再驻留，父会话就看不到它留下的计数器了（子会话日志里还在，
  只是遍历走活会话列表）；跨会话通知同理只送得到驻留中的会话。
- **状态只能从"落进日志的东西"恢复**：被拒绝/失败的 `time_counter`、`time_mode` 调用不改变状态
  （这与工具当场的行为一致）；新计数器的基准时刻取**调用被记录的那一刻**，与工具进程内
  `Date.now()` 可能差几毫秒（显示精度到秒，看不出差别）。
- cron 判定用挂钟：系统时间回拨可能导致同一触发点重复注入或漏注入。
- **倒计时需要宿主在运行**：宿主关闭期间到点的倒计时会在下次启动时补发（并注明迟了多久），
  但补发依赖那次启动时该会话被投影驱动（装载扫描 + 会话每一步 + 每 60 秒兜底扫描三条路径）。
- **补发/触发是"至少一次"**：宿主在"已投递、触发凭据还没落进日志"的窗口里崩溃，会再投一次；
  不会静默跳过。`inject` 语义下若会话长期不动，通知也可能一直没被消费。
- 倒计时**不跨会话**：到点只会叫醒创建它的那个会话（没有"推给别人"的动作）。
- **冷会话靠控制器恢复**：触发时若会话不在驻留中，插件用 `ctx.get('sessionController')`（可选服务，
  用 `ctx.get` 而不是声明注入）调 `resolveAgent` 做 resolve-or-resume，再由 `ctx.agents` 取回 Agent 投递。
  没有这个控制器的组合（headless / 纯 SDK）里，待办表仍能"找到"会话，但无法把它恢复成活会话，
  倒计时只能等会话自己变活。官方 `@deepseek-ai/dsh-schedule` 同样依赖该控制器（投递也走 `resolveAgent`），
  差别是它把任务存在自己的 storage 域里；"必须跨重启、且某条提醒不该依赖本插件被装载"时，
  用它的 `schedule_create` 更合适——插件页（左上角）→ 官方 → **自动化任务（实验性）** 启用即可。
- **待办表是提示不是真值**：`<DSH_HOME>/time-reminder/countdowns.json` 只列"哪些会话还欠倒计时"；
  对账时以折叠结果为准，取消/已触发/改期都会修正或删行。写失败只记一条 `warn`（提醒照常投递），
  两个宿主共用同一个 `DSH_HOME` 时理论上可能各投一次（与官方调度"单个 Host runtime 扫描任务"同一取向）。
- 桌面端 profile 尚未挂载；目前只在 web profile 开发。

## 开发

```sh
pnpm run build                     # src/*.ts → lib/*.js（pack/publish 由 prepack 自动做）
pnpm run typecheck                 # tsc --noEmit（peer 类型来自 devDependencies）
pnpm test                          # node --test tests/*.test.ts
pnpm run check                     # build + typecheck + test，一条龙
# 在受限沙箱里（子进程管道被拒）跑用例改用同进程隔离：
node --test --test-isolation=none tests/*.test.ts
```

`lib/` 是**构建产物**（已在 `.gitignore` 里）：DSH 用裸 Node ESM 装载插件、没有 TypeScript 钩子，
所以 `main: lib/index.js` 才是宿主真正加载的东西。`src/` 是唯一真源——`pnpm pack` / `pnpm publish`
会经 `prepack` 自动重建，不要手改 `lib/`。

测试只覆盖纯逻辑模块（`cron.ts` / `reading.ts` / `visibility.ts` / `fold.ts`），跑起来不依赖 DSH 运行时；
类型检查覆盖 `src/` 与 `tests/` 全量（`tsconfig.json`：strict + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes`），peer 类型由 devDependencies 提供。
