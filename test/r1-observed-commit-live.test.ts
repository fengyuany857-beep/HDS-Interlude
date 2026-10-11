import assert from 'node:assert/strict'
import test from 'node:test'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'
import { prepareObservedCommit } from '../src/r1/observed-commit'

const stamp = new Date('2026-10-10T12:00:00.000Z')
test('real Koishi Session and SQLite: R1 observed Inbox yields only grounded private ScriptCommit proposal', async () => {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(mock)
  registerTables(app)
  registerR1Tables(app)
  let inbox!: R1Inbox
  let arrival!: R1Arrival
  app.inject(['database'], ctx => {
    inbox = new R1Inbox(ctx)
    ctx.middleware(async session => {
      assert.equal(session.platform, 'mock')
      assert.ok(session.isDirect)
      arrival = {
        storyId: 'mock-observed', participantId: 'person-alice',
        platform: session.platform, endpointId: ['mock', session.selfId, session.userId].join(':'),
        platformMessageId: String(session.messageId),
        content: String(session.content), receivedAt: new Date(stamp.getTime() - 30_000),
      }
      await inbox.stage(arrival)
    })
  })
  try {
    await app.start()
    await app.mock.client('alice').shouldNotReply('今天在吗？')
    const source = stableInboxId(arrival)
    const req = {
      storyId: arrival.storyId, participantId: arrival.participantId,
      inboxId: source, scriptEntryId: 0,
      frameId: 'host-frame', burstId: 'host-burst', now: stamp,
      decision: {
        script: '她看见后回复“我在”。',
        interaction: { seen: true, reply: { mode: 'immediate' as const, content: '我在' } },
      },
    }
    assert.equal((await app.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 0)
    await assert.rejects(() => prepareObservedCommit(app, { ...req, scriptEntryId: 1 }), /R1_NOT_OBSERVED/)
    await inbox.updateAttention(arrival.storyId, 'CHECK', stamp)
    const [entryId] = await inbox.observe(arrival.storyId, arrival.participantId, [source], stamp)
    const proposal = await prepareObservedCommit(app, { ...req, scriptEntryId: entryId })
    assert.equal(proposal.status, 'proposal-only')
    assert.equal(proposal.sideEffects, 'none')
    assert.equal(proposal.requiresHostRealityGate, true)
    assert.equal(proposal.requiresHostDeliveryAuthorization, true)
    assert.equal(proposal.sourceScriptEntryId, entryId)
    const outbound = proposal.commit.events.filter(x => x.kind === 'outgoing-message')
    assert.equal(outbound.length, 1)
    assert.equal(outbound[0].scriptBinding?.status, 'bound')
    assert.equal((await app.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 1)
    await assert.rejects(() => prepareObservedCommit(app, { ...req, scriptEntryId: entryId, participantId: 'intruder' }), /R1_NOT_OBSERVED/)
    const delayed = await prepareObservedCommit(app, {
      ...req, scriptEntryId: entryId,
      decision: { ...req.decision, script: '她决定稍后说“我在”。', interaction: { seen: true, reply: { mode: 'delayed', content: '我在', sendAt: new Date(stamp.getTime() + 30_000).toISOString() } } },
    })
    const delayedEvent = delayed.commit.events.find(x => x.kind === 'outgoing-message')
    assert.equal(delayedEvent?.deliveryMode, 'delayed')
    assert.equal(delayedEvent?.scriptBinding?.status, 'future')
    await assert.rejects(() => prepareObservedCommit(app, {
      ...req, scriptEntryId: entryId,
      decision: { ...req.decision, interaction: { seen: true, reply: { mode: 'immediate', content: '没有写在剧本中的句子' } } },
    }), /R1_UNBOUND_DELIVERY/)
    await assert.rejects(() => prepareObservedCommit(app, {
      ...req, scriptEntryId: entryId, now: new Date(stamp.getTime() - 60_000),
    }), /R1_OBSERVATION_TIME_INVALID/)
    await assert.rejects(() => prepareObservedCommit(app, {
      ...req, scriptEntryId: entryId,
      decision: { ...req.decision, crossConversationActions: [{ participantId: 'another', mode: 'immediate', content: 'hello' }] },
    }), /R1_UNREVIEWED_ACTION/)
  } finally {
    await app.stop()
  }
})
