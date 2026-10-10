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

/** The message injected when the user approves an idea. */
export function buildApprovalMessage(idea, context) {
  const settings = context || {}
  const template = String(settings.templateRoot || '').trim()
  const projectsRoot = String(settings.projectsRoot || '').trim() || '<你的项目目录>'
  // The skeleton is described rather than pointed at when no local template is
  // configured, so the contract stays executable on a machine that has none.
  const skeleton = template.length > 0
    ? '骨架照抄 ' + template + '（零依赖构建、cordis.patch.yml、host/client 双半区、README、测试）'
    : '要有零依赖构建、cordis.patch.yml、host/client 双半区、README 和测试'
  // A shortlisted plugin already exists, so "approve" on one means "build me
  // something in that vein" — never "reimplement this repo". Keeping the two
  // framings distinct stops the agent from writing a clone with a new name.
  const reference = idea.mode === 'reference'
  const lines = [
    '[DAILY APPROVAL]',
    reference
      ? '用户在 dsh-daily 日报里对某个现存插件点了「照这个做一个」。请照下面的契约做出自己的版本，不要中途停下来问。'
      : '用户在 dsh-daily 日报里批准了这个方向。请按下面的契约把它做完，不要中途停下来问。',
    '',
    reference ? '## 参考对象（不是要复刻它）' : '## 已批准的方向',
    '标题：' + String(idea.title || '(未命名)'),
    '一句话：' + String(idea.oneLiner || ''),
    '为什么缺：' + String(idea.gap || ''),
    '证据：' + String(idea.evidence || '无'),
    '预估工作量：' + String(idea.effort || '未知'),
    '',
    '## 交付契约（硬性）',
    '1. 在 ' + projectsRoot + '\\<插件名> 新建工程，' + skeleton + '。',
    '2. 写实现和测试，`node --test` 必须全绿。测试失败不许发布。',
    '3. 推送前跑三步检查，缺一不可：密钥/token 扫描、.gitignore 核对、无关文件与临时文件清理。',
    '4. **三步检查任一命中就停下来报告，绝对不要推送。**',
    '5. 全部通过后 `gh repo create --public --source . --push`。',
    '6. 回报：仓库 URL、测试通过数、commit hash、以及三步检查的结果。',
    '',
    '## 边界',
    reference
      ? '- 这是参考现有插件做自己的版本：必须说清你和它的差异，不许换个名字就当成新东西发布。'
      : '- 不许把日报里的推测当成已核实的事实写进 README；证据那栏写的是「无直接证据」时，README 里必须标明这是未经证实的判断。',
    '- 不许提交凭据、客户资产或 ~/.dsh 下的本机配置。',
  ]
  return lines.join('\n')
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
