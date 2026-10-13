// dsh-time-reminder — 浏览器半边（PoC）：会话头部工具区一枚小钟，悬停展开当前时间卡片。
//
// 契约与已装的 dsh-ssh-remote 完全一致（照抄其形态，因为它是本机跑通了的实例）：
//   · 产物由 `dsh.client` 清单加载，入口是 package.json 的 `exports["./client"]`；
//   · 本文件不参与 TypeScript 构建：`scripts/build.mjs` 只处理 `src/`，这里是手写 JS；
//   · 依赖只 require('react')，其余（槽位服务）通过 apply(ctx) 的 ctx 拿到；
//   · 组件不需要槽位 props——时钟自己走时，不读会话数据，也不发任何网络请求。
window.__ModuleLoader__.load({
  id: 'dsh-time-reminder',
  factory: function (require) {
    var React = require('react')
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
    var CARD_WIDTH = 200
    var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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

    /** 会话头部工具区的小钟：悬停显示当前时间（本机时钟，浏览器时区）。 */
    function ClockUtility() {
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

      // 只在展开时走秒：收起后不留定时器。
      useEffect(function () {
        if (!open) return undefined
        var id = setInterval(function () { setNow(new Date()) }, 1000)
        return function () { clearInterval(id) }
      }, [open])

      useEffect(function () {
        return function () { if (hideTimer.current) clearTimeout(hideTimer.current) }
      }, [])

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
      } catch (error) {
        // 保留兜底文案：取不到就只说"本机时区"，不要把卡片搞崩。
      }

      var time = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds())
      var date = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())

      return h('span', { ref: wrapRef, style: S.wrap, onMouseEnter: show, onMouseLeave: scheduleHide },
        // 只用 aria-label，不用 title：title 会让浏览器弹出原生提示框（实测会显示"当前时间（悬停查看）"），
        // 与悬停卡片重复；aria-label 对视觉零影响，只服务读屏。
        h('span', { style: S.chip, role: 'img', 'aria-label': '当前时间' }, clockIcon()),
        open && pos
          ? h('div', {
            style: Object.assign({}, S.card, { top: pos.top, left: pos.left }),
            onMouseEnter: show,
            onMouseLeave: scheduleHide,
          },
          h('div', { style: S.time }, time),
          h('div', { style: S.sub }, date + ' ' + WEEKDAYS[now.getDay()]),
          h('div', { style: S.sub }, zone))
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
