// Opening a NEW session for an approved item, instead of borrowing the current one.
//
// Why this is a module of its own
// -------------------------------
// The plugin used to hand an approval to whichever root session happened to be
// idle. That worked, but it put a long build contract into a session the user
// was already using for something else, and the work ended up tangled with
// unrelated history. The user's rule is now explicit: clicking 「做这个」 must
// OPEN A NEW WINDOW named after the item (`dsh-xxx`) and build there.
//
// Two ways in, tried in this order, because they fail differently:
//
//   1. `ctx.sessionController.create({ workspaceId | cwd })` — the SAME host
//      function the GUI's own 「新会话」 button reaches. It attaches the session
//      to the workspace in the same call, so the new window lands in the
//      project's group in the sidebar instead of 「未分组」. It returns only
//      `{ sessionId, agentPreset? }`, so the message is delivered through
//      `sessionController.prompt(...)`, which resolves the Agent internally.
//
//   2. `ctx.agents.create({ cwd, ... })` — the generic agent factory. Fewer
//      moving parts, but nothing attaches the session to a workspace, so the
//      window is grouped as ungrouped. Kept as the fallback so a composition
//      without the session controller still opens a window.
//
// Both paths end in a real first turn: a brand-new session is `blank`, and the
// sidebar hides blank sessions until a turn starts. Creating a window without
// starting it would look exactly like nothing happened.
//
// Everything the new session needs is injected, so this module is pinned by
// unit tests against a stub service rather than only against a live harness.
// The service shapes mirror the live Inspect providers and the packages in the
// unpacked app (see `_dsh-gui-session-discovery.md` and
// `_dsh-new-session-research.md` for signatures and line references).
//
// Nothing here throws: a new session that cannot be opened is a reported
// outcome. The caller records it and says so, because silently dropping an
// approved item is the one failure this plugin must never have.

/**
 * The title the user asked for: the item's own project name, e.g. `dsh-signal-pet`.
 *
 * A title is not decoration here — it is how the user finds the window again in
 * a sidebar full of sessions. So the slug is taken from the item's project name
 * when there is one, and only then falls back to the kind of item it is.
 */
export function sessionTitleFor(item) {
  const raw = item !== null && typeof item === 'object' ? item.title : ''
  const slug = String(raw === undefined || raw === null ? '' : raw)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w.\-]/g, '')
    // A model that answers with a sentence leaves runs of separators behind;
    // collapsing them is the difference between a name and a mess.
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  if (slug.length > 0) return slug
  return item !== null && typeof item === 'object' && item.kind === 'idea' ? 'dsh-idea' : 'dsh-improvement'
}

/**
 * The first user message.
 *
 * The contract text is what the agent must read; the title line is what makes
 * the session recognisable before the title service has folded anything, and it
 * survives even if an explicit rename is unavailable.
 */
export function firstMessageText(title, contract) {
  const body = String(contract === undefined || contract === null ? '' : contract)
  return '标题：' + title + '\n\n' + body
}

/**
 * Build the message object DSH will admit.
 *
 * `source.kind` is `user` on purpose. The retired literal `{ kind: 'plugin',
 * plugin }` is refused by the v4 session format, and `plugin:<name>` — although
 * it passes admission — is not a first-class producer kind in this release and
 * does not count as a human turn, so it would not raise the session's activity
 * or let the harness treat the hand-off as something the user asked for. The
 * hand-off IS the user's decision: they clicked 「做这个」.
 */
export function buildFirstMessage(text, plugin, id) {
  return {
    id: id,
    role: 'user',
    content: [{ type: 'text', text: text }],
    source: { kind: 'user' },
  }
}

function describe(error) {
  return String((error && error.message) || error)
}

/**
 * Find the registered workspace whose directory is exactly this one.
 *
 * The comparison is deliberately strict: `attachSession` rejects a session
 * whose recorded cwd does not equal the workspace path, and a loose match would
 * turn that into a half-created window. An exact match or nothing.
 */
export function workspaceIdForPath(registry, path) {
  const target = String(path === undefined || path === null ? '' : path).trim()
  if (target.length === 0) return ''
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return ''
  let listed
  try {
    listed = registry.list()
  } catch (error) {
    return ''
  }
  if (!Array.isArray(listed)) return ''
  const found = listed.find(function (entry) {
    return entry !== null && typeof entry === 'object' && String(entry.path) === target && entry.id !== undefined
  })
  return found === undefined ? '' : String(found.id)
}

/** `{ error }` and a bare Agent are both possible; normalise to Agent-or-undefined. */
function agentFromResolved(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && value.error !== undefined) return undefined
  if (typeof value === 'object' && value.agent !== undefined && value.agent !== null) return value.agent
  return typeof value === 'object' ? value : undefined
}

/**
 * Open a new root session and start it on `contract`.
 *
 * @param {object} services  injected ports:
 *   `{ agents, sessionController, workspaceRegistry, model, title }`
 * @param {object} request   `{ item, contract, cwd, plugin, now }`
 * @returns {Promise<{spawned:boolean, sessionId?:string, title?:string, via?:string, reason?:string}>}
 */
export async function spawnSession(services, request) {
  const ports = services !== null && typeof services === 'object' ? services : {}
  const req = request !== null && typeof request === 'object' ? request : {}
  const title = sessionTitleFor(req.item)
  const contract = String(req.contract === undefined || req.contract === null ? '' : req.contract)
  if (contract.trim().length === 0) return { spawned: false, title: title, reason: 'empty-contract' }

  const cwd = String(req.cwd === undefined || req.cwd === null ? '' : req.cwd).trim()
  const pluginName = req.plugin === undefined ? 'daily' : req.plugin
  const messageId = 'daily-spawn-' + String(req.now === undefined ? Date.now() : req.now)
  const text = firstMessageText(title, contract)

  // Path 1: the GUI's own route into a workspace-attached session.
  const controller = ports.sessionController
  if (controller !== null && typeof controller === 'object' && typeof controller.create === 'function') {
    const viaController = await spawnViaController(controller, {
      cwd: cwd,
      workspaceId: workspaceIdForPath(ports.workspaceRegistry, cwd),
      text: text,
      pluginName: pluginName,
      messageId: messageId,
      title: title,
      ports: ports,
    })
    if (viaController.spawned) return viaController
    // A refusal here is worth reporting only if the fallback also fails; the
    // reason from the closer-to-the-GUI attempt is kept as the primary one.
    const viaFactory = await spawnViaFactory(ports.agents, { cwd: cwd, text: text, pluginName: pluginName, messageId: messageId, title: title, ports: ports })
    if (viaFactory.spawned) return viaFactory
    return {
      spawned: false,
      title: title,
      reason: 'session-controller: ' + String(viaController.reason) + '; agents: ' + String(viaFactory.reason),
    }
  }

  // Path 2: no session controller in this composition.
  return spawnViaFactory(ports.agents, { cwd: cwd, text: text, pluginName: pluginName, messageId: messageId, title: title, ports: ports })
}

/** Create through the session controller, attach to the workspace, then prompt. */
async function spawnViaController(controller, input) {
  const createRequest = {}
  if (input.workspaceId.length > 0) createRequest.workspaceId = input.workspaceId
  else if (input.cwd.length > 0) createRequest.cwd = input.cwd

  let created
  try {
    created = await controller.create(createRequest)
  } catch (error) {
    return { spawned: false, title: input.title, reason: 'create-failed: ' + describe(error) }
  }
  const sessionId = String(created !== null && typeof created === 'object' && created.sessionId !== undefined ? created.sessionId : '')
  if (sessionId.length === 0) return { spawned: false, title: input.title, reason: 'create-returned-no-session' }

  // `prompt` is the honest delivery: it resolves the Agent itself and applies
  // the same idempotency the GUI's own send uses.
  if (typeof controller.prompt !== 'function') {
    return { spawned: false, sessionId: sessionId, title: input.title, reason: 'session-controller-has-no-prompt' }
  }
  try {
    await controller.prompt({
      sessionId: sessionId,
      requestId: input.messageId,
      mode: 'queue',
      content: [{ type: 'text', text: input.text }],
    })
  } catch (error) {
    return { spawned: false, sessionId: sessionId, title: input.title, reason: 'prompt-failed: ' + describe(error) }
  }

  await applyTitle(input.ports, input.title, sessionId, controller)
  return { spawned: true, via: 'session-controller', sessionId: sessionId, title: input.title }
}

/** Create through the generic agent factory and hand the message to the new agent. */
async function spawnViaFactory(agents, input) {
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    return { spawned: false, title: input.title, reason: 'no-agents-service' }
  }
  const options = {}
  if (input.cwd.length > 0) options.cwd = input.cwd
  // `agents.create` takes the model as AgentOptions; the session-controller path
  // has no model parameter and inherits the session default instead.
  if (input.ports.model !== undefined && input.ports.model !== null) options.model = input.ports.model

  let handle
  try {
    handle = await agents.create(options)
  } catch (error) {
    return { spawned: false, title: input.title, reason: 'create-failed: ' + describe(error) }
  }

  const agent = handle !== undefined && handle !== null && handle.agent !== undefined ? handle.agent : handle
  if (agent === undefined || agent === null) return { spawned: false, title: input.title, reason: 'create-returned-no-agent' }
  const sessionId = String(
    handle && handle.sessionId !== undefined ? handle.sessionId
      : agent.sessionId !== undefined ? agent.sessionId
        : agent.id !== undefined ? agent.id : '',
  )

  // A brand-new session is idle, so the message cannot be spliced into an active
  // turn; `followup` makes it the FIRST turn and wakes the driver.
  if (typeof agent.followup !== 'function') {
    return { spawned: false, sessionId: sessionId, title: input.title, reason: 'new-agent-has-no-followup' }
  }
  try {
    agent.followup(buildFirstMessage(input.text, input.pluginName, input.messageId))
  } catch (error) {
    return { spawned: false, sessionId: sessionId, title: input.title, reason: 'followup-failed: ' + describe(error) }
  }

  await applyTitle(input.ports, input.title, sessionId)
  return { spawned: true, via: 'agents', sessionId: sessionId, title: input.title }
}

/**
 * Pin the sidebar title to the item's name.
 *
 * The harness otherwise names a session from its first messages, which for a
 * long contract is a gamble. `sessionController.rename({ sessionId, title })`
 * resolves the live Agent itself and appends a user-source `session/title`
 * event, which pins the title and supersedes automatic generation.
 *
 * Failure is deliberately not fatal: the work matters more than the label, and
 * the first message already carries the name.
 */
async function applyTitle(ports, title, sessionId, controller) {
  if (controller !== undefined && controller !== null && typeof controller.rename === 'function') {
    try {
      await controller.rename({ sessionId: sessionId, title: title })
      return true
    } catch (error) {
      // Fall through to the direct title service, then give up quietly.
    }
  }
  const titles = ports.titles
  if (titles === undefined || titles === null || typeof titles.rename !== 'function') return false
  const sessions = ports.sessions
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return false
  try {
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) return false
    titles.rename(session, title)
    return true
  } catch (error) {
    return false
  }
}
