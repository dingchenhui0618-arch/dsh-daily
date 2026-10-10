// Client half of dsh-daily: the 日报 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness (esbuild marks it external, and the
// zero-dependency build leaves the require() untouched).

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-daily'
const POLL_MS = 3000

// One module-level poller shared by every mounted view. The host half owns the
// truth; this side only renders what /dsh-daily/state says.
let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-daily] listener failed', error)
    }
  })
}

function load() {
  fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function post(method, body) {
  return fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (res) { return res.json() }).then(function (data) {
    load()
    return data
  }).catch(function (error) {
    return { ok: false, error: String((error && error.message) || error) }
  })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function pad(n) { return n < 10 ? '0' + n : String(n) }

function clock(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function Card(props) {
  return h('div', { className: 'dd-card ' + props.kind }, props.children)
}

function ImprovementCard(props) {
  const item = props.item
  return h(Card, { kind: 'dd-improve' },
    h('div', { className: 'dd-row1' },
      h('span', { className: 'dd-name' }, item.title || '(未命名)'),
      item.category ? h('span', { className: 'dd-tag' }, item.category) : null,
      item.verified
        ? h('span', { className: 'dd-badge dd-ok' }, '证据已核实')
        : h('span', { className: 'dd-badge dd-warn' }, '未经证实'),
      h('div', { className: 'dd-actions' },
        h('button', {
          className: 'dd-btn dd-primary',
          type: 'button',
          disabled: props.busy,
          onClick: function () { props.onApprove({ basedOn: item.basedOn, title: item.title }) },
        }, props.busy ? '投递中…' : '做这个'),
        h('button', {
          className: 'dd-btn',
          type: 'button',
          onClick: function () { props.onSkip(item.basedOn) },
        }, '不感兴趣'),
      ),
    ),
    h('div', { className: 'dd-line dd-delta' },
      h('span', { className: 'dd-k' }, '改什么：'), item.delta),
    h('div', { className: 'dd-line' }, h('span', { className: 'dd-k' }, '为什么：'), item.why),
    h('div', { className: 'dd-line' }, h('span', { className: 'dd-k' }, '缺口：'), item.gap),
    h('div', { className: 'dd-line' },
      h('span', { className: 'dd-k' }, '原版：'),
      h('a', { className: 'dd-link', href: item.basedOnUrl, target: '_blank', rel: 'noreferrer' }, item.basedOn),
      h('span', { className: 'dd-k' }, '  预估：' + (item.effort || '未知')),
    ),
    h('div', { className: 'dd-line' },
      h('span', { className: 'dd-k' }, '证据：'), item.evidence,
    ),
  )
}

function DailyView() {
  const [state, setState] = React.useState(snap)
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState('')
  React.useEffect(function () { return subscribe(setState) }, [])

  const data = state.data
  const report = data && data.today
  const status = (data && data.status) || {}
  const config = (data && data.config) || {}
  const history = (data && data.history) || []
  const improvements = (report && report.improvements) || []

  function approve(target) {
    const label = target.title || target.basedOn
    setBusy(label)
    setNote('')
    post('approve', target).then(function (result) {
      setBusy('')
      if (result && result.ok) {
        setNote(result.delivered
          ? '已投递给当前会话，agent 会独立实现并发布到你自己的仓库。'
          : '已记录，但没能投递（' + (result.reason || '无活跃会话') + '）。等会话空闲后会自动重试。')
      } else {
        setNote('批准失败：' + ((result && (result.error || result.reason)) || '未知错误'))
      }
    })
  }

  function skip(repo) {
    post('skip', { repo: repo }).then(function () { setNote('已标记不感兴趣，明天不会再出现。') })
  }

  return h('div', { className: 'dd-root' },
    h('div', { className: 'dd-head' },
      h('div', { className: 'dd-title' }, '日报'),
      h('div', { className: 'dd-sub' }, report ? report.date + ' · ' + (report.model || '') : '还没有日报'),
      h('div', { className: 'dd-spacer' }),
      h('button', {
        className: 'dd-btn',
        type: 'button',
        disabled: status.running,
        onClick: function () { post('run', {}).then(function () { setNote('已开始生成，稍等片刻。') }) },
      }, status.running ? '生成中…' : '立即生成'),
    ),

    state.error ? h('div', { className: 'dd-err' }, '与 host 通信失败：' + state.error) : null,
    status.lastError ? h('div', { className: 'dd-err' }, '上次生成失败：' + status.lastError) : null,

    h('div', { className: 'dd-bar' },
      h('div', null, '下次运行 ', h('b', null, clock(status.nextRunAt)), '（每日 ' + config.hour + ':' + pad(config.minute || 0) + '）'),
      h('div', null, '语料 ', h('b', null, report && report.corpus ? report.corpus.total : '—')),
      h('div', null, '预筛 ', h('b', null, report && report.pool ? report.pool.size : '—')),
      h('div', null, '已推荐过 ', h('b', null, status.seen === undefined ? '—' : status.seen)),
      status.pending > 0 ? h('div', null, '待投递 ', h('b', null, status.pending)) : null,
      status.running ? h('div', null, h('span', { className: 'dd-spin' }, '◌'), ' 生成中') : null,
    ),

    note ? h('div', { className: 'dd-notes' }, note) : null,

    report && report.notes ? h('div', { className: 'dd-notes' }, '今日一句话：' + report.notes) : null,

    h('div', { className: 'dd-sec' },
      h('h4', null, '改进项（在别人的作品上往前走一步）', h('span', { className: 'dd-count' }, improvements.length + ' 条')),
      improvements.length === 0
        ? h('div', { className: 'dd-empty' }, '今天没有够格的改进项。宁缺勿滥——说不出具体改什么的方向不会被列出来。')
        : h('div', { className: 'dd-list' }, improvements.map(function (item, i) {
          return h(ImprovementCard, {
            key: 'improve-' + i,
            item: item,
            busy: busy === item.title,
            onApprove: approve,
            onSkip: skip,
          })
        })),
    ),

    report && report.dropped ? h('div', { className: 'dd-line dd-k' },
      '生成时丢弃：幻觉来源 ' + (report.dropped.hallucinated || 0) +
      ' · 没写改什么 ' + (report.dropped.noDelta || 0) +
      ' · 空话改法 ' + (report.dropped.hollowDelta || 0) +
      ' · 空理由 ' + (report.dropped.noWhy || 0) +
      ' · 套话理由 ' + (report.dropped.boilerplateWhy || 0) +
      ' · 改名重发 ' + (report.dropped.sameName || 0) +
      ' · 残缺 ' + (report.dropped.malformed || 0),
    ) : null,

    history.length > 0 ? h('div', { className: 'dd-sec' },
      h('h4', null, '历史'),
      h('div', { className: 'dd-hist' }, history.map(function (item) {
        return h('span', { key: item.date }, item.date + '（' + item.improvements + ' 项）')
      })),
    ) : null,
  )
}

function apply(ctx) {
  // dsh 0.1.6 can unload a plugin at runtime, so every registration here has a
  // matching teardown. The shared poll lives at module scope and outlives one
  // apply(), so it gets an explicit disposer of its own.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-daily'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // Guarded and normalised: a changed slot contract must degrade this one panel
  // and say so, not abort the client boot for every other plugin.
  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'daily', order: 40, label: '日报' },
        DailyView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-daily] could not register the 日报 view', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-daily',
  inject: ['slots'],
  apply: apply,
}
