import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'
import { R2GoalLedger, registerR2GoalTables } from '../src/r2/goal-ledger'
import type { R2HostEvidence } from '../src/r2/yuka-goal-planner'

const start = new Date('2026-10-10T12:00:00.000Z')
async function realDb<T>(path: string, now: Date, action: (ctx: Context, box: R1Inbox, ledger: R2GoalLedger) => Promise<T>): Promise<T> {
  const app = new Context()
  app.plugin(SQLiteDriver, { path })
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const finished = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  app.inject(['database'], async ctx => {
    try {
      registerTables(ctx)
      registerR1Tables(ctx)
      registerR2GoalTables(ctx)
      resolve(await action(ctx, new R1Inbox(ctx), new R2GoalLedger(ctx, () => now)))
    } catch (error) { reject(error) }
  })
  try { await app.start(); return await finished }
  finally { await app.stop() }
}
function message(storyId: string, participantId: string): R1Arrival {
  return {
    storyId, participantId, platform: 'onebot', endpointId: 'onebot:1:p',
    platformMessageId: 'incoming-1', content: 'a real person asks a question',
    receivedAt: new Date(start.getTime() - 60_000),
  }
}
function evidence(storyId: string, sourceIds: number[], at = start): R2HostEvidence {
  return {
    storyId, observedAt: new Date(at.getTime() - 10_000).toISOString(), now: at.toISOString(),
    verifiedByHost: true, energy: 80, activityLoad: 'free', attentionMode: 'attentive',
    verifiedSourceEntryIds: [...sourceIds], permittedContactParticipantIds: [],
    commitments: sourceIds.map(id => ({ id: 'commit:' + id, urgency: 0.9, sourceEntryIds: [id] })),
  }
}

test('R2 real Koishi SQLite disk restart: R1 observation becomes durable goal proposal and review receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsi-r2-persist-'))
  const path = join(dir, 'r2.db')
  const storyId = 'r2:story:alice', participantId = 'r2:person:alice'
  let sourceId = 0
  try {
    await realDb(path, start, async (ctx, inbox, ledger) => {
      const inbound = message(storyId, participantId)
      assert.equal(await inbox.stage(inbound), 'inserted')
      await assert.rejects(() => inbox.observe(storyId, participantId, [stableInboxId(inbound)]), /R1_ATTENTION_NOT_READY/)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId })).length, 0)
      await inbox.updateAttention(storyId, 'CHECK', start)
      const promoted = await inbox.observe(storyId, participantId, [stableInboxId(inbound)], start)
      sourceId = promoted[0]
      assert.ok(sourceId > 0)
      const planned = await ledger.submit(evidence(storyId, [sourceId]))
      assert.equal(planned.goal, 'fulfill-commitment')
      assert.equal(planned.status, 'proposed')
      assert.equal(planned.revision, 1)
      assert.deepEqual(planned.evidenceSourceIds, [sourceId])
      assert.equal((await ledger.history(storyId)).length, 1)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId })).length, 1)
      assert.equal((await ctx.database.get('interlude_r2_goal_state', { storyId: 'another-character' })).length, 0)
    })
    await realDb(path, start, async (ctx, _inbox, ledger) => {
      const restored = await ledger.current(storyId)
      assert.equal(restored?.goal, 'fulfill-commitment')
      assert.equal(restored?.revision, 1)
      const same = await ledger.submit(evidence(storyId, [sourceId]))
      assert.equal(same.proposalId, restored?.proposalId)
      assert.equal(same.revision, 1)
      assert.equal((await ledger.history(storyId)).length, 1)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId })).length, 1)
    })
    const due = new Date(start.getTime() + 31 * 60_000)
    await realDb(path, due, async (_ctx, _inbox, ledger) => {
      const advanced = await ledger.advanceReview(storyId, due)
      assert.equal(advanced?.status, 'review-due')
      assert.equal(advanced?.revision, 2)
      assert.equal((await ledger.history(storyId)).length, 2)
      const repeated = await ledger.advanceReview(storyId, due)
      assert.equal(repeated?.revision, 2)
    })
    await realDb(path, due, async (ctx, _inbox, ledger) => {
      const state = await ledger.current(storyId)
      assert.equal(state?.status, 'review-due')
      assert.equal((await ledger.history(storyId)).length, 2)
      // New host observation plans again; even then no actions have occurred.
      const refreshed = await ledger.submit(evidence(storyId, [], due))
      assert.equal(refreshed.goal, 'quiet-reflection')
      assert.equal(refreshed.status, 'proposed')
      assert.equal(refreshed.revision, 3)
      assert.equal((await ledger.history(storyId)).length, 3)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId })).length, 1)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R2 real SQLite fail-closed boundaries: invented ScriptEntry, stale host clock, isolation and premature review', async () => {
  await realDb(':memory:', start, async (ctx, _inbox, ledger) => {
    const wrongStory = 'r2:story:no-source'
    await assert.rejects(() => ledger.submit(evidence(wrongStory, [999999])), /R2_SCRIPT_SOURCE_NOT_FOUND/)
    assert.equal(await ledger.current(wrongStory), undefined)
    assert.equal((await ledger.history(wrongStory)).length, 0)
    await assert.rejects(() => ledger.submit(evidence(wrongStory, [], new Date(start.getTime() - 2 * 60_000))), /R2_HOST_CLOCK_MISMATCH/)
    assert.equal((await ctx.database.get('interlude_r2_goal_event', { storyId: wrongStory })).length, 0)
    const first = await ledger.submit(evidence('r2:story:one', []))
    const other = await ledger.submit(evidence('r2:story:two', []))
    assert.notEqual(first.proposalId, other.proposalId)
    assert.equal((await ledger.advanceReview('r2:story:one', start))?.status, 'proposed')
    assert.equal((await ledger.history('r2:story:one')).length, 1)
    assert.equal((await ledger.history('r2:story:two')).length, 1)
    await assert.rejects(() => ledger.advanceReview('r2:story:one', new Date(start.getTime() + 30 * 60_000)), /R2_FUTURE_REVIEW_FORBIDDEN/)
    assert.equal((await ledger.history('r2:story:one')).length, 1)
  })
})
