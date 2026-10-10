import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import type { R1InboxRow } from './inbox'
import type { R1ProposalReceiptRow } from './proposal-receipts'

/**
 * R1 candidate-only effect ledger. This component NEVER invokes a platform,
 * narrator or Koishi Bot. 'accepted' means an authenticated adapter acknowledged
 * a send, NOT that the recipient received it.
 */
export type R1OutboxStatus = 'authorized' | 'attempting' | 'accepted' | 'rejected' | 'unknown'

export interface R1OutboxRow {
  id: string
  storyId: string
  participantId: string
  sourceInboxId: string
  platform: string
  endpointId: string
  commitId: string
  eventId: string
  payloadHash: string
  approvalId: string
  principalId: string
  status: R1OutboxStatus
  revision: number
  approvedAt: Date
  expiresAt: Date
  updatedAt: Date
  attemptId?: string
  attemptAt?: Date
  completedAt?: Date
  adapterMessageId?: string
  reason?: string
}

export interface R1OutboxEventRow {
  id: string
  outboxId: string
  revision: number
  kind: R1OutboxStatus
  occurredAt: Date
  attemptId?: string
  reason?: string
}

declare module 'koishi' {
  interface Tables {
    interlude_r1_outbox: R1OutboxRow
    interlude_r1_outbox_event: R1OutboxEventRow
  }
}

export function registerR1OutboxTables(ctx: Context): void {
  const tables = (ctx.model as any).tables ?? {}
  if (!tables.interlude_r1_outbox) ctx.model.extend('interlude_r1_outbox', {
    id: 'string(64)', storyId: 'string(255)', participantId: 'string(255)',
    sourceInboxId: 'string(64)', platform: 'string(63)', endpointId: 'string(127)',
    commitId: 'string(100)', eventId: 'string(120)', payloadHash: 'string(64)',
    approvalId: 'string(128)', principalId: 'string(128)', status: 'string(20)',
    revision: 'unsigned', approvedAt: 'timestamp', expiresAt: 'timestamp',
    updatedAt: 'timestamp', attemptId: 'string(64)', attemptAt: 'timestamp',
    completedAt: 'timestamp', adapterMessageId: 'string(255)', reason: 'string(255)',
  }, { primary: 'id', indexes: ['storyId', 'status', 'endpointId'] })
  if (!tables.interlude_r1_outbox_event) ctx.model.extend('interlude_r1_outbox_event', {
    id: 'string(64)', outboxId: 'string(64)', revision: 'unsigned',
    kind: 'string(20)', occurredAt: 'timestamp', attemptId: 'string(64)', reason: 'string(255)',
  }, { primary: 'id', indexes: ['outboxId', 'revision'] })
}

const sha = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const driverQueues = new WeakMap<object, Promise<void>>()

export interface R1ApprovalRequest {
  receiptId: string
  storyId: string
  participantId: string
  sourceInboxId: string
  platform: string
  endpointId: string
  commitId: string
  eventId: string
  payloadHash: string
  approvalId: string
  principalId: string
  actionClass: 'r1-private-text'
  approvedAt: Date
  expiresAt: Date
}

/** 
 * Must be provided by a separately authenticated, trusted host component.
 * NOT a caller-supplied "authorized: true" or model statement.
 * The verifier is responsible for binding ALL fields, scope and principal.
 */
export type R1ApprovalVerifier = (request: Readonly<R1ApprovalRequest>) => Promise<boolean>

export class R1AuthorizedOutbox {
  private preparing?: Promise<void>

  constructor(private readonly ctx: Context, private readonly verifier?: R1ApprovalVerifier) {}

  private async ensureTables() {
    if (!this.preparing) {
      this.preparing = (async () => {
        const driver = (this.ctx.database as unknown as {
          _driver?: { prepare?: (table: string) => Promise<void> }
        })._driver
        if (typeof driver?.prepare !== 'function') throw Error('R1_OUTBOX_SCHEMA_UNAVAILABLE')
        await driver.prepare('interlude_r1_outbox')
        await driver.prepare('interlude_r1_outbox_event')
      })().catch(error => { this.preparing = undefined; throw error })
    }
    await this.preparing
  }

  private async transaction<T>(fn: (tx: typeof this.ctx.database) => Promise<T>): Promise<T> {
    const db = this.ctx.database as typeof this.ctx.database & {
      withTransaction?: (fn: (tx: typeof this.ctx.database) => Promise<T>) => Promise<T>
    }
    if (typeof db.withTransaction !== 'function') throw Error('R1_OUTBOX_TRANSACTION_REQUIRED')
    const key = ((db as unknown as { _driver?: object })._driver ?? db) as object
    const prior = driverQueues.get(key) ?? Promise.resolve()
    const current = prior.then(() => db.withTransaction!(fn))
    driverQueues.set(key, current.then(() => undefined, () => undefined))
    return current
  }

  private async append(tx: typeof this.ctx.database, row: R1OutboxRow, at: Date): Promise<void> {
    await tx.create('interlude_r1_outbox_event', {
      id: sha(['r1-outbox-event', row.id, row.revision]),
      outboxId: row.id, revision: row.revision, kind: row.status,
      occurredAt: at, ...(row.attemptId ? { attemptId: row.attemptId } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    })
  }

  /** No verifier means fail-closed. Only private-text reviews are in scope. */
  async authorize(request: R1ApprovalRequest, at = new Date()): Promise<R1OutboxRow> {
    if (!this.verifier) throw Error('R1_OUTBOX_HOST_VERIFIER_MISSING')
    const a = request?.approvedAt?.getTime(), e = request?.expiresAt?.getTime(), n = at.getTime()
    if (!Number.isFinite(a) || !Number.isFinite(e) || !Number.isFinite(n)
      || e! <= a! || e! - a! > 60_000 || a! > n || e! <= n
      || request.actionClass !== 'r1-private-text'
      || !request.receiptId || !request.principalId || !request.approvalId
      || !request.storyId || !request.participantId || !request.endpointId
      || !request.platform || !request.payloadHash || !request.sourceInboxId) {
      throw Error('R1_OUTBOX_INVALID_APPROVAL')
    }
    // Verification is deliberately performed outside the SQLite transaction.
    if (await this.verifier({ ...request }) !== true) throw Error('R1_OUTBOX_HOST_DENIED')
    await this.ensureTables()
    return this.transaction(async tx => {
      const review = (await tx.get('interlude_r1_proposal_receipt', { id: request.receiptId }))[0] as R1ProposalReceiptRow | undefined
      const source = (await tx.get('interlude_r1_inbox', { id: request.sourceInboxId }))[0] as R1InboxRow | undefined
      if (!review
        || review.storyId !== request.storyId || review.participantId !== request.participantId
        || review.sourceInboxId !== request.sourceInboxId
        || review.commitId !== request.commitId || review.eventId !== request.eventId
        || review.contentHash !== request.payloadHash
        || !source || source.status !== 'observed'
        || source.scriptEntryId !== review.sourceScriptEntryId
        || source.storyId !== request.storyId || source.participantId !== request.participantId
        || source.endpointId !== request.endpointId || source.platform !== request.platform) {
        throw Error('R1_OUTBOX_SOURCE_BINDING_FAILED')
      }
      const prior = (await tx.get('interlude_r1_outbox', { id: request.receiptId }))[0]
      if (prior) {
        if (review.status !== 'authorized') throw Error('R1_OUTBOX_REVIEW_STATE_MISMATCH')
        if (prior.approvalId !== request.approvalId || prior.principalId !== request.principalId
          || prior.endpointId !== request.endpointId || prior.payloadHash !== request.payloadHash
          || prior.expiresAt.getTime() !== e) throw Error('R1_OUTBOX_APPROVAL_REPLAY_CONFLICT')
        return prior
      }
      if (review.status !== 'pending-review') throw Error('R1_OUTBOX_REVIEW_NOT_PENDING')
      // The review becomes authorized in the SAME transaction as the Outbox.
      // It must no longer be visible in a pending-review queue or rejectable.
      const transitioned = await tx.set('interlude_r1_proposal_receipt', {
        id: review.id, revision: review.revision, status: 'pending-review',
      }, { status: 'authorized', revision: review.revision + 1, updatedAt: at })
      if (transitioned.matched !== 1) throw Error('R1_OUTBOX_REVIEW_CAS_CONFLICT')
      const row: R1OutboxRow = {
        id: review.id, storyId: review.storyId, participantId: review.participantId,
        sourceInboxId: review.sourceInboxId, platform: source.platform, endpointId: source.endpointId,
        commitId: review.commitId, eventId: review.eventId, payloadHash: review.contentHash,
        approvalId: request.approvalId, principalId: request.principalId,
        status: 'authorized', revision: 1, approvedAt: request.approvedAt,
        expiresAt: request.expiresAt, updatedAt: at,
      }
      await tx.create('interlude_r1_outbox', row)
      await this.append(tx, row, at)
      return row
    })
  }

  /**
   * Reserve an attempt durably BEFORE any transport call.
   * The returned row is not a permission to auto-send; the trusted host owns
   * the separate platform-action authorization and transport boundary.
   */
  async claim(id: string, at = new Date()): Promise<R1OutboxRow> {
    await this.ensureTables()
    return this.transaction(async tx => {
      const old = (await tx.get('interlude_r1_outbox', { id }))[0]
      if (!old || old.status !== 'authorized') throw Error('R1_OUTBOX_NOT_CLAIMABLE')
      if (!Number.isFinite(at.getTime()) || at < old.approvedAt || at >= old.expiresAt) throw Error('R1_OUTBOX_EXPIRED')
      const next: R1OutboxRow = {
        ...old, status: 'attempting', revision: old.revision + 1,
        attemptId: sha(['r1-outbox-attempt', old.id, old.approvalId, old.revision + 1]),
        attemptAt: at, updatedAt: at,
      }
      const updated = await tx.set('interlude_r1_outbox', { id, revision: old.revision, status: 'authorized' }, {
        status: next.status, revision: next.revision, attemptId: next.attemptId,
        attemptAt: at, updatedAt: at,
      })
      if (updated.matched !== 1) throw Error('R1_OUTBOX_CAS_CONFLICT')
      await this.append(tx, next, at)
      return next
    })
  }

  /** Caller must be a trusted transport result handler, never the LLM. */
  async settle(id: string, attemptId: string, result: 'accepted' | 'rejected' | 'unknown',
    at = new Date(), adapterMessageId?: string, reason?: string): Promise<R1OutboxRow> {
    if (!['accepted', 'rejected', 'unknown'].includes(result) || !attemptId
      || !Number.isFinite(at.getTime()) || (result === 'accepted' && !adapterMessageId?.trim())
      || (adapterMessageId !== undefined && adapterMessageId.length > 255)
      || (reason !== undefined && reason.length > 255)) throw Error('R1_OUTBOX_INVALID_RESULT')
    await this.ensureTables()
    return this.transaction(async tx => {
      const old = (await tx.get('interlude_r1_outbox', { id }))[0]
      if (!old || old.attemptId !== attemptId || old.status !== 'attempting') {
        throw Error('R1_OUTBOX_STALE_ATTEMPT')
      }
      if (old.attemptAt && at < old.attemptAt) throw Error('R1_OUTBOX_CLOCK_REWIND')
      const next: R1OutboxRow = {
        ...old, status: result, revision: old.revision + 1, updatedAt: at, completedAt: at,
        ...(adapterMessageId ? { adapterMessageId } : {}),
        ...(reason ? { reason } : {}),
      }
      const updated = await tx.set('interlude_r1_outbox', {
        id, revision: old.revision, status: 'attempting', attemptId,
      }, {
        status: result, revision: next.revision, updatedAt: at, completedAt: at,
        ...(adapterMessageId ? { adapterMessageId } : {}),
        ...(reason ? { reason } : {}),
      })
      if (updated.matched !== 1) throw Error('R1_OUTBOX_CAS_CONFLICT')
      await this.append(tx, next, at)
      return next
    })
  }

  async current(id: string): Promise<R1OutboxRow | undefined> {
    await this.ensureTables()
    return (await this.ctx.database.get('interlude_r1_outbox', { id }))[0]
  }

  async history(id: string): Promise<R1OutboxEventRow[]> {
    await this.ensureTables()
    return this.ctx.database.get('interlude_r1_outbox_event', { outboxId: id },
      { sort: { revision: 'asc' }, limit: 100 })
  }

  async uncertain(storyId: string): Promise<R1OutboxRow[]> {
    await this.ensureTables()
    return this.ctx.database.get('interlude_r1_outbox', { storyId, status: 'unknown' },
      { sort: { updatedAt: 'asc' }, limit: 100 })
  }
}
