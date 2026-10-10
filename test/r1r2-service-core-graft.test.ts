import assert from 'node:assert/strict'
import test from 'node:test'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { InterludeService } from '../src/service'
import { createTurnEngine } from '../src/turn-engine'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'
import { R1ProposalReceipts, registerR1ProposalReceiptTable } from '../src/r1/proposal-receipts'
import { R2GoalLedger, registerR2GoalTables } from '../src/r2/goal-ledger'

/**
 * Exercises the candidate-only public service entrypoints against real Koishi
 * Mock + Minato SQLite, while explicitly excluding external transport.
 * An isolated prototype fixture bypasses the full production plugin bootstrap
 * and therefore is NOT a production adapter E2E.
 */
test('R1 candidate service: host reality gate, TurnEngine contention and exact source-bound proposal', async () => {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(mock)
  registerTables(app)
  registerR1Tables(app)
  registerR1ProposalReceiptTable(app)
  const now = new Date('2026-10-10T12:00:00.000Z')
  let inbox!: R1Inbox
  let service!: InterludeService
  let arrival!: R1Arrival
  app.inject(['database'], ctx => {
    inbox = new R1Inbox(ctx)
    const fixture: any = Object.create(InterludeService.prototype)
    fixture.ctx = ctx
    fixture.r1Inbox = inbox
    fixture.r1ProposalReceipts = new R1ProposalReceipts(ctx)
    fixture.queues = new Map()
    fixture.desktopRuntimePhase = 'running'
    fixture.turnEngine = createTurnEngine({
      setTimeout: () => () => {},
      userMessageDebounceSeconds: 0,
      reportOperation: () => {},
    })
    service = fixture as InterludeService
    ctx.middleware(async session => {
      assert.equal(session.platform, 'mock')
      arrival = {
        storyId: 'candidate:story', participantId: 'candidate:alice',
        platform: session.platform,
        endpointId: [session.platform, session.selfId, session.userId].join(':'),
        platformMessageId: String(session.messageId),
        content: String(session.content),
        receivedAt: new Date(now.getTime() - 10_000),
      }
      await inbox.stage(arrival)
    })
  })
  try {
    await app.start()
    await app.mock.client('alice').shouldNotReply('今天在吗？')
    const input = {
      storyId: arrival.storyId, participantId: arrival.participantId,
      inboxId: stableInboxId(arrival), frameId: 'trusted:frame',
      burstId: 'trusted:burst', now,
      decision: {
        script: '她看见消息，回复“我在”。',
        interaction: { seen: true, reply: { mode: 'immediate' as const, content: '我在' } },
      },
    }
    const deny = {
      authoritative: false, attemptedTravel: false,
      claimsCompletedAction: false, completionEvidenceVerified: false,
    }
    const allow = { ...deny, authoritative: true }
    await assert.rejects(() => service.observeR1AndPrepare(input, deny), /R1_REALITY_GATE/)
    assert.equal((await inbox.unread(arrival.storyId, arrival.participantId)).length, 1)
    await service.transitionR1Attention(arrival.storyId, 'CHECK', now)
    const result = await service.observeR1AndPrepare(input, allow)
    assert.equal(result.status, 'proposal-only')
    assert.equal(result.sideEffects, 'none')
    assert.equal(result.commit.events.filter(event => event.kind === 'outgoing-message').length, 1)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 1)
    const review = await service.pendingR1Review(arrival.storyId, arrival.participantId)
    assert.equal(review.length, 1)
    assert.equal(review[0].status, 'pending-review')
    const same = await service.observeR1AndPrepare(input, allow)
    assert.equal(same.sourceScriptEntryId, result.sourceScriptEntryId)
    assert.equal(same.commit.commitId, result.commit.commitId)
    assert.equal((await service.pendingR1Review(arrival.storyId, arrival.participantId)).length, 1)
    const rejected = await service.rejectR1Proposal(review[0].id, 'host rejected unsafe wording')
    assert.equal(rejected.status, 'rejected')
    assert.equal((await service.pendingR1Review(arrival.storyId, arrival.participantId)).length, 0)
    await assert.rejects(() => service.observeR1AndPrepare({ ...input, participantId: 'other' }, allow), /R1_INBOX_IDENTITY_MISMATCH/)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: arrival.storyId })).length, 1)
  } finally { await app.stop() }
})

test('R2 service proposal never becomes an action, and disabled host gate refuses submission', async () => {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  registerTables(app)
  registerR2GoalTables(app)
  let service!: InterludeService
  let state!: R2GoalLedger
  app.inject(['database'], ctx => {
    const fixture: any = Object.create(InterludeService.prototype)
    fixture.ctx = ctx
    fixture.queues = new Map()
    fixture.desktopRuntimePhase = 'running'
    state = new R2GoalLedger(ctx)
    fixture.r2GoalLedger = state
    service = fixture as InterludeService
  })
  try {
    await app.start()
    const date = new Date()
    const evidence = {
      storyId: 'r2:service:story',
      observedAt: new Date(date.getTime() - 2_000).toISOString(),
      now: date.toISOString(),
      verifiedByHost: true, energy: 90, activityLoad: 'free' as const,
      attentionMode: 'attentive' as const,
      commitments: [], verifiedSourceEntryIds: [], permittedContactParticipantIds: [],
    }
    // The proposal is persisted, but must not manufacture canonical messages.
    const proposal = await service.submitR2HostGoal(evidence)
    assert.equal(proposal.status, 'proposed')
    assert.equal(proposal.goal, 'quiet-reflection')
    assert.equal((await state.history(evidence.storyId)).length, 1)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: evidence.storyId })).length, 0)
    const restored = await service.restoreR2Review(evidence.storyId)
    assert.equal(restored?.proposalId, proposal.proposalId)
    assert.equal((await state.history(evidence.storyId)).length, 1)
    const disabled: any = Object.create(InterludeService.prototype)
    await assert.rejects(() => disabled.submitR2HostGoal(evidence), /R2_GOAL_LEDGER_DISABLED/)
  } finally { await app.stop() }
})
