import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { registerR2GoalTables, R2GoalLedger } from '../src/r2/goal-ledger'
import type { R2HostEvidence } from '../src/r2/yuka-goal-planner'

const at = new Date('2026-10-10T12:00:00.000Z')
function evidence(energy = 90): R2HostEvidence {
  return {
    storyId: 'race:alice', verifiedByHost: true, now: at.toISOString(),
    observedAt: new Date(at.getTime() - 5_000).toISOString(),
    energy, activityLoad: 'free', attentionMode: 'attentive',
    commitments: [], verifiedSourceEntryIds: [], permittedContactParticipantIds: [],
  }
}
async function fixture<T>(run: (ledger: R2GoalLedger, ctx: Context) => Promise<T>): Promise<T> {
  const app = new Context()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  let yes!: (value: T) => void
  let no!: (error: unknown) => void
  const finished = new Promise<T>((ok, err) => { yes = ok; no = err })
  app.inject(['database'], async ctx => {
    try {
      registerTables(ctx)
      registerR2GoalTables(ctx)
      yes(await run(new R2GoalLedger(ctx, () => at), ctx))
    } catch (error) { no(error) }
  })
  try { await app.start(); return await finished } finally { await app.stop() }
}

test('R2 stale proposal replay cannot replace newer plan, even if both share one clock instant', async () => {
  await fixture(async (ledger, ctx) => {
    const first = await ledger.submit(evidence(90))
    assert.equal(first.goal, 'quiet-reflection')
    const updated = await ledger.submit(evidence(10))
    assert.equal(updated.goal, 'rest')
    assert.equal(updated.revision, 2)
    assert.notEqual(updated.proposalId, first.proposalId)
    await assert.rejects(() => ledger.submit(evidence(90)), /R2_STALE_PROPOSAL_REPLAY/)
    assert.equal((await ledger.current('race:alice'))?.proposalId, updated.proposalId)
    assert.equal((await ledger.history('race:alice')).length, 2)
    assert.equal((await ctx.database.get('interlude_script_entry', { storyId: 'race:alice' })).length, 0)
  })
})

test('R2 simultaneous replay of one proposal does not create two goal events', async () => {
  await fixture(async (ledger) => {
    const results = await Promise.allSettled([
      ledger.submit(evidence(10)),
      ledger.submit(evidence(10)),
      ledger.submit(evidence(10)),
    ])
    assert.equal(results.filter(item => item.status === 'rejected').length, 0,
      JSON.stringify(results.filter(item => item.status === 'rejected').map(item => String(item.reason))))
    const ids = results.map(item => item.status === 'fulfilled' ? item.value.proposalId : '')
    assert.equal(new Set(ids).size, 1)
    assert.equal((await ledger.history('race:alice')).length, 1)
    assert.equal((await ledger.current('race:alice'))?.revision, 1)
  })
})
