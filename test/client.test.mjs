// The client half is CommonJS and expects the harness to supply React, so it is
// loaded here with that one dependency stubbed. Everything else under test is
// the real module the browser runs — this suite exists because the client had no
// coverage at all, and the version-skew banner shipped pointing users at the
// wrong fix as a result.
import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
  if (id === 'react') return { createElement: function () { return null } }
  return originalRequire.apply(this, arguments)
}
const client = require('../src/client.cjs')
Module.prototype.require = originalRequire

test('the client half exports the cordis contract the harness reads', () => {
  assert.equal(client.name, 'dsh-daily')
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.apply, 'function')
})

test('a new host with a stale report is not mistaken for a stale host', () => {
  const { skewState } = client.__test
  const newHost = { config: { maxImprovements: 10, maxIdeas: 3 } }
  const oldHost = { config: { maxRecommend: 10, maxIdeas: 3 } }
  const newReport = { improvements: [], ideas: [] }
  const oldReport = { picks: [], ideas: [] }

  assert.deepEqual(skewState(newHost, newReport), { hostStale: false, reportStale: false })
  // Restarting after the 11:00 run: the host is new, today s report is not.
  // Telling this user to restart again sends them in a circle, and the lists
  // render empty either way, so the two cases must not collapse.
  assert.deepEqual(skewState(newHost, oldReport), { hostStale: false, reportStale: true })
  // The reverse: a refreshed client outrunning the loaded host.
  assert.deepEqual(skewState(oldHost, oldReport), { hostStale: true, reportStale: false })
  // A stale host never also claims the report is stale — the host cannot know.
  assert.deepEqual(skewState(oldHost, newReport), { hostStale: true, reportStale: false })
})

test('version skew on an empty state says nothing at all', () => {
  const { skewState } = client.__test
  assert.deepEqual(skewState(null, undefined), { hostStale: false, reportStale: false })
  assert.deepEqual(skewState(undefined, null), { hostStale: false, reportStale: false })
  // No config echoed yet (first poll still in flight) must not raise a banner.
  assert.deepEqual(skewState({}, undefined), { hostStale: false, reportStale: false })
})

test('the 日报 view registers on conversation.view and tears down cleanly', () => {
  const disposers = []
  const registered = []
  global.document = {
    createElement: function () { return { dataset: {}, remove: function () {} } },
    head: { appendChild: function () {} },
  }
  const ctx = {
    effect: function (fn) { disposers.push(fn()) },
    slots: {
      inject: function (name, fn) {
        assert.equal(name, 'conversation.view')
        fn()
      },
      register: function (meta, component) {
        registered.push({ meta: meta, component: component })
        return function () {}
      },
    },
  }

  client.apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.id, 'daily')
  assert.equal(registered[0].meta.label, '日报')
  assert.equal(registered[0].meta.order, 40)
  assert.equal(typeof registered[0].component, 'function')

  // Both registrations must be reversible: cordis can unload a plugin mid-session.
  assert.equal(disposers.length, 2)
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  for (const dispose of disposers) dispose()
  delete global.document
})
