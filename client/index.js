// dsh-time-reminder — 浏览器半边：会话头部工具区一枚小钟，悬停展开当前时间与「本会话时间提醒模式」。
//
// 契约与已装的 dsh-ssh-remote 完全一致（照抄其形态，因为它是本机跑通了的实例）：
//   · 产物由 `dsh.client` 清单加载，入口是 package.json 的 `exports["./client"]`；
//   · 本文件不参与 TypeScript 构建：`scripts/build.mjs` 只处理 `src/`，这里是手写 JS；
//   · 依赖只 require('react')，其余（槽位服务）通过 apply(ctx) 的 ctx 拿到；
//   · 会话作用域的槽位会把框架解析好的 `sessionId` 作为 props 传进来；模式是"每会话"的，
//     所以读写都必须带上它；
//   · 不用 title 属性：浏览器会弹原生提示框，与卡片本身重复（实测踩过）。
window.__ModuleLoader__.load({
  id: 'dsh-time-reminder',
  factory: function (require) {
    var React = require('react')
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useState = React.useState

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    /** 离开后延迟收起，好让鼠标从图标移进卡片时不会闪掉。 */
    var HIDE_DELAY_MS = 150
    /** 卡片宽度，用于贴着视口右缘定位。 */
    var CARD_WIDTH = 236
    var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    /** 必须与宿主 `src/index.ts` 的 API_PREFIX 一致。 */
    var API = '/time-reminder/api'

    /** 四种模式与各自的效果说明，顺序即按钮顺序。 */
    var MODES = [
      { id: 'off', label: '关闭', effect: '不自动注入读数' },
      { id: 'cron', label: '定时', effect: '跨过计划时刻时注入一次' },
      { id: 'turn', label: '每轮', effect: '每轮第一步注入一次' },
      { id: 'fine', label: '每步', effect: '每一步都注入一次' },
    ]

    var S = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px',
        border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 999,
        background: 'transparent', color: 'var(--dsw-alias-label-secondary,#999)',
        cursor: 'default', font: 'inherit', fontSize: 12, lineHeight: 1.8, whiteSpace: 'nowrap',
      },
      card: {
        position: 'fixed', zIndex: 2000, width: CARD_WIDTH, boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-1,#1f1f1f)',
        border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 10,
        boxShadow: '0 8px 28px rgba(0,0,0,.4)', padding: '8px 10px',
        font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-primary,inherit)', textAlign: 'left',
      },
      time: { fontSize: 20, fontWeight: 600, letterSpacing: '.02em', fontVariantNumeric: 'tabular-nums' },
      sub: { color: 'var(--dsw-alias-label-secondary,#999)', marginTop: 2, whiteSpace: 'nowrap' },
      divider: { height: 1, background: 'var(--dsw-alias-border-l1,#88888866)', margin: '8px 0' },
      section: { color: 'var(--dsw-alias-label-secondary,#999)', marginBottom: 5 },
      group: { display: 'flex', gap: 4 },
      seg: {
        flex: '1 1 0', padding: '3px 0', textAlign: 'center', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 6,
        background: 'transparent', color: 'var(--dsw-alias-label-secondary,#bbb)', font: 'inherit', fontSize: 12,
      },
      segOn: {
        background: 'var(--dsw-alias-bg-layer-2,#333)', color: 'var(--dsw-alias-label-primary,#fff)',
        borderColor: 'var(--dsw-alias-label-secondary,#999)',
      },
      note: { marginTop: 6, color: 'var(--dsw-alias-label-secondary,#999)', whiteSpace: 'normal', lineHeight: 1.5 },
      error: { marginTop: 6, color: 'var(--dsw-alias-label-error,#e66)', whiteSpace: 'normal', lineHeight: 1.5 },
      cronRow: { display: 'flex', gap: 4, marginTop: 6 },
      input: {
        flex: '1 1 auto', minWidth: 0, boxSizing: 'border-box', padding: '3px 6px',
        border: '1px solid var(--dsw-alias-border-l1,#88888866)', borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-2,#2a2a2a)', color: 'var(--dsw-alias-label-primary,inherit)',
        font: 'inherit', fontSize: 12,
      },
      save: {
        flex: '0 0 auto', padding: '3px 8px', cursor: 'pointer', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1,#88888866)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary,inherit)', font: 'inherit', fontSize: 12,
      },
    }

    function pad2(value) {
      return value < 10 ? '0' + value : '' + value
    }

    function clockIcon() {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true',
      }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v5l3 2' }))
    }

    /** 会话头部工具区的小钟：悬停显示当前时间，并可切换本会话的时间提醒模式。 */
    function ClockUtility(props) {
      var sessionId = props && props.sessionId ? String(props.sessionId) : ''
      var wrapRef = useRef(null)
      var hideTimer = useRef(null)
      var opened = useState(false)
      var open = opened[0]
      var setOpen = opened[1]
      var clock = useState(function () { return new Date() })
      var now = clock[0]
      var setNow = clock[1]
      var placed = useState(null)
      var pos = placed[0]
      var setPos = placed[1]
      var infoState = useState(null)
      var info = infoState[0]
      var setInfo = infoState[1]
      var cronState = useState('')
      var cronText = cronState[0]
      var setCronText = cronState[1]
      var errorState = useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      // 只在展开时走秒：收起后不留定时器。
      useEffect(function () {
        if (!open) return undefined
        var id = setInterval(function () { setNow(new Date()) }, 1000)
        return function () { clearInterval(id) }
      }, [open])

      useEffect(function () {
        return function () { if (hideTimer.current) clearTimeout(hideTimer.current) }
      }, [])

      // 每次展开都重读一次：模式可能刚被工具、或被另一个页面改过。
      useEffect(function () {
        if (!open || sessionId === '') return undefined
        var alive = true
        fetch(API + '/state?sessionId=' + encodeURIComponent(sessionId))
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (!alive) return
            if (body && body.ok) {
              setInfo(body.value)
              if (body.value.cron) setCronText(body.value.cron)
              setError(null)
            } else setError(body && body.error ? body.error.message : '读取失败')
          })
          .catch(function () { if (alive) setError('宿主 API 不可用') })
        return function () { alive = false }
      }, [open, sessionId])

      var post = useCallback(function (payload, done) {
        if (sessionId === '' || busy) return
        setBusy(true)
        fetch(API + '/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ sessionId: sessionId }, payload)),
        })
          .then(function (res) { return res.json() })
          .then(function (body) {
            setBusy(false)
            if (body && body.ok) { done(body.value); setError(null) }
            else setError(body && body.error ? body.error.message : '保存失败')
          })
          .catch(function () { setBusy(false); setError('宿主 API 不可用') })
      }, [sessionId, busy])

      var select = useCallback(function (mode) {
        post({ mode: mode }, function (value) {
          setInfo({ sessionId: sessionId, mode: value.mode, cron: value.cron, pending: true, effect: value.effect })
          if (value.cron) setCronText(value.cron)
        })
      }, [post, sessionId])

      var saveCron = useCallback(function () {
        var expression = String(cronText || '').trim()
        if (expression === '') { setError('计划表达式不能为空'); return }
        post({ mode: 'cron', cron: expression }, function (value) {
          setInfo({ sessionId: sessionId, mode: value.mode, cron: value.cron, pending: true, effect: value.effect })
        })
      }, [post, cronText, sessionId])

      function show() {
        if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
        var chip = wrapRef.current
        if (chip) {
          var rect = chip.getBoundingClientRect()
          var left = Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH - 8))
          setPos({ top: rect.bottom + 6, left: left })
        }
        setNow(new Date())
        setOpen(true)
      }

      function scheduleHide() {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        hideTimer.current = setTimeout(function () { setOpen(false) }, HIDE_DELAY_MS)
      }

      var zone = '本机时区'
      try {
        zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone
      } catch (ignored) {
        // 保留兜底文案：取不到就只说"本机时区"，不要把卡片搞崩。
      }

      var time = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds())
      var date = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
      var current = info && info.mode ? info.mode : null
      var picked = MODES.filter(function (mode) { return mode.id === current })[0]
      var effect = info && info.effect ? info.effect : (picked ? picked.effect : '')

      var rows = [
        h('div', { style: S.time, key: 'time' }, time),
        h('div', { style: S.sub, key: 'date' }, date + ' ' + WEEKDAYS[now.getDay()]),
        h('div', { style: S.sub, key: 'zone' }, zone),
        h('div', { style: S.divider, key: 'divider' }),
        h('div', { style: S.section, key: 'label' }, sessionId === '' ? '时间提醒（未取到会话）' : '时间提醒推送模式'),
      ]

      if (sessionId !== '') {
        rows.push(h('div', { style: S.group, key: 'group' }, MODES.map(function (mode) {
          var on = current === mode.id
          return h('span', {
            key: mode.id,
            style: on ? Object.assign({}, S.seg, S.segOn) : S.seg,
            onClick: function () { select(mode.id) },
            role: 'button',
            'aria-pressed': on ? 'true' : 'false',
          }, mode.label)
        })))
        if (effect) rows.push(h('div', { style: S.note, key: 'effect' }, effect))
        if (current === 'cron') {
          // 计划可编辑：输入框 + 保存（回车同样提交）。值来自 GET，改完由 POST 回写日志。
          rows.push(h('div', { style: S.cronRow, key: 'cron' },
            h('input', {
              style: S.input,
              value: cronText,
              spellCheck: false,
              'aria-label': 'cron 计划表达式',
              onChange: function (event) { setCronText(event.target.value) },
              onKeyDown: function (event) { if (event.key === 'Enter') saveCron() },
            }),
            h('span', {
              style: S.save,
              role: 'button',
              onClick: function () { saveCron() },
            }, busy ? '…' : '保存'),
          ))
          rows.push(h('div', { style: S.note, key: 'cronHint' }, '五分钟粒度，例：0 0 * * *（每天 0 点）'))
        }
        if (info && info.pending) {
          rows.push(h('div', { style: S.note, key: 'pending' }, '已请求，将在下一步生效'))
        }
      }
      if (error) rows.push(h('div', { style: S.error, key: 'error' }, String(error)))
      rows.push(h('div', { style: S.note, key: 'hint' }, '由 dsh-time-reminder 提供'))

      return h('span', { ref: wrapRef, style: S.wrap, onMouseEnter: show, onMouseLeave: scheduleHide },
        // 只用 aria-label，不用 title：title 会让浏览器弹出原生提示框，与卡片重复。
        h('span', { style: S.chip, role: 'img', 'aria-label': '当前时间' }, clockIcon()),
        open && pos
          ? h('div', {
            style: Object.assign({}, S.card, { top: pos.top, left: pos.left }),
            onMouseEnter: show,
            onMouseLeave: scheduleHide,
          }, rows)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        // 与 SSH 胶囊同一排（order 116），我们排在它右边。
        ctx.slots.inject('conversation.session.header.utilities', function () {
          return ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'time-reminder', order: 118, label: '时间' },
            ClockUtility,
          )
        })
      },
    }
  },
})
