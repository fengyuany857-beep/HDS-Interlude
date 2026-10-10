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
import {
  R1AuthorizedOutbox, registerR1OutboxTables,
  type R1ApprovalRequest, type R1ApprovalVerifier,
} from '../src/r1/authorized-outbox'
import { R1OutboxDispatcher } from '../src/r1/outbox-dispatcher'

async function withDb<T>(path: string, verifier: R1ApprovalVerifier | undefined,
  run: (ctx: Context, box: R1Inbox, reviews: R1ProposalReceipts, outbox: R1AuthorizedOutbox) => Promise<T>): Promise<T> {
  const app = new Context()
  app.plugin(SQLiteDriver, { path })
  let resolve!: (result: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  app.inject(['database'], async ctx => {
    try {
      registerTables(ctx)
      registerR1Tables(ctx)
      registerR1ProposalReceiptTable(ctx)
      registerR1OutboxTables(ctx)
      resolve(await run(ctx, new R1Inbox(ctx), new R1ProposalReceipts(ctx),
        new R1AuthorizedOutbox(ctx, verifier)))
    } catch (error) { reject(error) }
  })
  try { await app.start(); return await promise }
  finally { await app.stop() }
}

const now = new Date('2026-10-10T12:00:00.000Z')
const later = (ms: number) => new Date(now.getTime() + ms)
const trusted: R1ApprovalVerifier = async grant =>
  grant.approvalId === 'host-approved:001' && grant.principalId === 'trusted-host'

async function stageProposal(ctx: Context, box: R1Inbox, reviews: R1ProposalReceipts) {
  const arrival = {
    storyId: 'outbox:story', participantId: 'outbox:alice', platform: 'onebot',
    endpointId: 'onebot:bot-account-1:private-alice', platformMessageId: 'platform-msg-01',
    content: '你好', receivedAt: later(-10_000),
  }
  await box.stage(arrival)
  await box.updateAttention(arrival.storyId, 'CHECK', now)
  const inboxId = stableInboxId(arrival)
  const [scriptEntryId] = await box.observe(arrival.storyId, arrival.participantId, [inboxId], now)
  const proposal = await prepareObservedCommit(ctx, {
    storyId: arrival.storyId, participantId: arrival.participantId,
    inboxId, scriptEntryId, frameId: 'f', burstId: 'b', now,
    decision: {
      script: '她回复“你好呀”。',
      interaction: { seen: true, reply: { mode: 'immediate', content: '你好呀' } },
    },
  })
  const [receipt] = await reviews.open(proposal, now)
  assert.ok(receipt)
  const approval: R1ApprovalRequest = {
    receiptId: receipt.id, storyId: receipt.storyId, participantId: receipt.participantId,
    sourceInboxId: receipt.sourceInboxId, platform: arrival.platform,
    endpointId: arrival.endpointId, commitId: receipt.commitId, eventId: receipt.eventId,
    payloadHash: receipt.contentHash, payloadContent: receipt.payloadContent,
    approvalId: 'host-approved:001',
    principalId: 'trusted-host', credentialId: 'test-key', signature: 'test-signature',
    actionClass: 'r1-private-text',
    approvedAt: now, expiresAt: later(30_000),
  }
  return { receipt, approval }
}

test('R1 outbox fail-closed authority checks source, account, payload and expiry in real SQLite', async () => {
  await withDb(':memory:', undefined, async (ctx, box, reviews, outbox) => {
    const { approval } = await stageProposal(ctx, box, reviews)
    await assert.rejects(() => outbox.authorize(approval, now), /R1_OUTBOX_HOST_VERIFIER_MISSING/)
    assert.equal((await ctx.database.get('interlude_r1_outbox', {})).length, 0)
  })
  await withDb(':memory:', trusted, async (ctx, box, reviews, outbox) => {
    const { receipt, approval } = await stageProposal(ctx, box, reviews)
    await assert.rejects(() => outbox.authorize({ ...approval, endpointId: 'onebot:other-bot' }, now),
      /R1_OUTBOX_SOURCE_BINDING_FAILED/)
    await assert.rejects(() => outbox.authorize({ ...approval, payloadHash: '0'.repeat(64) }, now),
      /R1_OUTBOX_SOURCE_BINDING_FAILED/)
    await assert.rejects(() => outbox.authorize({ ...approval, expiresAt: later(120_000) }, now),
      /R1_OUTBOX_INVALID_APPROVAL/)
    await assert.rejects(() => outbox.authorize({ ...approval, approvedAt: later(1_000) }, now),
      /R1_OUTBOX_INVALID_APPROVAL/)
    await assert.rejects(() => outbox.authorize({ ...approval, principalId: 'model' }, now),
      /R1_OUTBOX_HOST_DENIED/)
    const auth = await outbox.authorize(approval, now)
    assert.equal(auth.id, receipt.id)
    assert.equal(auth.status, 'authorized')
    assert.equal(auth.endpointId, approval.endpointId)
    assert.equal(auth.payloadHash, receipt.contentHash)
    assert.equal((await outbox.authorize(approval, now)).revision, 1)
    await assert.rejects(() => outbox.authorize({ ...approval, approvalId: 'host-approved:002' }, now),
      /R1_OUTBOX_HOST_DENIED/)
    assert.equal((await outbox.history(auth.id)).length, 1)
    assert.equal((await ctx.database.get('interlude_script_entry', { storyId: auth.storyId })).length, 1)
    assert.equal((await reviews.pending(auth.storyId, auth.participantId)).length, 0,
      'authorized review is not an unreviewed proposal and is still NOT sent')
    assert.equal((await ctx.database.get('interlude_r1_proposal_receipt', { id: auth.id }))[0].status,
      'authorized')
    await assert.rejects(() => reviews.reject(auth.id, 'late rejection', later(1_000)),
      /R1_RECEIPT_ALREADY_AUTHORIZED/)
  })
})

test('R1 outbox exactly one durable attempt claim, lost acknowledgement quarantined, never auto-retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hdsi-outbox-test-'))
  const path = join(dir, 'outbox.db')
  let id = ''
  let attemptId = ''
  try {
    await withDb(path, trusted, async (ctx, box, reviews, outbox) => {
      const { approval } = await stageProposal(ctx, box, reviews)
      id = (await outbox.authorize(approval, now)).id
      const result = await Promise.allSettled([
        outbox.claim(id, later(1_000)), outbox.claim(id, later(1_000)),
      ])
      assert.equal(result.filter(x => x.status === 'fulfilled').length, 1)
      assert.equal(result.filter(x => x.status === 'rejected').length, 1)
      const claim = result.find(x => x.status === 'fulfilled')
      if (!claim || claim.status !== 'fulfilled') throw Error('R1_MISSING_CLAIM')
      attemptId = claim.value.attemptId!
      assert.ok(attemptId)
      assert.equal((await outbox.current(id))?.status, 'attempting')
      assert.equal((await outbox.history(id)).length, 2)
      assert.equal((await ctx.database.get('interlude_script_entry', { storyId: approval.storyId })).length, 1)
    })
    await withDb(path, undefined, async (_ctx, _box, _reviews, outbox) => {
      const inFlight = await outbox.current(id)
      assert.equal(inFlight?.attemptId, attemptId)
      await assert.rejects(() => outbox.claim(id, later(2_000)), /R1_OUTBOX_NOT_CLAIMABLE/)
      const unknown = await outbox.settle(id, attemptId, 'unknown', later(2_000),
        undefined, 'transport-ack-lost')
      assert.equal(unknown.status, 'unknown')
      assert.equal((await outbox.uncertain(unknown.storyId)).length, 1)
      assert.equal((await outbox.history(id)).length, 3)
      await assert.rejects(() => outbox.claim(id, later(3_000)), /R1_OUTBOX_NOT_CLAIMABLE/)
      await assert.rejects(() => outbox.settle(id, attemptId, 'accepted', later(3_000), 'late-id'),
        /R1_OUTBOX_STALE_ATTEMPT/)
    })
    await withDb(path, undefined, async (_ctx, _box, _reviews, outbox) => {
      assert.equal((await outbox.current(id))?.status, 'unknown')
      assert.deepEqual((await outbox.history(id)).map(x => x.kind),
        ['authorized', 'attempting', 'unknown'])
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('R1 outbox adapter-accepted is not recipient-delivered; rejection and forged response are blocked', async () => {
  await withDb(':memory:', trusted, async (ctx, box, reviews, outbox) => {
    const { approval } = await stageProposal(ctx, box, reviews)
    const auth = await outbox.authorize(approval, now)
    await assert.rejects(() => outbox.claim(auth.id, later(31_000)), /R1_OUTBOX_EXPIRED/)
    const claim = await outbox.claim(auth.id, later(500))
    await assert.rejects(() => outbox.settle(auth.id, 'forged-id', 'accepted', later(1_000), 'platform-1'),
      /R1_OUTBOX_STALE_ATTEMPT/)
    await assert.rejects(() => outbox.settle(auth.id, claim.attemptId!, 'accepted', later(1_000)),
      /R1_OUTBOX_INVALID_RESULT/)
    const accepted = await outbox.settle(auth.id, claim.attemptId!, 'accepted', later(1_000), 'platform-1')
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.adapterMessageId, 'platform-1')
    await assert.rejects(() => outbox.settle(auth.id, claim.attemptId!, 'rejected', later(2_000)),
      /R1_OUTBOX_STALE_ATTEMPT/)
    assert.equal((await outbox.history(auth.id)).length, 3)
    assert.equal((await ctx.database.get('interlude_script_entry', { storyId: approval.storyId })).length, 1,
      'the candidate never invents an outgoing canonical message')
  })
})

test('R1 dispatcher sends exact persisted content once and records adapter acceptance', async () => {
  await withDb(':memory:', trusted, async (_ctx, box, reviews, outbox) => {
    const { approval } = await stageProposal(_ctx, box, reviews)
    const auth = await outbox.authorize(approval, now)
    const calls: unknown[] = []
    const result = await new R1OutboxDispatcher(outbox, {
      sendExact: async attempt => {
        calls.push(attempt)
        return { status: 'accepted', adapterMessageId: 'adapter-message-42' }
      },
    }).dispatch(auth.id, later(500))
    assert.equal(result.status, 'accepted')
    assert.deepEqual(calls, [{
      attemptId: result.attemptId, platform: approval.platform,
      endpointId: approval.endpointId, content: approval.payloadContent,
    }])
    await assert.rejects(() => outbox.claim(auth.id, later(1_000)), /R1_OUTBOX_NOT_CLAIMABLE/)
  })
})

test('R1 ambiguous transport and restart in-flight recovery become UNKNOWN without resend', async () => {
  await withDb(':memory:', trusted, async (ctx, box, reviews, outbox) => {
    const { approval } = await stageProposal(ctx, box, reviews)
    const auth = await outbox.authorize(approval, now)
    let calls = 0
    const result = await new R1OutboxDispatcher(outbox, {
      sendExact: async () => { calls++; throw Error('socket-reset-after-write') },
    }).dispatch(auth.id, later(500))
    assert.equal(result.status, 'unknown')
    assert.equal(calls, 1)
    await assert.rejects(() => outbox.claim(auth.id, later(1_000)), /R1_OUTBOX_NOT_CLAIMABLE/)
  })

  await withDb(':memory:', trusted, async (ctx, box, reviews, outbox) => {
    const { approval } = await stageProposal(ctx, box, reviews)
    const auth = await outbox.authorize(approval, now)
    await outbox.claim(auth.id, later(500))
    const recovered = await outbox.quarantineAttempting(later(500), later(1_000))
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].status, 'unknown')
    assert.equal((await outbox.quarantineAttempting(later(1_000), later(2_000))).length, 0)
    assert.deepEqual((await outbox.history(auth.id)).map(row => row.kind),
      ['authorized', 'attempting', 'unknown'])
  })
})
