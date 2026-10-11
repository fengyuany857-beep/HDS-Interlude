import type { Context } from 'koishi';
import type { ObservedCommitProposal } from './observed-commit';
/** A durable review inbox, not a sender or evidence of real delivery. */
export interface R1ProposalReceiptRow {
    id: string;
    storyId: string;
    participantId: string;
    sourceInboxId: string;
    sourceScriptEntryId: number;
    sourceKind?: 'inbound' | 'background';
    platform?: string;
    endpointId?: string;
    commitId: string;
    eventId: string;
    contentHash: string;
    payloadContent: string;
    deliveryKind: 'immediate' | 'delayed' | 'proactive';
    notBefore?: Date;
    status: 'pending-review' | 'authorized' | 'rejected';
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    reason?: string;
}
declare module 'koishi' {
    interface Tables {
        interlude_r1_proposal_receipt: R1ProposalReceiptRow;
    }
}
export declare function registerR1ProposalReceiptTable(ctx: Context): void;
/**
 * Stores reviewed *proposals* separately from transport results.
 * Replays with the same event identity are idempotent; altered payloads fail.
 * No method in this class can mark delivery successful or emit a message.
 */
export declare class R1ProposalReceipts {
    private readonly ctx;
    private preparation?;
    constructor(ctx: Context);
    private ensureTable;
    private transaction;
    /** Prepare schema before parent Inbox transaction to avoid nested DDL. */
    prepareAtomic(): Promise<void>;
    open(proposal: ObservedCommitProposal, at?: Date, parentTransaction?: typeof this.ctx.database): Promise<R1ProposalReceiptRow[]>;
    /**
     * Opens a review for a proactive event already persisted by the existing
     * narrative/Agency pipeline. It derives every authority-bearing field from
     * the canonical ScriptEntry and endpoint registry; it never sends.
     */
    openBackground(scriptEntryId: number, eventId: string, at?: Date): Promise<R1ProposalReceiptRow>;
    pending(storyId: string, participantId: string): Promise<R1ProposalReceiptRow[]>;
    /** Host may explicitly reject a proposal; it is never interpreted as sent. */
    reject(id: string, reason: string, at?: Date): Promise<R1ProposalReceiptRow>;
}
