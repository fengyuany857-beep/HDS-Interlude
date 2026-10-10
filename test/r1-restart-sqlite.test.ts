import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'

async function withRealDatabase<T>(path: string, task: (box: R1Inbox, ctx: Context) => Promise<T>): Promise<T> {
  const app = new Context()
  app.plugin(SQLiteDriver, { path })
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const finished = new Promise<T>((ok, no) => { resolve = ok; reject = no })
  app.inject(['database'], async ctx => {
    try { registerTables(ctx); registerR1Tables(ctx); resolve(await task(new R1Inbox(ctx), ctx)) }
    catch (error) { reject(error) }
  })
  try { await app.start(); return await finished }
  finally { await app.stop() }
}

test('R1.4 Koishi SQLite file cold-restart: unread remains private, promotion is durable and repeat-safe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsi-r1-real-'))
  const path = join(dir, 'runtime.db')
  const arrival: R1Arrival = {
    storyId: 'story:restart', participantId: 'p:restart', platform: 'onebot',
    endpointId: 'endpoint:restart', platformMessageId: 'platform:100',
    content: 'an event that must not appear before observation', receivedAt: new Date('2026-10-10T01:00:00Z'),
  }
  try {
    await withRealDatabase(path, async (box, ctx) => {
      assert.equal(await box.stage(arrival), 'inserted')
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 0)
      assert.equal((await box.updateAttention(arrival.storyId, 'DND')).mode, 'dnd')
    })
    const first = await withRealDatabase(path, async (box, ctx) => {
      assert.equal((await box.unread(arrival.storyId, arrival.participantId)).length, 1)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 0)
      assert.equal((await box.attention(arrival.storyId)).mode, 'dnd')
      await assert.rejects(() => box.observe(arrival.storyId, arrival.participantId, [stableInboxId(arrival)]), /R1_ATTENTION_NOT_READY/)
      await box.updateAttention(arrival.storyId, 'CHECK')
      const ids = await box.observe(arrival.storyId, arrival.participantId, [stableInboxId(arrival)])
      assert.equal(ids.length, 1)
      return ids
    })
    await withRealDatabase(path, async (box, ctx) => {
      assert.equal(await box.stage(arrival), 'duplicate')
      assert.equal((await box.unread(arrival.storyId, arrival.participantId)).length, 0)
      assert.deepEqual(await box.observe(arrival.storyId, arrival.participantId, [stableInboxId(arrival)]), first)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 1)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('R1.4 safety source audit: stage-only interception precedes canonical script append and never synthesizes session', () => {
  const source = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8')
  const receiveStart = source.indexOf('  async receive(session: Session')
  const next = source.indexOf('  private async groupSenderName', receiveStart)
  const body = source.slice(receiveStart, next)
  assert.ok(receiveStart > -1)
  assert.ok(body.indexOf('if (this.r1Inbox)') < body.indexOf('this.signalIncomingInterruption(story, participant)'))
  assert.ok(body.indexOf('if (this.r1Inbox)') < body.indexOf("await this.appendEntry(current.id, {"))
  assert.ok(body.includes("HDSI_R1_PRIVATE_INBOX") === false)
  assert.ok(source.includes('const r1Mode = process.env.HDSI_R1_PRIVATE_INBOX'))
  assert.ok(source.includes("r1Mode === 'stage-only' || r1Mode === 'review-authorized'"))
  assert.ok(source.includes("r1Mode === 'review-authorized'"))
  assert.ok(source.includes('if (this.r1Inbox) return delivered'))
  assert.ok(source.includes('if (this.r1Inbox) return false // Stage-only mode forbids early unledgered sends.'))
})
