import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import { mayObserve, transitionAttention, type AttentionEvent, type AttentionMode } from './attention'

export interface R1InboxRow {
  id: string
  storyId: string
  participantId: string
  platform: string
  endpointId: string
  platformMessageId: string
  content: string
  metadata: Record<string, unknown>
  status: 'unobserved' | 'observed'
  receivedAt: Date
  observedAt?: Date
  scriptEntryId?: number
}
export interface R1AttentionRow {
  storyId: string
  mode: AttentionMode
  revision: number
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    interlude_r1_inbox: R1InboxRow
    interlude_r1_attention: R1AttentionRow
  }
}

export interface R1Arrival {
  storyId: string
  participantId: string
  platform: string
  endpointId: string
  platformMessageId: string
  content: string
  metadata?: Record<string, unknown>
  receivedAt: Date
}
export function stableInboxId(row: Pick<R1Arrival, 'storyId' | 'participantId' | 'platform' | 'endpointId' | 'platformMessageId'>): string {
  const parts = [row.storyId, row.participantId, row.platform, row.endpointId, row.platformMessageId]
  if (parts.some(part => typeof part !== 'string' || !part.trim())) throw new Error('R1_STABLE_ID_REQUIRED')
  return createHash('sha256').update(JSON.stringify(['hdsi-r1-inbox', ...parts])).digest('hex')
}

/** Adds tables without rebuilding the canonical HDSI tables. */
export function registerR1Tables(ctx: Context) {
  const tables = (ctx.model as any).tables ?? {}
  if (!tables.interlude_r1_inbox) ctx.model.extend('interlude_r1_inbox', {
    id: 'string(64)', storyId: 'string(255)', participantId: 'string(255)',
    platform: 'string(63)', endpointId: 'string(127)', platformMessageId: 'string(255)',
    content: 'text', metadata: 'json', status: 'string(16)',
    receivedAt: 'timestamp', observedAt: 'timestamp', scriptEntryId: 'unsigned',
  }, { primary: 'id', indexes: ['storyId', 'participantId', 'status', 'receivedAt'] })
  if (!tables.interlude_r1_attention) ctx.model.extend('interlude_r1_attention', {
    storyId: 'string(255)', mode: 'string(16)', revision: 'unsigned', updatedAt: 'timestamp',
  }, { primary: 'storyId' })
}

/**
 * Restricted private-message Inbox:
 *  - Unique SHA-256 key; duplicate delivery is idempotent across processes.
 *  - No ScriptEntry insert, no narrator context, no TurnEngine mutation on arrival.
 *  - Promotion is atomic with ScriptEntry creation or fails closed.
 *  - No Koishi Session is reconstructed on restart; explicit observation only.
 */
export class R1Inbox {
  constructor(private readonly ctx: Context) {}

  async stage(arrival: R1Arrival): Promise<'inserted' | 'duplicate'> {
    const id = stableInboxId(arrival)
    const existing = await this.ctx.database.get('interlude_r1_inbox', { id })
    if (existing.length) {
      if (existing[0].content !== arrival.content) throw new Error('R1_CONFLICTING_MESSAGE_ID')
      return 'duplicate'
    }
    try {
      await this.ctx.database.create('interlude_r1_inbox', {
        ...arrival, id, metadata: arrival.metadata ?? {}, status: 'unobserved',
      })
      return 'inserted'
    } catch (error) {
      // Only a committed identical ID can turn an insertion error into a duplicate.
      const again = await this.ctx.database.get('interlude_r1_inbox', { id })
      if (again.length) {
        if (again[0].content !== arrival.content) throw new Error('R1_CONFLICTING_MESSAGE_ID')
        return 'duplicate'
      }
      throw error
    }
  }

  async unread(storyId: string, participantId: string): Promise<R1InboxRow[]> {
    const rows = await this.ctx.database.get('interlude_r1_inbox', {
      storyId, participantId, status: 'unobserved',
    }, { sort: { receivedAt: 'asc' }, limit: 200 })
    return rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id))
  }

  async attention(storyId: string): Promise<R1AttentionRow> {
    const rows = await this.ctx.database.get('interlude_r1_attention', { storyId })
    return rows[0] ?? { storyId, mode: 'ringOnly', revision: 0, updatedAt: new Date(0) }
  }

  /** CAS: concurrency-safe attention update, never assume actor process lifetime. */
  async updateAttention(storyId: string, event: AttentionEvent, now = new Date()): Promise<R1AttentionRow> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const old = await this.attention(storyId)
      const next = transitionAttention(old.mode, event)
      if (next === old.mode) return old
      if (old.revision === 0) {
        try {
          await this.ctx.database.create('interlude_r1_attention', {
            storyId, mode: next, revision: 1, updatedAt: now,
          })
          return { storyId, mode: next, revision: 1, updatedAt: now }
        } catch (error) {
          const concurrent = await this.ctx.database.get('interlude_r1_attention', { storyId })
          if (!concurrent.length) throw error
          continue
        }
      }
      const result = await this.ctx.database.set('interlude_r1_attention', {
        storyId, revision: old.revision,
      }, { mode: next, revision: old.revision + 1, updatedAt: now })
      if (result.matched === 1) return { storyId, mode: next, revision: old.revision + 1, updatedAt: now }
    }
    throw new Error('R1_ATTENTION_CAS_CONTENTION')
  }

  /**
   * Transactional promotion is a dedicated host entrypoint, not invoked by a
   * background timer or an invented session. The registered DB must offer
   * a real transaction implementation; never downgrade to sequential writes.
   */
  async observe(storyId: string, participantId: string, ids: string[], now = new Date()): Promise<number[]> {
    if (!ids.length) return []
    if (ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('R1_INVALID_BATCH')
    const database = this.ctx.database as typeof this.ctx.database & {
      withTransaction?: (callback: (tx: typeof this.ctx.database) => Promise<number[]>) => Promise<number[]>
    }
    if (typeof database.withTransaction !== 'function') throw new Error('R1_REAL_TRANSACTION_REQUIRED')
    const state = await this.attention(storyId)
    if (!mayObserve(state.mode)) throw new Error('R1_ATTENTION_NOT_READY')
    return database.withTransaction(async tx => {
      if (!tx || typeof tx.get !== 'function' || typeof tx.create !== 'function' || typeof tx.set !== 'function') {
        throw new Error('R1_TRANSACTION_HANDLE_INVALID')
      }
      const fresh = (await tx.get('interlude_r1_attention', { storyId }))[0]
      if (!fresh || !mayObserve(fresh.mode) || fresh.revision !== state.revision) throw new Error('R1_ATTENTION_CHANGED')
      const promoted: number[] = []
      for (const id of ids) {
        const row = (await tx.get('interlude_r1_inbox', { id, storyId, participantId }))[0]
        if (!row) throw new Error('R1_INBOX_IDENTITY_MISMATCH')
        if (row.status === 'observed') {
          if (!row.scriptEntryId) throw new Error('R1_INCOMPLETE_PROMOTION')
          const receipt = (await tx.get('interlude_script_entry', { id: row.scriptEntryId, storyId, participantId }))[0]
          if (!receipt || receipt.metadata?.sourceInboxId !== row.id || receipt.kind !== 'user-message' || receipt.actor !== 'user' || receipt.content !== row.content.slice(0, 12_000)) {
            throw new Error('R1_PROMOTION_RECEIPT_MISMATCH')
          }
          promoted.push(row.scriptEntryId)
          continue
        }
        if (row.status !== 'unobserved') throw new Error('R1_INBOX_INVALID_STATE')
        const entry = await tx.create('interlude_script_entry', {
          storyId, participantId, kind: 'user-message', actor: 'user',
          content: row.content.slice(0, 12_000), occurredAt: row.receivedAt,
          metadata: { ...row.metadata, platform: row.platform, messageId: row.platformMessageId,
            sourceInboxId: row.id, r1ObservedAt: now.toISOString() },
          createdAt: now,
        })
        if (!entry || !Number.isSafeInteger(entry.id)) throw new Error('R1_SCRIPT_ENTRY_NOT_COMMITTED')
        const updated = await tx.set('interlude_r1_inbox', {
          id, storyId, participantId, status: 'unobserved',
        }, { status: 'observed', observedAt: now, scriptEntryId: entry.id })
        if (updated.matched !== 1) throw new Error('R1_PROMOTION_CAS_FAILED')
        promoted.push(entry.id)
      }
      return promoted
    })
  }
}
