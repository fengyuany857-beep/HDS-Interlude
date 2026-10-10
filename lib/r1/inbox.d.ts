import type { Context } from 'koishi';
import { type AttentionEvent, type AttentionMode } from './attention';
export interface R1InboxRow {
    id: string;
    storyId: string;
    participantId: string;
    platform: string;
    endpointId: string;
    platformMessageId: string;
    content: string;
    metadata: Record<string, unknown>;
    status: 'unobserved' | 'observed';
    receivedAt: Date;
    observedAt?: Date;
    scriptEntryId?: number;
}
export interface R1AttentionRow {
    storyId: string;
    mode: AttentionMode;
    revision: number;
    updatedAt: Date;
}
declare module 'koishi' {
    interface Tables {
        interlude_r1_inbox: R1InboxRow;
        interlude_r1_attention: R1AttentionRow;
    }
}
export interface R1Arrival {
    storyId: string;
    participantId: string;
    platform: string;
    endpointId: string;
    platformMessageId: string;
    content: string;
    metadata?: Record<string, unknown>;
    receivedAt: Date;
}
export declare function stableInboxId(row: Pick<R1Arrival, 'storyId' | 'participantId' | 'platform' | 'endpointId' | 'platformMessageId'>): string;
/** Adds tables without rebuilding the canonical HDSI tables. */
export declare function registerR1Tables(ctx: Context): void;
/**
 * Restricted private-message Inbox:
 *  - Unique SHA-256 key; duplicate delivery is idempotent across processes.
 *  - No ScriptEntry insert, no narrator context, no TurnEngine mutation on arrival.
 *  - Promotion is atomic with ScriptEntry creation or fails closed.
 *  - No Koishi Session is reconstructed on restart; explicit observation only.
 */
export declare class R1Inbox {
    private readonly ctx;
    constructor(ctx: Context);
    stage(arrival: R1Arrival): Promise<'inserted' | 'duplicate'>;
    unread(storyId: string, participantId: string): Promise<R1InboxRow[]>;
    attention(storyId: string): Promise<R1AttentionRow>;
    /** CAS: concurrency-safe attention update, never assume actor process lifetime. */
    updateAttention(storyId: string, event: AttentionEvent, now?: Date): Promise<R1AttentionRow>;
    /**
     * Transactional promotion is a dedicated host entrypoint, not invoked by a
     * background timer or an invented session. The registered DB must offer
     * a real transaction implementation; never downgrade to sequential writes.
     */
    observe(storyId: string, participantId: string, ids: string[], now?: Date): Promise<number[]>;
    /**
     * Host-only atomic extension: promotion and dependent review receipt must
     * commit in the SAME transaction. Callback failures rollback both.
     * Never call a narrator or a transport from the callback.
     */
    observeWith<T>(storyId: string, participantId: string, ids: string[], afterPromote: (tx: typeof this.ctx.database, entryIds: number[]) => Promise<T>, now?: Date): Promise<T>;
}
