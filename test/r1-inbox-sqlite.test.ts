import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'
import { transitionAttention } from '../src/r1/attention'
import { checkAction } from '../src/r1/reality'

test('R1.2 real Koishi SQLite: atomic unread admission and idempotent promotion', async () => {
  const app = new Context()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  let done!: () => void, fail!: (error: unknown) => void
  const finished = new Promise<void>((resolve, reject) => { done = resolve; fail = reject })
  app.inject(['database'], async ctx => {
    try {
      registerTables(ctx)
      registerR1Tables(ctx)
      const box = new R1Inbox(ctx)
      const now = new Date('2026-10-10T00:00:00Z')
      const one: R1Arrival = {
        storyId: 'character:a', participantId: 'participant:p1', platform: 'onebot',
        endpointId: 'endpoint:e1', platformMessageId: 'msg-001', content: 'private message secret',
        receivedAt: now,
      }
      assert.equal((await box.attention(one.storyId)).mode, 'ringOnly')
      assert.equal(await box.stage(one), 'inserted')
      assert.equal(await box.stage(one), 'duplicate')
      assert.equal((await box.unread(one.storyId, one.participantId)).length, 1)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: one.storyId })).length, 0)
      // An unobserved message is never silently exposed through canonical script history.
      await assert.rejects(() => box.observe(one.storyId, one.participantId, [stableInboxId(one)], now), /R1_ATTENTION_NOT_READY/)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: one.storyId })).length, 0)
      const awake = await box.updateAttention(one.storyId, 'CHECK', now)
      assert.equal(awake.mode, 'attentive')
      assert.equal(awake.revision, 1)
      const unrelated = { ...one, participantId: 'participant:p2', platformMessageId: 'msg-001' }
      assert.notEqual(stableInboxId(one), stableInboxId(unrelated))
      assert.equal(await box.stage(unrelated), 'inserted')
      assert.equal((await box.unread(one.storyId, one.participantId)).length, 1)
      assert.equal((await box.unread(one.storyId, unrelated.participantId)).length, 1)
      // A mixed cross-participant batch must rollback even if the first entry was valid.
      await assert.rejects(() => box.observe(one.storyId, one.participantId,
        [stableInboxId(one), stableInboxId(unrelated)], now), /R1_INBOX_IDENTITY_MISMATCH/)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: one.storyId })).length, 0)
      assert.equal((await box.unread(one.storyId, one.participantId)).length, 1)
      const ids = await box.observe(one.storyId, one.participantId, [stableInboxId(one)], now)
      assert.equal(ids.length, 1)
      assert.equal((await box.unread(one.storyId, one.participantId)).length, 0)
      assert.deepEqual(await box.observe(one.storyId, one.participantId, [stableInboxId(one)], now), ids)
      const entries = await ctx.database.get('interlude_script_entry', { storyId: one.storyId })
      assert.equal(entries.length, 1)
      assert.equal(entries[0].metadata.sourceInboxId, stableInboxId(one))
      assert.equal(entries[0].participantId, one.participantId)
      assert.equal(entries[0].content, one.content)
      // A new adapter object (worker restart) reads durable state rather than a process-local map.
      const restored = new R1Inbox(ctx)
      assert.deepEqual(await restored.observe(one.storyId, one.participantId, [stableInboxId(one)], now), ids)
      const dnd = await restored.updateAttention(one.storyId, 'DND', now)
      assert.equal(dnd.mode, 'dnd')
      const another = { ...one, platformMessageId: 'msg-002' }
      assert.equal(await restored.stage(another), 'inserted')
      await assert.rejects(() => restored.observe(one.storyId, one.participantId, [stableInboxId(another)], now), /R1_ATTENTION_NOT_READY/)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: one.storyId })).length, 1)
      done()
    } catch (error) { fail(error) }
  })
  try { await app.start(); await finished } finally { await app.stop() }
})

test('R1.3 real state machine and rules engine are fail-closed', async () => {
  assert.equal(transitionAttention('asleep', 'CHECK'), 'asleep')
  assert.equal(transitionAttention('asleep', 'WAKE'), 'ringOnly')
  assert.equal(transitionAttention('ringOnly', 'CHECK'), 'attentive')
  assert.equal((await checkAction({
    authoritative: false, attemptedTravel: false,
    claimsCompletedAction: false, completionEvidenceVerified: false,
  })).status, 'needs-data')
  assert.equal((await checkAction({
    authoritative: true, attemptedTravel: true, elapsedMinutes: 1, minTravelMinutes: 25,
    claimsCompletedAction: false, completionEvidenceVerified: false,
  })).status, 'reject')
  assert.equal((await checkAction({
    authoritative: true, attemptedTravel: false,
    claimsCompletedAction: true, completionEvidenceVerified: false,
  })).status, 'reject')
  assert.equal((await checkAction({
    authoritative: true, attemptedTravel: false,
    claimsCompletedAction: false, completionEvidenceVerified: false,
  })).status, 'allow')
})
