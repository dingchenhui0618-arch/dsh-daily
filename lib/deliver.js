// Hands an approved idea back to a live agent.
//
// This is the whole trick of the "approve" button: the plugin does not develop
// anything itself. It puts a message into a live session and the agent does the
// work with its ordinary tools — the same mechanism the shipped dsh-schedule
// plugin uses to deliver a reminder.
//
// Verified contract (read from @deepseek-ai/dsh-schedule):
//   ctx.agents.roots()              -> live root Agents
//   agent.runMaintenance(fn)        -> claims the idle maintenance phase;
//                                      fn returns Promise<boolean>; THROWS when
//                                      a turn or another maintenance task owns
//                                      the agent
//   agent.followup(message)         -> queues a user-role message into the session

/**
 * The gates every approved item must satisfy, whatever it came from.
 *
 * The framing matters more than the wording. The user's explicit rule is that
 * the result must be an INDEPENDENT implementation published to his own
 * repository — not a fork, not a clone of someone else's work with edits, not
 * that work renamed. So the contract states that as hard rule 1, because an
 * agent trying to be helpful would otherwise reach for `gh repo fork` and
 * produce exactly the thing that was ruled out.
 */
function contractLines(projectsRoot, skeleton, closingLine) {
  return [
    '## 交付契约（硬性）',
    '1. **独立实现，不要 fork。** 禁止 `gh repo fork`；禁止 clone 别人的仓库后在它基础上改；禁止整段搬运别人的代码。',
    '2. 在 ' + projectsRoot + '\\<你自己的项目名> 新建工程，' + skeleton + '。',
    '3. 写实现和测试，`node --test` 必须全绿。测试失败不许发布。',
    '4. 推送前跑三步检查，缺一不可：密钥/token 扫描、.gitignore 核对、无关文件与临时文件清理。',
    '5. **三步检查任一命中就停下来报告，绝对不要推送。**',
    '6. 全部通过后，用 `gh repo create <你自己的项目名> --public --source . --push` 建**你自己的**仓库并推送。',
    '7. 回报：仓库 URL、测试通过数、commit hash、三步检查结果，以及' + closingLine + '。',
  ]
}

/**
 * The message injected when the user approves an item.
 *
 * `item.kind` picks the framing: `improvement` improves on a named published
 * repo, `idea` is a direction the ecosystem does not have yet. Both share the
 * same hard gates, because both end in the user's own repository.
 */
export function buildApprovalMessage(item, context) {
  const settings = context || {}
  const template = String(settings.templateRoot || '').trim()
  const projectsRoot = String(settings.projectsRoot || '').trim() || '<你的项目目录>'
  // The skeleton is described rather than pointed at when no local template is
  // configured, so the contract stays executable on a machine that has none.
  const skeleton = template.length > 0
    ? '骨架照抄 ' + template + '（零依赖构建、cordis.patch.yml、host/client 双半区、README、测试）'
    : '要有零依赖构建、cordis.patch.yml、host/client 双半区、README 和测试'

  if (item.kind === 'idea') {
    return [
      '[DAILY APPROVAL]',
      '用户在 dsh-daily 日报里批准了这个新方向。请按下面的契约独立做完并发布，不要中途停下来问。',
      '',
      '## 已批准的方向',
      '标题：' + String(item.title || '(未命名)'),
      '一句话：' + String(item.oneLiner || ''),
      '为什么生态里缺：' + String(item.gap || ''),
      '证据：' + String(item.evidence || '无'),
      '预估工作量：' + String(item.effort || '未知'),
      '',
      ...contractLines(projectsRoot, skeleton, '你最后做出来的东西和这条设想的差异'),
      '',
      '## 边界',
      '- 这是生态里还没有的新方向，不是复刻谁。但如果你设计时参考了某个现有实现，README 里要写清参考了什么、你和它有什么不同。',
      '- 不许把日报里标为「无直接证据」的推测写成已核实的事实。',
      '- 不许提交凭据、客户资产或 ~/.dsh 下的本机配置。',
    ].join('\n')
  }

  const source = String(item.basedOn || '').trim() || '(未知)'
  const sourceUrl = String(item.basedOnUrl || '').trim()
  return [
    '[DAILY APPROVAL]',
    '用户在 dsh-daily 日报里批准了这个改进方向。请按下面的契约独立做完并发布，不要中途停下来问。',
    '',
    '## 改进目标',
    '原版（别人已发布的）：' + source + (sourceUrl.length > 0 ? '  ' + sourceUrl : ''),
    '你自己的项目名：' + String(item.title || '(未命名)'),
    '具体改什么：' + String(item.delta || ''),
    '为什么值得做：' + String(item.why || ''),
    '原版的缺口：' + String(item.gap || ''),
    '证据：' + String(item.evidence || '无'),
    '预估工作量：' + String(item.effort || '未知'),
    '',
    ...contractLines(projectsRoot, skeleton, '你和原版的具体差异'),
    '',
    '## 边界',
    '- README 必须写明灵感来自哪个原仓库（带 URL），并说清你做了什么不同。借鉴思路可以，复制代码不行。',
    '- 确实需要复用原版代码片段时，先确认它的 LICENSE 允许，并在文件里保留原版权声明。',
    '- 不许把日报里标为「无直接证据」的推测写成已核实的事实。',
    '- 不许提交凭据、客户资产或 ~/.dsh 下的本机配置。',
  ].join('\n')
}

/**
 * Wrap text as a user-role follow-up message from this plugin.
 *
 * Source shape: `plugin:<name>`, NOT the retired `{ kind: 'plugin', plugin: … }`.
 *
 * 2026-10-10 — the bare `kind: 'plugin'` form is **refused** by DSH's v4 session
 * format. Every message admitted into a session must carry a producer-owned kind
 * (`plugin:<name>`, `user`, `schedule`, …); anything else, including the old
 * plugin wrapper, throws:
 *
 *     format v4 message requires a producer-owned source kind
 *
 * The failure mode is nasty because the hand-off *looks* fine: `agent.followup()`
 * does not throw, this plugin records `delivered: true`, yet the turn that admits
 * the inbox splice (`agent/inbox/spliced`, a validated durable slot) dies — the
 * user just sees a failed turn with that message.
 *
 * Evidence: a full scan of all 24 session logs found **zero** `kind:"plugin"` rows
 * (the message never reached disk) while `~/.dsh/daily/approvals.jsonl` held a
 * `delivered: true` record. DSH's own v3→v4 migration maps `plugin: 'daily'` to
 * `plugin:daily`, which is why we spell it the same way here.
 */
export function buildUserMessage(text, plugin, id) {
  return {
    id: id,
    role: 'user',
    content: [{ type: 'text', text: text }],
    source: { kind: 'plugin:' + String(plugin || 'daily') },
  }
}

/**
 * Try to deliver `text` to a live root agent.
 *
 * Never throws: a failed hand-off is a normal outcome to report, not a crash.
 * `runMaintenance` rejecting means the agent is busy, so the caller can retry
 * later rather than dropping the approval.
 *
 * @returns {Promise<{delivered:boolean, agentId?:string, reason?:string}>}
 */
export async function deliverToAgent(agents, text, options) {
  const settings = options || {}
  const plugin = settings.plugin || 'daily'

  if (agents === undefined || agents === null || typeof agents.roots !== 'function') {
    return { delivered: false, reason: 'no-agents-service' }
  }

  let roots
  try {
    roots = agents.roots()
  } catch (error) {
    return { delivered: false, reason: 'roots-failed: ' + String((error && error.message) || error) }
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    // No live session: the approval stays queued, exactly like an overdue
    // reminder that waits for the session to come back.
    return { delivered: false, reason: 'no-live-session' }
  }

  let lastReason = 'busy'
  for (const agent of roots) {
    if (agent === undefined || agent === null) continue
    if (typeof agent.runMaintenance !== 'function' || typeof agent.followup !== 'function') {
      lastReason = 'agent-missing-api'
      continue
    }
    let ran = false
    try {
      // The flag is set inside the maintenance body, so success does not depend
      // on guessing what runMaintenance resolves to.
      await agent.runMaintenance(function () {
        agent.followup(buildUserMessage(text, plugin, 'daily-' + Date.now()))
        ran = true
        return Promise.resolve(true)
      })
    } catch (busy) {
      lastReason = 'busy'
      continue
    }
    if (ran) return { delivered: true, agentId: String(agent.id === undefined ? '' : agent.id) }
    lastReason = 'maintenance-not-entered'
  }

  return { delivered: false, reason: lastReason }
}
