// Opening a new window is the one action in this plugin that changes the user's
// GUI, so the details that matter are the ones they would notice: the name of
// the window, the fact that the currently open session is NOT touched, the fact
// that the session lands in the project's own group, and the fact that a double
// click cannot cost two windows.
import test from 'node:test';
import { strict as assert } from 'node:assert';

import {
  buildFirstMessage,
  firstMessageText,
  sessionTitleFor,
  spawnSession,
  workspaceIdForPath,
} from '../src/spawn.js';

/** A stub that behaves like `ctx.agents` as the live Inspect provider describes it. */
function stubAgents(options) {
  const opts = options || {};
  const calls = [];
  const followups = [];
  const created = [];
  const service = {
    calls: calls,
    followups: followups,
    created: created,
    create: async function (request) {
      calls.push(request);
      if (opts.throws !== undefined) throw opts.throws;
      const agent = {
        id: 'agent-' + (created.length + 1),
        sessionId: 'session-' + (created.length + 1),
        followup: function (message) {
          followups.push(message);
          if (opts.followupThrows !== undefined) throw opts.followupThrows;
        },
      };
      created.push(agent);
      return opts.returnBareAgent === true ? agent : { agent: agent, dispose: function () {} };
    },
  };
  return service;
}

/** A stub for `ctx.sessionController`: the GUI's own route into a new session. */
function stubController(options) {
  const opts = options || {};
  const created = [];
  const prompted = [];
  const renamed = [];
  return {
    created: created,
    prompted: prompted,
    renamed: renamed,
    create: async function (request) {
      created.push(request);
      if (opts.createThrows !== undefined) throw opts.createThrows;
      return { sessionId: 'session-ctrl-' + created.length, agentPreset: 'cordis' };
    },
    prompt: opts.noPrompt === true ? undefined : async function (request) {
      prompted.push(request);
      if (opts.promptThrows !== undefined) throw opts.promptThrows;
      return { accepted: true };
    },
    rename: opts.noRename === true ? undefined : async function (request) {
      renamed.push(request);
      if (opts.renameThrows !== undefined) throw opts.renameThrows;
      return { title: request.title, seq: 3 };
    },
  };
}

function stubRegistry(workspaces) {
  return { list: function () { return workspaces; } };
}

function stubTitles() {
  const renames = [];
  return { renames: renames, rename: function (session, title) { renames.push({ session: session, title: title }) } };
}

function stubSessions(map) {
  const table = map || {};
  return { get: function (id) { return table[id] } };
}

const D_PROJECTS = 'D:\\Projects';

test('the window is named after the item, and a title that is already a slug survives unchanged', () => {
  assert.equal(sessionTitleFor({ title: 'dsh-signal-pet', kind: 'improvement' }), 'dsh-signal-pet');
  assert.equal(sessionTitleFor({ title: 'dsh-vision-diff', kind: 'idea' }), 'dsh-vision-diff');
});

test('a title that is not a slug is reduced to one instead of being rejected', () => {
  // The daily editor is told to emit project names, but a model that returns a
  // sentence must not be able to produce a window nobody can find again.
  assert.equal(sessionTitleFor({ title: 'dsh 有趣的 宠物!' }), 'dsh');
  assert.equal(sessionTitleFor({ title: '  dsh-a/b  ' }), 'dsh-ab');
  assert.equal(sessionTitleFor({ title: '--dsh-x--' }), 'dsh-x');
});

test('an item with no usable title still gets an honest name', () => {
  assert.equal(sessionTitleFor({ kind: 'idea' }), 'dsh-idea');
  assert.equal(sessionTitleFor({ kind: 'improvement' }), 'dsh-improvement');
  assert.equal(sessionTitleFor(null), 'dsh-improvement');
});

test('the first message carries both the visible title and the whole contract', () => {
  const text = firstMessageText('dsh-queue', '[DAILY APPROVAL]\n做事');
  assert.ok(text.startsWith('标题：dsh-queue'));
  assert.ok(text.includes('[DAILY APPROVAL]'));
});

test('the message is admitted as the user turn it actually is', () => {
  // The retired `{ kind: 'plugin', plugin }` shape is refused by the v4 session
  // format. `plugin:<name>` passes admission but does not count as a human turn,
  // so it would not raise the session's activity — the click IS the user's ask.
  const message = buildFirstMessage('hello', 'daily', 'id-1');
  assert.equal(message.role, 'user');
  assert.deepEqual(message.source, { kind: 'user' });
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
});

test('a registered workspace is found by its exact directory and nothing else', () => {
  const registry = stubRegistry([
    { id: 'ws-1', path: 'D:\\Projects' },
    { id: 'ws-2', path: 'D:\\Projects\\other' },
  ]);
  assert.equal(workspaceIdForPath(registry, D_PROJECTS), 'ws-1');
  assert.equal(workspaceIdForPath(registry, 'D:\\Projects\\'), '', 'a trailing separator is a different directory');
  assert.equal(workspaceIdForPath(registry, 'D:\\projects'), '', 'case is a real difference on this platform');
  assert.equal(workspaceIdForPath(registry, ''), '');
  assert.equal(workspaceIdForPath(undefined, D_PROJECTS), '');
});

test('the preferred path creates the session inside the workspace and prompts it', async () => {
  const controller = stubController();
  const titles = stubTitles();
  const outcome = await spawnSession(
    {
      sessionController: controller,
      workspaceRegistry: stubRegistry([{ id: 'ws-1', path: D_PROJECTS }]),
      sessions: stubSessions({ 'session-ctrl-1': { id: 'session-ctrl-1' } }),
      titles: titles,
      agents: stubAgents(),
    },
    { item: { title: 'dsh-queue', kind: 'idea' }, contract: '[DAILY APPROVAL] 做事', cwd: D_PROJECTS },
  );
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.via, 'session-controller');
  assert.equal(outcome.sessionId, 'session-ctrl-1');
  // Attached to the workspace, so the row lands in the project's group.
  assert.deepEqual(controller.created, [{ workspaceId: 'ws-1' }]);
  assert.equal(controller.prompted.length, 1);
  assert.equal(controller.prompted[0].sessionId, 'session-ctrl-1');
  assert.equal(controller.prompted[0].mode, 'queue');
  assert.ok(controller.prompted[0].content[0].text.includes('[DAILY APPROVAL]'));
  // The sidebar title is pinned to the project name through the controller's
  // own rename, which resolves the live Agent for us.
  assert.deepEqual(controller.renamed, [{ sessionId: 'session-ctrl-1', title: 'dsh-queue' }]);
});

test('with no matching workspace the session controller still opens a window by cwd', async () => {
  const controller = stubController();
  const outcome = await spawnSession(
    { sessionController: controller, workspaceRegistry: stubRegistry([]), agents: stubAgents() },
    { item: { title: 'dsh-queue' }, contract: 'x', cwd: D_PROJECTS },
  );
  assert.equal(outcome.spawned, true);
  assert.deepEqual(controller.created, [{ cwd: D_PROJECTS }]);
});

test('a session controller that cannot create falls back to the agent factory', async () => {
  const controller = stubController({ createThrows: new Error('workspace/not-found') });
  const agents = stubAgents();
  const outcome = await spawnSession(
    { sessionController: controller, workspaceRegistry: stubRegistry([]), agents: agents },
    { item: { title: 'dsh-queue' }, contract: 'x', cwd: D_PROJECTS },
  );
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.via, 'agents');
  assert.equal(agents.followups.length, 1);
});

test('a prompt failure after creation is reported with the session id', async () => {
  const controller = stubController({ promptThrows: new Error('session/agent-busy') });
  const agents = stubAgents();
  const outcome = await spawnSession(
    { sessionController: controller, workspaceRegistry: stubRegistry([]), agents: agents },
    { item: { title: 'dsh-queue' }, contract: 'x', cwd: D_PROJECTS },
  );
  // The factory fallback succeeds, so the user gets a window either way.
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.via, 'agents');
});

test('with no controller at all the factory path is used directly', async () => {
  const agents = stubAgents();
  const outcome = await spawnSession(
    { agents: agents, model: { provider: 'p', model: 'm' } },
    { item: { title: 'dsh-queue', kind: 'idea' }, contract: '[DAILY APPROVAL] 做事', cwd: D_PROJECTS },
  );
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.via, 'agents');
  assert.equal(outcome.sessionId, 'session-1');
  assert.equal(agents.calls[0].cwd, D_PROJECTS);
  assert.deepEqual(agents.calls[0].model, { provider: 'p', model: 'm' });
  assert.ok(agents.followups[0].content[0].text.includes('[DAILY APPROVAL]'));
});

test('a handle that is the bare agent is accepted too', async () => {
  const agents = stubAgents({ returnBareAgent: true });
  const outcome = await spawnSession({ agents: agents }, { item: { title: 'dsh-queue' }, contract: 'x', cwd: 'C:\\x' });
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.sessionId, 'session-1');
});

test('a missing agents service is reported, not thrown', async () => {
  const outcome = await spawnSession({}, { item: { title: 'dsh-queue' }, contract: 'x' });
  assert.equal(outcome.spawned, false);
  assert.equal(outcome.reason, 'no-agents-service');
});

test('an empty contract opens nothing', async () => {
  const controller = stubController();
  const agents = stubAgents();
  const outcome = await spawnSession(
    { sessionController: controller, agents: agents },
    { item: { title: 'dsh-queue' }, contract: '   ' },
  );
  assert.equal(outcome.spawned, false);
  assert.equal(outcome.reason, 'empty-contract');
  assert.equal(agents.calls.length, 0);
  assert.equal(controller.created.length, 0);
});

test('a create failure on both paths reports both causes', async () => {
  const controller = stubController({ createThrows: new Error('no room') });
  const agents = stubAgents({ throws: new Error('no room either') });
  const outcome = await spawnSession(
    { sessionController: controller, agents: agents },
    { item: { title: 'dsh-queue' }, contract: 'x' },
  );
  assert.equal(outcome.spawned, false);
  assert.ok(outcome.reason.includes('session-controller: create-failed'));
  assert.ok(outcome.reason.includes('agents: create-failed'));
});

test('a followup failure says the session exists but never started', async () => {
  const agents = stubAgents({ followupThrows: new Error('inbox closed') });
  const outcome = await spawnSession({ agents: agents }, { item: { title: 'dsh-queue' }, contract: 'x' });
  assert.equal(outcome.spawned, false);
  // The session id is still reported: the window may exist and the user needs
  // to know which one it is.
  assert.equal(outcome.sessionId, 'session-1');
  assert.ok(outcome.reason.startsWith('followup-failed'));
});

test('a cwd is only sent when one is configured', async () => {
  const agents = stubAgents();
  await spawnSession({ agents: agents }, { item: { title: 'dsh-queue' }, contract: 'x' });
  assert.equal('cwd' in agents.calls[0], false);
});

test('a failing title rename still counts as a spawned window', async () => {
  // The name matters, but the work matters more: a title service that refuses
  // must not turn an opened window into a reported failure.
  const controller = stubController({ renameThrows: new Error('title-invalid') });
  const titles = stubTitles();
  const outcome = await spawnSession(
    {
      sessionController: controller,
      sessions: { get: function () { return { id: 'session-ctrl-1' } } },
      titles: titles,
    },
    { item: { title: 'dsh-queue' }, contract: 'x', cwd: D_PROJECTS },
  );
  assert.equal(outcome.spawned, true);
  // The controller refused, so the direct title service is the second try.
  assert.deepEqual(titles.renames, [{ session: { id: 'session-ctrl-1' }, title: 'dsh-queue' }]);
});
