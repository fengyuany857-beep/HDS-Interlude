import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import type { ObservedCommitProposal } from './observed-commit'
import { isOutgoingScriptEvent } from '../script/contract'
import { validateScriptCommit } from '../script/validator'

/** A durable review inbox, not a sender or evidence of real delivery. */
export interface R1ProposalReceiptRow {
  id: string
  storyId: string
  participantId: string
  sourceInboxId: string
  sourceScriptEntryId: number
  sourceKind?: 'inbound' | 'background'
  platform?: string
  endpointId?: string
  commitId: string
  eventId: string
  contentHash: string
  payloadContent: string
  deliveryKind: 'immediate' | 'delayed' | 'proactive'
  notBefore?: Date
  status: 'pending-review' | 'authorized' | 'rejected'
  revision: number
  createdAt: Date
  updatedAt: Date
  reason?: string
}

declare module 'koishi' {
  interface Tables {
    interlude_r1_proposal_receipt: R1ProposalReceiptRow
  }
}

export function registerR1ProposalReceiptTable(ctx: Context): void {
  if ((ctx.model as any).tables?.interlude_r1_proposal_receipt) return
  ctx.model.extend('interlude_r1_proposal_receipt', {
    id: 'string(64)', storyId: 'string(255)', participantId: 'string(255)',
    sourceInboxId: 'string(64)', sourceScriptEntryId: 'unsigned', sourceKind: 'string(16)',
    platform: 'string(63)', endpointId: 'string(127)',
    commitId: 'string(100)', eventId: 'string(120)', contentHash: 'string(64)', payloadContent: 'text',
    deliveryKind: 'string(16)', notBefore: 'timestamp',
    status: 'string(20)', revision: 'unsigned', createdAt: 'timestamp',
    updatedAt: 'timestamp', reason: 'string(500)',
  }, { primary: 'id', indexes: ['storyId', 'participantId', 'status'] })
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const queues = new WeakMap<object, Promise<void>>()

/**
 * Stores reviewed *proposals* separately from transport results.
 * Replays with the same event identity are idempotent; altered payloads fail.
 * No method in this class can mark delivery successful or emit a message.
 */
export class R1ProposalReceipts {
  private preparation?: Promise<void>
  constructor(private readonly ctx: Context) {}

  private async ensureTable(): Promise<void> {
    if (!this.preparation) {
      this.preparation = (async () => {
        const driver = (this.ctx.database as unknown as { _driver?: { prepare?: (name: string) => Promise<void> } })._driver
        if (!driver?.prepare) throw new Error('R1_RECEIPT_SQLITE_REQUIRED')
        await driver.prepare('interlude_r1_proposal_receipt')
      })().catch(error => { this.preparation = undefined; throw error })
    }
    await this.preparation
  }

  private async transaction<T>(cb: (tx: typeof this.ctx.database) => Promise<T>): Promise<T> {
    const db = this.ctx.database as typeof this.ctx.database & {
      withTransaction?: (fn: (tx: typeof this.ctx.database) => Promise<T>) => Promise<T>
    }
    if (typeof db.withTransaction !== 'function') throw new Error('R1_RECEIPT_TRANSACTION_REQUIRED')
    const key = ((db as unknown as { _driver?: object })._driver ?? db) as object
    const prev = queues.get(key) ?? Promise.resolve()
    const running = prev.then(() => db.withTransaction!(cb))
    queues.set(key, running.then(() => undefined, () => undefined))
    return running
  }

  /** Prepare schema before parent Inbox transaction to avoid nested DDL. */
  async prepareAtomic(): Promise<void> { await this.ensureTable() }

  async open(proposal: ObservedCommitProposal, at = new Date(),
    parentTransaction?: typeof this.ctx.database): Promise<R1ProposalReceiptRow[]> {
    if (proposal?.status !== 'proposal-only' || proposal.sideEffects !== 'none'
      || proposal.requiresHostDeliveryAuthorization !== true || proposal.requiresHostRealityGate !== true
      || !Number.isFinite(at.getTime())) throw new Error('R1_RECEIPT_UNTRUSTED_PROPOSAL')
    const commit = proposal.commit
    if (!validateScriptCommit(commit).valid) throw new Error('R1_RECEIPT_INVALID_COMMIT')
    const events = commit.events.filter(isOutgoingScriptEvent)
    if (events.some(event => event.kind !== 'outgoing-message'
      || !['immediate', 'delayed'].includes(event.deliveryMode)
      || event.scriptBinding?.status !== (event.deliveryMode === 'immediate' ? 'bound' : 'future')
      || event.participantId !== commit.participantId)) throw new Error('R1_RECEIPT_UNREVIEWED_EVENT')
    await this.ensureTable()
    const persist = async (tx: typeof this.ctx.database): Promise<R1ProposalReceiptRow[]> => {
      const source = (await tx.get('interlude_r1_inbox', {
        id: proposal.sourceInboxId, storyId: commit.storyId,
        participantId: commit.participantId, status: 'observed',
      }))[0]
      const entry = (await tx.get('interlude_script_entry', {
        id: proposal.sourceScriptEntryId, storyId: commit.storyId,
        participantId: commit.participantId,
      }))[0]
      if (!source || source.scriptEntryId !== proposal.sourceScriptEntryId
        || !entry || entry.metadata?.sourceInboxId !== proposal.sourceInboxId
        || entry.kind !== 'user-message' || entry.actor !== 'user') throw new Error('R1_RECEIPT_SOURCE_MISMATCH')
      // One observed platform message must not spawn multiple divergent
      // outbound reviews merely because a caller replays with a new clock.
      const priorForSource = await tx.get('interlude_r1_proposal_receipt', {
        sourceInboxId: proposal.sourceInboxId,
      })
      if (priorForSource.some(row => row.commitId !== commit.commitId
        || row.sourceScriptEntryId !== proposal.sourceScriptEntryId)) {
        throw new Error('R1_RECEIPT_SOURCE_ALREADY_PROPOSED')
      }
      const result: R1ProposalReceiptRow[] = []
      for (const event of events) {
        const deliveryKind = event.deliveryMode as 'immediate' | 'delayed'
        const notBefore = deliveryKind === 'delayed' ? new Date(event.occurredAt) : undefined
        if (notBefore && (!Number.isFinite(notBefore.getTime()) || notBefore <= at)) {
          throw new Error('R1_RECEIPT_INVALID_SCHEDULE')
        }
        const id = digest(['r1-proposal', commit.storyId, commit.participantId, commit.commitId, event.eventId])
        const hash = digest([event.content, event.bubbles, event.scriptBinding])
        const found = (await tx.get('interlude_r1_proposal_receipt', { id }))[0]
        if (found) {
          if (found.contentHash !== hash || found.payloadContent !== event.content
            || found.sourceInboxId !== proposal.sourceInboxId
            || (found.deliveryKind ?? 'immediate') !== deliveryKind
            || (found.notBefore?.getTime() ?? 0) !== (notBefore?.getTime() ?? 0)
            || found.sourceScriptEntryId !== proposal.sourceScriptEntryId) throw new Error('R1_RECEIPT_REPLAY_CONFLICT')
          result.push(found)
          continue
        }
        const row: R1ProposalReceiptRow = {
          id, storyId: commit.storyId, participantId: commit.participantId,
          sourceInboxId: proposal.sourceInboxId, sourceScriptEntryId: proposal.sourceScriptEntryId,
          sourceKind: 'inbound', platform: source.platform, endpointId: source.endpointId,
          commitId: commit.commitId, eventId: event.eventId, contentHash: hash,
          payloadContent: event.content,
          deliveryKind, ...(notBefore ? { notBefore } : {}),
          status: 'pending-review', revision: 1, createdAt: at, updatedAt: at,
        }
        await tx.create('interlude_r1_proposal_receipt', row)
        result.push(row)
      }
      return result
    }
    return parentTransaction ? persist(parentTransaction) : this.transaction(persist)
  }

  /**
   * Opens a review for a proactive event already persisted by the existing
   * narrative/Agency pipeline. It derives every authority-bearing field from
   * the canonical ScriptEntry and endpoint registry; it never sends.
   */
  async openBackground(scriptEntryId: number, eventId: string, at = new Date()): Promise<R1ProposalReceiptRow> {
    if (!Number.isSafeInteger(scriptEntryId) || scriptEntryId <= 0 || !eventId?.trim()
      || !Number.isFinite(at.getTime())) throw new Error('R1_BACKGROUND_INVALID_SOURCE')
    await this.ensureTable()
    return this.transaction(async tx => {
      const entry = (await tx.get('interlude_script_entry', { id: scriptEntryId }))[0]
      const events = entry?.metadata?.scriptEvents
      const approved = entry?.metadata?.approvedAutomaticOutgoingActions
      if (!entry || entry.kind !== 'script' || entry.actor !== 'narrator'
        || !['advance', 'intent-due'].includes(String(entry.metadata?.phase))
        || !Array.isArray(events) || !Array.isArray(approved)) throw new Error('R1_BACKGROUND_SOURCE_MISMATCH')
      const event = events.find((item: any) => item?.eventId === eventId)
      if (!isOutgoingScriptEvent(event) || event.kind !== 'outgoing-message'
        || event.deliveryMode !== 'immediate' || event.scriptBinding?.status !== 'bound'
        || !event.participantId || !event.endpointId
        || !approved.some((item: any) => item?.participantId === event.participantId && item?.mode === 'immediate')) {
        throw new Error('R1_BACKGROUND_EVENT_UNREVIEWED')
      }
      const endpoint = (await tx.get('interlude_endpoint', { id: event.endpointId }))[0]
      if (!endpoint || endpoint.enabled !== true || endpoint.ownerKind !== 'participant-user'
        || endpoint.ownerId !== event.participantId || endpoint.conversationKind !== 'private') {
        throw new Error('R1_BACKGROUND_ENDPOINT_MISMATCH')
      }
      const commitId = String(event.commitId)
      if (entry.metadata?.commitId !== commitId) throw new Error('R1_BACKGROUND_COMMIT_MISMATCH')
      const id = digest(['r1-proposal', entry.storyId, event.participantId, commitId, event.eventId])
      const hash = digest([event.content, event.bubbles, event.scriptBinding])
      const prior = (await tx.get('interlude_r1_proposal_receipt', { id }))[0]
      if (prior) {
        if (prior.sourceKind !== 'background' || prior.sourceScriptEntryId !== scriptEntryId
          || prior.contentHash !== hash || prior.endpointId !== endpoint.id) throw new Error('R1_RECEIPT_REPLAY_CONFLICT')
        return prior
      }
      const row: R1ProposalReceiptRow = {
        id, storyId: entry.storyId, participantId: event.participantId,
        sourceInboxId: `background:${scriptEntryId}`, sourceScriptEntryId: scriptEntryId,
        sourceKind: 'background', platform: endpoint.platform, endpointId: endpoint.id,
        commitId, eventId: event.eventId, contentHash: hash, payloadContent: event.content,
        deliveryKind: 'proactive', status: 'pending-review', revision: 1, createdAt: at, updatedAt: at,
      }
      await tx.create('interlude_r1_proposal_receipt', row)
      return row
    })
  }

  async pending(storyId: string, participantId: string): Promise<R1ProposalReceiptRow[]> {
    await this.ensureTable()
    return this.ctx.database.get('interlude_r1_proposal_receipt', {
      storyId, participantId, status: 'pending-review',
    }, { sort: { createdAt: 'asc' }, limit: 100 })
  }

  /** Host may explicitly reject a proposal; it is never interpreted as sent. */
  async reject(id: string, reason: string, at = new Date()): Promise<R1ProposalReceiptRow> {
    if (!id || !reason.trim() || reason.length > 500 || !Number.isFinite(at.getTime())) throw Error('R1_RECEIPT_INVALID_REJECTION')
    await this.ensureTable()
    return this.transaction(async tx => {
      const row = (await tx.get('interlude_r1_proposal_receipt', { id }))[0]
      if (!row) throw Error('R1_RECEIPT_UNKNOWN')
      if (row.status === 'rejected') return row
      if (row.status === 'authorized') throw Error('R1_RECEIPT_ALREADY_AUTHORIZED')
      const matched = await tx.set('interlude_r1_proposal_receipt', {
        id, revision: row.revision, status: 'pending-review',
      }, { status: 'rejected', reason, revision: row.revision + 1, updatedAt: at })
      if (matched.matched !== 1) throw Error('R1_RECEIPT_CAS_CONFLICT')
      return { ...row, status: 'rejected', reason, revision: row.revision + 1, updatedAt: at }
    })
  }
}
