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
time_mode     mode: off | cron | turn | fine   可选 cron: "<表达式>"
              切换精度；cron 表达式按会话时区解释

time_counter  action: start | lapse | list | note | scope | reset | remove
              name, note, inject, toChildren, toParents, depth
              建/查/改计时器；可见性属性在调用时设置
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
</system-reminder>
```

第一行是时刻；第二行说明当前精度与"上次读数"（可追溯）；第三行是距上一条模型可见消息的间隔
（第 1 步）或距上一条读数的间隔（后续步）。第四行只在有计数器开了 `inject` 时出现。

**用户也看得见**：来源声明为 `form: 'notice'` 并带一行摘要（如 `turn reading · 2026-10-09T01:23:45+08:00`），
GUI 里那条折叠的"上下文注入"行**不展开就能读到"什么读数、什么时候"**，展开是完整读数。
（官方 `@deepseek-ai/dsh-time-context` 用 `form: 'snapshot'`，它不记录摘要，折叠行只剩生产者名——读数在，但一眼看不见。）

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
