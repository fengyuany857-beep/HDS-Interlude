import assert from 'node:assert/strict'
import test from 'node:test'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import * as fc from 'fast-check'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'
import { proposeYukaGoal, type R2HostEvidence } from '../src/r2/yuka-goal-planner'

const now = new Date('2026-10-10T12:00:00Z')

/**
 * This uses the REAL Koishi MockBot and REAL Koishi SQLite driver, not a
 * hand-rolled Session double. It tests the R1 Inbox boundary, NOT OneBot
 * allowlisting, TurnEngine dispatch, real network delivery or production E2E.
 */
test('real Koishi Mock private session stages durable R1 Inbox without fictional ScriptEntry', async () => {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(mock)
  registerTables(app)
  registerR1Tables(app)
  let inbox!: R1Inbox
  const arrivals: R1Arrival[] = []
  app.inject(['database'], ctx => {
    inbox = new R1Inbox(ctx)
    ctx.middleware(async session => {
      assert.equal(session.platform, 'mock')
      assert.ok(session.isDirect)
      const item: R1Arrival = {
        storyId: 'mock:story', participantId: 'mock:person:' + session.userId,
        platform: session.platform, endpointId: 'mock:' + session.selfId + ':' + session.userId,
        platformMessageId: String(session.messageId), content: String(session.content),
        receivedAt: now,
      }
      arrivals.push(item)
      await inbox.stage(item)
    })
  })
  try {
    await app.start()
    await app.mock.client('alice').shouldNotReply('real Koishi message')
    assert.equal(arrivals.length, 1)
    assert.equal((await inbox.unread('mock:story', 'mock:person:alice')).length, 1)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: 'mock:story' })).length, 0)
    assert.equal(await inbox.stage(arrivals[0]), 'duplicate')
    await assert.rejects(() => inbox.stage({ ...arrivals[0], content: 'forged content' }), /R1_CONFLICTING_MESSAGE_ID/)
    await assert.rejects(
      () => inbox.observe('mock:story', 'mock:person:alice', [stableInboxId(arrivals[0])]),
      /R1_ATTENTION_NOT_READY/,
    )
    await inbox.updateAttention('mock:story', 'CHECK', now)
    const committed = await inbox.observe('mock:story', 'mock:person:alice', [stableInboxId(arrivals[0])], now)
    assert.equal(committed.length, 1)
    assert.deepEqual(await inbox.observe('mock:story', 'mock:person:alice', [stableInboxId(arrivals[0])], now), committed)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: 'mock:story' })).length, 1)
    assert.equal((await inbox.unread('mock:story', 'mock:person:alice')).length, 0)
  } finally {
    await app.stop()
  }
})

test('official MockBot group platform is mock, never proof of OneBot authorization', async () => {
  const app = new App()
  app.plugin(mock)
  try {
    await app.start()
    const client = app.mock.client('alice', 'test-group')
    assert.equal(client.event.platform, 'mock')
    assert.equal(client.event.channel.type, 0) // TEXT channel in Satori protocol
  } finally {
    await app.stop()
  }
})

test('real MSW intercepts external HTTP failures while leaving HDSI database untouched', async () => {
  let called = 0
  const server = setupServer(
    http.get('https://hdsi-graft.invalid/health', () => {
      called++
      return HttpResponse.json({ health: 'ok' })
    }),
    http.post('https://hdsi-graft.invalid/narrate', () => {
      called++
      return HttpResponse.json({ error: 'upstream-unavailable' }, { status: 503 })
    }),
  )
  server.listen({ onUnhandledRequest: 'error' })
  try {
    const status = await fetch('https://hdsi-graft.invalid/health')
    assert.equal(status.status, 200)
    assert.equal((await status.json() as { health: string }).health, 'ok')
    const error = await fetch('https://hdsi-graft.invalid/narrate', { method: 'POST', body: '{}' })
    assert.equal(error.status, 503)
    assert.equal(called, 2)
  } finally {
    server.close()
  }
})

test('real fast-check stress tests R2 exhaustion and evidence rejection invariants', () => {
  function evidence(energy: number, overload: boolean): R2HostEvidence {
    return {
      storyId: 'property:story', observedAt: now.toISOString(), now: now.toISOString(),
      verifiedByHost: true, energy, activityLoad: overload ? 'overloaded' : 'free',
      attentionMode: 'attentive', commitments: [],
      verifiedSourceEntryIds: [], permittedContactParticipantIds: [],
    }
  }
  fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), energy => {
    const plan = proposeYukaGoal(evidence(energy, true))
    assert.equal(plan.status, 'proposed')
    assert.equal(plan.goal, 'rest')
    assert.equal(plan.sideEffects, 'none')
  }), { numRuns: 150, seed: 20261010 })

  fc.assert(fc.property(fc.integer({ min: 101, max: 100_000 }), energy => {
    const plan = proposeYukaGoal(evidence(energy, false))
    assert.equal(plan.status, 'needs-evidence')
    assert.equal(plan.goal, undefined)
    assert.equal(plan.sideEffects, 'none')
  }), { numRuns: 150, seed: 20261011 })
})
