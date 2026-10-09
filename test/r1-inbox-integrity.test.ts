import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'

async function withDb(task: (inbox: R1Inbox, ctx: Context) => Promise<void>) {
  const app = new Context()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const ready = new Promise<void>((ok, no) => { resolve = ok; reject = no })
  app.inject(['database'], async ctx => {
    try {
      registerTables(ctx)
      registerR1Tables(ctx)
      await task(new R1Inbox(ctx), ctx)
      resolve()
    } catch (error) { reject(error) }
  })
  try { await app.start(); await ready } finally { await app.stop() }
}

function arrival(name: string): R1Arrival {
  return {
    storyId: 'story:' + name, participantId: 'person:' + name, platform: 'onebot',
    endpointId: 'endpoint:' + name, platformMessageId: 'message-42',
    content: 'original', receivedAt: new Date('2026-10-10T00:00:00.000Z'),
  }
}

test('R1 exact platform message ID refuses a conflicting replay without ScriptEntry mutation', async () => {
  await withDb(async (inbox, ctx) => {
    const row = arrival('conflict')
    assert.equal(await inbox.stage(row), 'inserted')
    assert.equal(await inbox.stage(row), 'duplicate')
    await assert.rejects(() => inbox.stage({ ...row, content: 'different message' }), /R1_CONFLICTING_MESSAGE_ID/)
    assert.deepEqual((await inbox.unread(row.storyId, row.participantId)).map(entry => entry.content), ['original'])
    assert.equal((await ctx.database.get('interlude_script_entry', { storyId: row.storyId })).length, 0)
  })
})

test('R1 replay receipt must resolve to canonical ScriptEntry from the same Inbox row', async () => {
  await withDb(async (inbox, ctx) => {
    const row = arrival('receipt')
    await inbox.stage(row)
    await inbox.updateAttention(row.storyId, 'CHECK')
    const id = stableInboxId(row)
    const ids = await inbox.observe(row.storyId, row.participantId, [id])
    assert.equal(ids.length, 1)
    assert.deepEqual(await inbox.observe(row.storyId, row.participantId, [id]), ids)
    await ctx.database.set('interlude_script_entry', { id: ids[0] }, { metadata: { sourceInboxId: 'wrong-id' } })
    await assert.rejects(() => inbox.observe(row.storyId, row.participantId, [id]), /R1_PROMOTION_RECEIPT_MISMATCH/)
    assert.equal((await ctx.database.get('interlude_script_entry', { storyId: row.storyId })).length, 1)
  })
})

test('R1 replay receipt must not silently accept mutated script content', async () => {
  await withDb(async (inbox, ctx) => {
    const row = arrival('content')
    await inbox.stage(row)
    await inbox.updateAttention(row.storyId, 'CHECK')
    const ids = await inbox.observe(row.storyId, row.participantId, [stableInboxId(row)])
    await ctx.database.set('interlude_script_entry', { id: ids[0] }, { content: 'corrupted message content' })
    await assert.rejects(() => inbox.observe(row.storyId, row.participantId, [stableInboxId(row)]), /R1_PROMOTION_RECEIPT_MISMATCH/)
  })
})
