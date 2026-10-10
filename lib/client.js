/* dsh-daily client bundle — generated from src/client.cjs */
window.__ModuleLoader__.load({
  id: "dsh-daily",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// Client half of dsh-daily: the 日报 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness (esbuild marks it external, and the
// zero-dependency build leaves the require() untouched).

const React = require('react')
const h = React.createElement
const CSS = ".dd-root{display:flex;flex-direction:column;gap:14px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5}.dd-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.dd-title{font-size:15px;font-weight:600}.dd-sub{opacity:.6;font-size:12px}.dd-spacer{flex:1}.dd-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}.dd-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.dd-btn:disabled{opacity:.45;cursor:default}.dd-btn.dd-primary{border-color:color-mix(in srgb,#16a34a 45%,transparent);background:color-mix(in srgb,#16a34a 14%,transparent);color:color-mix(in srgb,#16a34a 80%,currentColor)}.dd-bar{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;opacity:.75;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:7px 10px}.dd-bar b{font-variant-numeric:tabular-nums}.dd-sec>h4{margin:0 0 8px;font-size:12px;font-weight:600;opacity:.75;display:flex;align-items:center;gap:8px}.dd-count{opacity:.55;font-weight:400}.dd-list{display:flex;flex-direction:column;gap:8px}.dd-card{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:9px;padding:10px 12px}.dd-card.dd-idea{border-left:3px solid color-mix(in srgb,#7c3aed 60%,transparent)}.dd-card.dd-pick{border-left:3px solid color-mix(in srgb,#0284c7 55%,transparent)}.dd-row1{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.dd-name{font-weight:600;font-size:13px}.dd-tag{font-size:11px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,currentColor 9%,transparent);opacity:.8}.dd-actions{margin-left:auto;display:flex;gap:6px}.dd-line{font-size:12px;margin-top:4px}.dd-k{opacity:.55}.dd-link{color:inherit;text-decoration:underline;text-underline-offset:2px;opacity:.8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}.dd-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid transparent}.dd-badge.dd-ok{background:color-mix(in srgb,#16a34a 16%,transparent);color:color-mix(in srgb,#16a34a 80%,currentColor);border-color:color-mix(in srgb,#16a34a 32%,transparent)}.dd-badge.dd-warn{background:color-mix(in srgb,#d97706 16%,transparent);color:color-mix(in srgb,#d97706 82%,currentColor);border-color:color-mix(in srgb,#d97706 32%,transparent)}.dd-empty{opacity:.55;font-size:12px;padding:8px 0}.dd-err{border:1px solid color-mix(in srgb,#dc2626 50%,transparent);background:color-mix(in srgb,#dc2626 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}.dd-notes{font-size:12px;opacity:.8;font-style:italic}.dd-hist{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}.dd-hist span{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:6px;padding:2px 8px;opacity:.8}.dd-spin{display:inline-block;animation:dd-rot 1s linear infinite}@keyframes dd-rot{to{transform:rotate(360deg)}}"

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

function IdeaCard(props) {
  const idea = props.idea
  return h(Card, { kind: 'dd-idea' },
    h('div', { className: 'dd-row1' },
      h('span', { className: 'dd-name' }, idea.title || '(未命名)'),
      h('span', { className: 'dd-tag' }, '建议你做的'),
      idea.verified
        ? h('span', { className: 'dd-badge dd-ok' }, '证据已核实')
        : h('span', { className: 'dd-badge dd-warn' }, '未经证实'),
      h('div', { className: 'dd-actions' },
        h('button', {
          className: 'dd-btn dd-primary',
          type: 'button',
          disabled: props.busy,
          onClick: function () { props.onApprove({ title: idea.title }) },
        }, props.busy ? '投递中…' : '做这个'),
      ),
    ),
    h('div', { className: 'dd-line' }, idea.oneLiner),
    h('div', { className: 'dd-line' }, h('span', { className: 'dd-k' }, '缺口：'), idea.gap),
    h('div', { className: 'dd-line' },
      h('span', { className: 'dd-k' }, '证据：'), idea.evidence,
      h('span', { className: 'dd-k' }, '  预估：' + (idea.effort || '未知')),
    ),
  )
}

function PickCard(props) {
  const pick = props.pick
  return h(Card, { kind: 'dd-pick' },
    h('div', { className: 'dd-row1' },
      h('span', { className: 'dd-name' }, pick.name),
      pick.category ? h('span', { className: 'dd-tag' }, pick.category) : null,
      h('div', { className: 'dd-actions' },
        h('button', {
          className: 'dd-btn',
          type: 'button',
          disabled: props.busy,
          onClick: function () { props.onApprove({ repo: pick.repo }) },
        }, '照这个做一个'),
        h('button', {
          className: 'dd-btn',
          type: 'button',
          onClick: function () { props.onSkip(pick.repo) },
        }, '不感兴趣'),
      ),
    ),
    h('div', { className: 'dd-line' }, pick.why),
    h('div', { className: 'dd-line' },
      h('a', { className: 'dd-link', href: pick.url, target: '_blank', rel: 'noreferrer' }, pick.repo),
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
  const ideas = (report && report.ideas) || []
  const picks = (report && report.picks) || []

  function approve(target) {
    const label = target.title || target.repo
    setBusy(label)
    setNote('')
    post('approve', target).then(function (result) {
      setBusy('')
      if (result && result.ok) {
        setNote(result.delivered
          ? '已投递给当前会话，agent 会接手开发并发布。'
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
      h('h4', null, '灵感（建议你做的）', h('span', { className: 'dd-count' }, ideas.length + ' 条')),
      ideas.length === 0
        ? h('div', { className: 'dd-empty' }, '今天没有够格的灵感。宁缺勿滥——拿不出生态缺口证据的方向不会被列出来。')
        : h('div', { className: 'dd-list' }, ideas.map(function (idea, i) {
          return h(IdeaCard, { key: 'idea-' + i, idea: idea, busy: busy === idea.title, onApprove: approve })
        })),
    ),

    h('div', { className: 'dd-sec' },
      h('h4', null, '今日推荐', h('span', { className: 'dd-count' }, picks.length + ' 条')),
      picks.length === 0
        ? h('div', { className: 'dd-empty' }, '今天没有合格推荐。')
        : h('div', { className: 'dd-list' }, picks.map(function (pick, i) {
          return h(PickCard, { key: 'pick-' + i, pick: pick, busy: busy === pick.repo, onApprove: approve, onSkip: skip })
        })),
    ),

    report && report.dropped ? h('div', { className: 'dd-line dd-k' },
      '生成时丢弃：幻觉插件 ' + (report.dropped.hallucinated || 0) +
      ' · 空理由 ' + (report.dropped.noWhy || 0) +
      ' · 套话理由 ' + (report.dropped.boilerplateWhy || 0) +
      ' · 残缺灵感 ' + (report.dropped.malformedIdea || 0),
    ) : null,

    history.length > 0 ? h('div', { className: 'dd-sec' },
      h('h4', null, '历史'),
      h('div', { className: 'dd-hist' }, history.map(function (item) {
        return h('span', { key: item.date }, item.date + '（' + item.picks + '/' + item.ideas + '）')
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
    return module.exports;
  },
});
