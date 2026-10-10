import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import { proposeYukaGoal, type R2Goal, type R2HostEvidence } from './yuka-goal-planner'

export type R2GoalStatus = 'proposed' | 'review-due'
export interface R2GoalStateRow {
  storyId: string
  proposalId: string
  goal: R2Goal
  evidenceFingerprint: string
  evidenceSourceIds: number[]
  status: R2GoalStatus
  revision: number
  proposedAt: Date
  nextReviewAt: Date
  updatedAt: Date
}
export interface R2GoalEventRow {
  id: string
  storyId: string
  proposalId: string
  goal: R2Goal
  kind: 'proposed' | 'review-due'
  evidenceFingerprint: string
  occurredAt: Date
}

declare module 'koishi' {
  interface Tables {
    interlude_r2_goal_state: R2GoalStateRow
    interlude_r2_goal_event: R2GoalEventRow
  }
}

/** Only additive candidate tables. Never rewrite the HDSI or R1 canonical tables. */
export function registerR2GoalTables(ctx: Context): void {
  const tables = (ctx.model as any).tables ?? {}
  if (!tables.interlude_r2_goal_state) ctx.model.extend('interlude_r2_goal_state', {
    storyId: 'string(255)', proposalId: 'string(64)', goal: 'string(40)',
    evidenceFingerprint: 'string(64)', evidenceSourceIds: 'json',
    status: 'string(16)', revision: 'unsigned', proposedAt: 'timestamp',
    nextReviewAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'storyId' })
  if (!tables.interlude_r2_goal_event) ctx.model.extend('interlude_r2_goal_event', {
    id: 'string(64)', storyId: 'string(255)', proposalId: 'string(64)',
    goal: 'string(40)', kind: 'string(16)', evidenceFingerprint: 'string(64)',
    occurredAt: 'timestamp',
  }, { primary: 'id', indexes: ['storyId', 'proposalId'] })
}

const sha = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const intervals: Record<R2Goal, number> = {
  rest: 20, 'fulfill-commitment': 30, 'consider-contact': 10, 'quiet-reflection': 60,
}
const ms = (value: Date) => new Date(value).getTime()

/**
 * Durable, transaction-bound shadow proposals. Events are observations of a
 * *proposal*, never real-world activity, sent messages, or authorization.
 * The host supplies a trustworthy clock and canonical ScriptEntry database.
 */
export class R2GoalLedger {
  constructor(private readonly ctx: Context, private readonly clock: () => Date = () => new Date()) {}

  private prepared?: Promise<void>

  /**
   * SQLite/Minato lazily prepares dynamically registered tables. Preparing
   * outside the write transaction prevents a rejected first proposal from
   * rolling back its CREATE TABLE alongside the proposal.
   * This adapter requires the real Minato driver schema API, or fails closed.
   */
  private async ensureSchema(): Promise<void> {
    if (!this.prepared) {
      this.prepared = (async () => {
        const driver = (this.ctx.database as unknown as {
          _driver?: { prepare?: (name: string) => Promise<void> }
        })._driver
        if (typeof driver?.prepare !== 'function') throw new Error('R2_MINATO_SCHEMA_PREPARE_UNAVAILABLE')
        await driver.prepare('interlude_r2_goal_state')
        await driver.prepare('interlude_r2_goal_event')
      })().catch(error => { this.prepared = undefined; throw error })
    }
    await this.prepared
  }

  async current(storyId: string): Promise<R2GoalStateRow | undefined> {
    await this.ensureSchema()
    const rows = await this.ctx.database.get('interlude_r2_goal_state', { storyId })
    return rows[0]
  }

  async history(storyId: string): Promise<R2GoalEventRow[]> {
    await this.ensureSchema()
    const rows = await this.ctx.database.get('interlude_r2_goal_event', { storyId }, {
      sort: { occurredAt: 'asc' }, limit: 100,
    })
    return rows.sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt) || a.id.localeCompare(b.id))
  }

  private transaction<T>(callback: (tx: typeof this.ctx.database) => Promise<T>): Promise<T> {
    const db = this.ctx.database as typeof this.ctx.database & {
      withTransaction?: (callback: (tx: typeof this.ctx.database) => Promise<T>) => Promise<T>
    }
    if (typeof db.withTransaction !== 'function') throw new Error('R2_REAL_TRANSACTION_REQUIRED')
    return db.withTransaction(callback)
  }

  /**
   * A model-provided list of "verified IDs" is not proof. The trusted host
   * checks every ID against this story's actual canonical ScriptEntry rows.
   */
  async submit(evidence: R2HostEvidence): Promise<R2GoalStateRow> {
    const observedNow = new Date(evidence.now)
    const hostNow = this.clock()
    if (!Number.isFinite(observedNow.getTime()) || !Number.isFinite(hostNow.getTime())
      || Math.abs(observedNow.getTime() - hostNow.getTime()) > 60_000) {
      throw new Error('R2_HOST_CLOCK_MISMATCH')
    }
    const proposal = proposeYukaGoal(evidence)
    await this.ensureSchema()
    if (proposal.status !== 'proposed' || !proposal.goal || proposal.sideEffects !== 'none') {
      throw new Error('R2_EVIDENCE_INCOMPLETE')
    }
    const proposalId = sha(['r2-proposal', evidence.storyId, proposal.goal, proposal.evidenceFingerprint])
    const eventId = sha(['r2-event', proposalId, 'proposed'])
    const now = new Date(observedNow)
    const candidate: Omit<R2GoalStateRow, 'revision'> = {
      storyId: evidence.storyId, proposalId, goal: proposal.goal,
      evidenceFingerprint: proposal.evidenceFingerprint,
      evidenceSourceIds: [...evidence.verifiedSourceEntryIds],
      status: 'proposed', proposedAt: now,
      nextReviewAt: new Date(now.getTime() + intervals[proposal.goal] * 60_000),
      updatedAt: now,
    }
    return this.transaction(async tx => {
      const ids = evidence.verifiedSourceEntryIds
      if (ids.length) {
        const existingEntries = await tx.get('interlude_script_entry', {
          storyId: evidence.storyId, id: { $in: ids },
        })
        const matched = new Set(existingEntries.map(entry => entry.id))
        if (matched.size !== ids.length || ids.some(id => !matched.has(id))) {
          throw new Error('R2_SCRIPT_SOURCE_NOT_FOUND')
        }
      }

      const old = (await tx.get('interlude_r2_goal_state', { storyId: evidence.storyId }))[0]
      if (old?.proposalId === proposalId) return old
      if (old && ms(now) < ms(old.updatedAt)) throw new Error('R2_CLOCK_REWIND')

      // An already committed proposal must not be reactivated after another
      // proposal supersedes it, even if a delayed worker retries submission.
      const recorded = await tx.get('interlude_r2_goal_event', { id: eventId })
      if (recorded.length) throw new Error('R2_STALE_PROPOSAL_REPLAY')

      const next: R2GoalStateRow = { ...candidate, revision: (old?.revision ?? 0) + 1 }
      await tx.create('interlude_r2_goal_event', {
        id: eventId, storyId: evidence.storyId, proposalId, goal: proposal.goal,
        kind: 'proposed', evidenceFingerprint: proposal.evidenceFingerprint, occurredAt: now,
      })
      if (!old) {
        await tx.create('interlude_r2_goal_state', next)
      } else {
        const updated = await tx.set('interlude_r2_goal_state', {
          storyId: evidence.storyId, revision: old.revision,
        }, {
          proposalId: next.proposalId, goal: next.goal,
          evidenceFingerprint: next.evidenceFingerprint, evidenceSourceIds: next.evidenceSourceIds,
          status: next.status, revision: next.revision, proposedAt: next.proposedAt,
          nextReviewAt: next.nextReviewAt, updatedAt: next.updatedAt,
        })
        if (updated.matched !== 1) throw new Error('R2_GOAL_REVISION_CONFLICT')
      }
      return next
    })
  }

  /**
   * Deterministic time advance with an event receipt. It marks only that a
   * proposal needs a fresh host observation. It never says an action occurred.
   */
  async advanceReview(storyId: string, at: Date = this.clock()): Promise<R2GoalStateRow | undefined> {
    await this.ensureSchema()
    const atTime = ms(at)
    if (!storyId || !Number.isFinite(atTime)) throw new Error('R2_INVALID_REVIEW_TIME')
    if (atTime > this.clock().getTime() + 60_000) throw new Error('R2_FUTURE_REVIEW_FORBIDDEN')
    return this.transaction(async tx => {
      const old = (await tx.get('interlude_r2_goal_state', { storyId }))[0]
      if (!old || old.status === 'review-due' || atTime < ms(old.nextReviewAt)) return old
      if (atTime < ms(old.updatedAt)) throw new Error('R2_CLOCK_REWIND')
      const next: R2GoalStateRow = { ...old, status: 'review-due', revision: old.revision + 1, updatedAt: at }
      const receiptId = sha(['r2-event', old.proposalId, 'review-due'])
      await tx.create('interlude_r2_goal_event', {
        id: receiptId, storyId, proposalId: old.proposalId, goal: old.goal,
        kind: 'review-due', evidenceFingerprint: old.evidenceFingerprint, occurredAt: at,
      })
      const updated = await tx.set('interlude_r2_goal_state', {
        storyId, revision: old.revision, status: 'proposed',
      }, { status: 'review-due', revision: next.revision, updatedAt: at })
      if (updated.matched !== 1) throw new Error('R2_GOAL_REVISION_CONFLICT')
      return next
    })
  }
}
