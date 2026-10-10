import type { Context } from 'koishi';
/**
 * R1 candidate-only effect ledger. This component NEVER invokes a platform,
 * narrator or Koishi Bot. 'accepted' means an authenticated adapter acknowledged
 * a send, NOT that the recipient received it.
 */
export type R1OutboxStatus = 'authorized' | 'attempting' | 'accepted' | 'rejected' | 'unknown';
export interface R1OutboxRow {
    id: string;
    storyId: string;
    participantId: string;
    sourceInboxId: string;
    platform: string;
    endpointId: string;
    commitId: string;
    eventId: string;
    payloadHash: string;
    approvalId: string;
    principalId: string;
    status: R1OutboxStatus;
    revision: number;
    approvedAt: Date;
    expiresAt: Date;
    updatedAt: Date;
    attemptId?: string;
    attemptAt?: Date;
    completedAt?: Date;
    adapterMessageId?: string;
    reason?: string;
}
export interface R1OutboxEventRow {
    id: string;
    outboxId: string;
    revision: number;
    kind: R1OutboxStatus;
    occurredAt: Date;
    attemptId?: string;
    reason?: string;
}
declare module 'koishi' {
    interface Tables {
        interlude_r1_outbox: R1OutboxRow;
        interlude_r1_outbox_event: R1OutboxEventRow;
    }
}
export declare function registerR1OutboxTables(ctx: Context): void;
export interface R1ApprovalRequest {
    receiptId: string;
    storyId: string;
    participantId: string;
    sourceInboxId: string;
    platform: string;
    endpointId: string;
    commitId: string;
    eventId: string;
    payloadHash: string;
    approvalId: string;
    principalId: string;
    actionClass: 'r1-private-text';
    approvedAt: Date;
    expiresAt: Date;
}
/**
 * Must be provided by a separately authenticated, trusted host component.
 * NOT a caller-supplied "authorized: true" or model statement.
 * The verifier is responsible for binding ALL fields, scope and principal.
 */
export type R1ApprovalVerifier = (request: Readonly<R1ApprovalRequest>) => Promise<boolean>;
export declare class R1AuthorizedOutbox {
    private readonly ctx;
    private readonly verifier?;
    private preparing?;
    constructor(ctx: Context, verifier?: R1ApprovalVerifier);
    private ensureTables;
    private transaction;
    private append;
    /** No verifier means fail-closed. Only private-text reviews are in scope. */
    authorize(request: R1ApprovalRequest, at?: Date): Promise<R1OutboxRow>;
    /**
     * Reserve an attempt durably BEFORE any transport call.
     * The returned row is not a permission to auto-send; the trusted host owns
     * the separate platform-action authorization and transport boundary.
     */
    claim(id: string, at?: Date): Promise<R1OutboxRow>;
    /** Caller must be a trusted transport result handler, never the LLM. */
    settle(id: string, attemptId: string, result: 'accepted' | 'rejected' | 'unknown', at?: Date, adapterMessageId?: string, reason?: string): Promise<R1OutboxRow>;
    current(id: string): Promise<R1OutboxRow | undefined>;
    history(id: string): Promise<R1OutboxEventRow[]>;
    uncertain(storyId: string): Promise<R1OutboxRow[]>;
}
