import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId } from '../src/r1/inbox'
import { prepareObservedCommit } from '../src/r1/observed-commit'
import { R1ProposalReceipts, registerR1ProposalReceiptTable } from '../src/r1/proposal-receipts'

async function withDb<T>(path: string, action: (ctx: Context, box: R1Inbox, receipts: R1ProposalReceipts) => Promise<T>): Promise<T> {
  const app = new Context()
  app.plugin(SQLiteDriver, { path })
  let finish!: (value: T) => void
  let reject!: (error: unknown) => void
  const done = new Promise<T>((resolve, fail) => { finish = resolve; reject = fail })
  app.inject(['database'], async ctx => {
    try {
      registerTables(ctx)
      registerR1Tables(ctx)
      registerR1ProposalReceiptTable(ctx)
      finish(await action(ctx, new R1Inbox(ctx), new R1ProposalReceipts(ctx)))
    } catch (error) { reject(error) }
  })
  try { await app.start(); return await done }
  finally { await app.stop() }
}

test('R1 proposal receipts persist across restart, serialize collisions and preserve explicit rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsi-r1-receipt-'))
  const path = join(dir, 'candidate.db')
  const now = new Date('2026-10-10T12:00:00.000Z')
  const arrival = {
    storyId: 'receipt:story', participantId: 'receipt:alice',
    platform: 'mock', endpointId: 'mock:bot:alice',
    platformMessageId: 'message-001', content: '在吗？',
    receivedAt: new Date(now.getTime() - 20_000),
  }
  let receiptId = ''
  let proposal: Awaited<ReturnType<typeof prepareObservedCommit>>
  try {
    await withDb(path, async (ctx, box, receipts) => {
      assert.equal(await box.stage(arrival), 'inserted')
      await box.updateAttention(arrival.storyId, 'CHECK', now)
      const [scriptEntryId] = await box.observe(arrival.storyId, arrival.participantId, [stableInboxId(arrival)], now)
      proposal = await prepareObservedCommit(ctx, {
        storyId: arrival.storyId, participantId: arrival.participantId,
        inboxId: stableInboxId(arrival), scriptEntryId,
        frameId: 'frame:1', burstId: 'burst:1', now,
        decision: {
          script: '她回答“在呢”。',
          interaction: { seen: true, reply: { mode: 'immediate', content: '在呢' } },
        },
      })
      const concurrent = await Promise.all([receipts.open(proposal, now), receipts.open(proposal, now)])
      assert.equal(concurrent[0][0].id, concurrent[1][0].id)
      receiptId = concurrent[0][0].id
      assert.equal((await receipts.pending(arrival.storyId, arrival.participantId)).length, 1)
      assert.equal((await ctx.database.get('interlude_r1_proposal_receipt', { storyId: arrival.storyId })).length, 1)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 1)
    })
    await withDb(path, async (ctx, _box, receipts) => {
      const pending = await receipts.pending(arrival.storyId, arrival.participantId)
      assert.equal(pending.length, 1)
      assert.equal(pending[0].id, receiptId)
      await assert.rejects(() => receipts.open({
        ...proposal,
        sourceInboxId: 'wrong-source',
      }, now), /R1_RECEIPT_SOURCE_MISMATCH/)
      const superseding = await prepareObservedCommit(ctx, {
        storyId: arrival.storyId, participantId: arrival.participantId,
        inboxId: stableInboxId(arrival), scriptEntryId: proposal.sourceScriptEntryId,
        frameId: 'frame:1', burstId: 'burst:1',
        now: new Date(now.getTime() + 1_000),
        decision: {
          script: '她回答“在呢”。',
          interaction: { seen: true, reply: { mode: 'immediate', content: '在呢' } },
        },
      })
      await assert.rejects(() => receipts.open(superseding), /R1_RECEIPT_SOURCE_ALREADY_PROPOSED/)
      const rejected = await receipts.reject(receiptId, 'unsafe script', now)
      assert.equal(rejected.status, 'rejected')
      assert.equal((await receipts.reject(receiptId, 'unsafe script', now)).revision, rejected.revision)
      assert.equal((await receipts.open(proposal, now))[0].status, 'rejected')
      assert.equal((await receipts.pending(arrival.storyId, arrival.participantId)).length, 0)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 1)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
