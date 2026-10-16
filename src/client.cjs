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

function IdeaCard(props) {
  const idea = props.idea
  return h(Card, { kind: 'dd-idea' },
    h('div', { className: 'dd-row1' },
      h('span', { className: 'dd-name' }, idea.title || '(未命名)'),
      h('span', { className: 'dd-type' }, idea.type || '未标注'),
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

function ImprovementCard(props) {
  const item = props.item
  return h(Card, { kind: 'dd-improve' },
    h('div', { className: 'dd-row1' },
      h('span', { className: 'dd-name' }, item.title || '(未命名)'),
      h('span', { className: 'dd-type' }, item.type || '未标注'),
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

// Version skew runs in two directions and they need different advice, so they
// are told apart instead of collapsed into one "something is stale" banner.
//
// The host half is loaded once per process (Node caches ES modules by URL, so
// reinstalling the bundle does not replace it), which means a refreshed client
// can outrun the host — only an app restart fixes that. A stale REPORT is the
// other case: today's 11:00 run fired before the restart, and a manual run fixes
// it. Telling that user to restart again sends them in a circle.
//
// Split out as a pure function because this is exactly the kind of presentation
// logic that silently rots; it has no DOM and no React in it.
function skewState(data, report) {
  const config = data !== undefined && data !== null ? data.config : undefined
  const hostStale = config !== undefined && config !== null && config.maxImprovements === undefined
  const reportStale = !hostStale && report !== undefined && report !== null &&
    report.improvements === undefined
  return { hostStale: hostStale, reportStale: reportStale }
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
  // The last market read, and the one recorded in the report. Both are shown
  // because they answer different questions: `market` is "can this machine reach
  // the catalog right now", while `report.market` is "what did today's report
  // actually use".
  const market = data && data.market ? data.market : null
  const history = (data && data.history) || []
  const improvements = (report && report.improvements) || []
  const ideas = (report && report.ideas) || []
  // Version skew: the host half is loaded once per process, so a refreshed
  // client can outrun it. Both cases would otherwise render empty lists, which
  // is indistinguishable from a broken generation.
  const skew = skewState(data, report)

  function approve(target) {
    const label = target.title || target.basedOn
    // Cheap double-click guard: the host is idempotent, but not flashing the
    // button is what keeps two clicks from looking like two different actions.
    if (busy !== '') return
    setBusy(label)
    setNote('')
    post('approve', target).then(function (result) {
      setBusy('')
      if (result && result.ok) {
        if (result.spawned) {
          setNote((result.replayed ? '已经开过窗口了：' : '已新建窗口 ') + (result.title || label)
            + (result.sessionId ? '（' + result.sessionId + '）' : '')
            + '，agent 会在那个窗口里独立实现并发布到你自己的仓库。')
        } else {
          setNote('没能新建窗口：' + (result.reason || '未知原因') + '。再点一次可以在同样的条件下重试。')
        }
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
    skew.hostStale ? h('div', { className: 'dd-err' }, 'host 半区还是旧版本（改 host 要重启 app 才会加载）。重启后再看这里。') : null,
    skew.reportStale ? h('div', { className: 'dd-err' }, '这份日报是旧格式（host 更新之前生成的）。点「立即生成」重跑一次就有两栏了。') : null,
    status.lastError ? h('div', { className: 'dd-err' }, '上次生成失败：' + status.lastError) : null,
    market && market.warning ? h('div', { className: 'dd-err' }, '热门度：' + market.warning) : null,

    h('div', { className: 'dd-bar' },
      h('div', null, '下次运行 ', h('b', null, clock(status.nextRunAt)), '（每日 ' + config.hour + ':' + pad(config.minute || 0) + '）'),
      // Which pool actually fed the report is stated, not implied: a report built
      // from the local CSV carries no popularity ordering, and looking identical
      // to a ranked one is exactly how a degraded run would go unnoticed.
      h('div', null, report && report.corpus && report.corpus.source === 'corpus' ? '候选（本地语料）' : '候选（市场）',
        h('b', null, report && report.corpus ? report.corpus.total : '—')),
      h('div', null, '预筛 ', h('b', null, report && report.pool ? report.pool.size : '—')),
      report && report.market ? h('div', null, '带热度 ',
        h('b', null, report.market.ranked === undefined ? '—' : report.market.ranked),
        report.market.sourceDate ? '（数据 ' + report.market.sourceDate + '）' : '') : null,
      !report && market ? h('div', null, '市场数据 ',
        h('b', null, market.sourceDate || market.status),
        market.withDownloads === undefined ? '' : '（' + market.withDownloads + ' 条有下载量）') : null,
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

    h('div', { className: 'dd-sec' },
      h('h4', null, '灵感（生态里还没有的）', h('span', { className: 'dd-count' }, ideas.length + ' 条')),
      ideas.length === 0
        ? h('div', { className: 'dd-empty' }, '今天没有够格的灵感。宁缺勿滥——拿不出缺口证据的方向不会被列出来。')
        : h('div', { className: 'dd-list' }, ideas.map(function (idea, i) {
          return h(IdeaCard, { key: 'idea-' + i, idea: idea, busy: busy === idea.title, onApprove: approve })
        })),
    ),

    report && report.typeCounts ? h('div', { className: 'dd-line dd-k' },
      '类型分布：' + (Object.keys(report.typeCounts).length > 0
        ? Object.keys(report.typeCounts).sort(function (a, b) {
          return report.typeCounts[b] - report.typeCounts[a]
        }).map(function (type) {
          return type + ' ' + report.typeCounts[type]
        }).join(' · ')
        : '（无）'),
    ) : null,

    // The brief is drawn from engineering memory, so the model drifts back to an
    // all-tooling report. The host retries once on that; if the second reply is
    // narrow too the content is kept and the narrowness is stated rather than
    // silently passed off as a balanced day.
    report && report.monotone ? h('div', { className: 'dd-err' }, '今天所有条目都是同一个类型（' + Object.keys(report.typeCounts || {})[0] + '），重试一次也没变宽。内容留着，但别把它当成一份均衡的日报。') : null,

    // A reply cut off by the token budget is not a failure — the items in hand
    // are real and were written by the model — but it is not a full report
    // either, and saying so is the entire reason the flag is tracked.
    report && report.truncated ? h('div', { className: 'dd-warn' },
      '回复被输出长度上限截断：写完的 ' + ((report.improvements || []).length + (report.ideas || []).length) +
      ' 条已保留，其余在写出过程中丢失。配置里调高 maxTokens 可减少这种情况。') : null,

    report && report.dropped ? h('div', { className: 'dd-line dd-k' },
      '生成时丢弃：幻觉来源 ' + (report.dropped.hallucinated || 0) +
      ' · 没写改什么 ' + (report.dropped.noDelta || 0) +
      ' · 空话改法 ' + (report.dropped.hollowDelta || 0) +
      ' · 空理由 ' + (report.dropped.noWhy || 0) +
      ' · 套话理由 ' + (report.dropped.boilerplateWhy || 0) +
      ' · 改名重发 ' + (report.dropped.sameName || 0) +
      ' · 无名字 ' + (report.dropped.noTitle || 0) +
      ' · 残缺 ' + (report.dropped.malformed || 0) +
      ' · 残缺灵感 ' + (report.dropped.malformedIdea || 0),
    ) : null,

    history.length > 0 ? h('div', { className: 'dd-sec' },
      h('h4', null, '历史'),
      h('div', { className: 'dd-hist' }, history.map(function (item) {
        return h('span', { key: item.date }, item.date + '（改进 ' + item.improvements + ' / 灵感 ' + item.ideas + '）')
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
  // Test seam only. The client half had no coverage at all, which is how the
  // one-directional skew banner shipped; this exposes the pure decision so a
  // Node test can pin it without a DOM or React.
  __test: { skewState: skewState },
}
