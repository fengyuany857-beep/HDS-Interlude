import type { Context } from 'koishi';
import { type R2Goal, type R2HostEvidence } from './yuka-goal-planner';
export type R2GoalStatus = 'proposed' | 'review-due';
export interface R2GoalStateRow {
    storyId: string;
    proposalId: string;
    goal: R2Goal;
    evidenceFingerprint: string;
    evidenceSourceIds: number[];
    status: R2GoalStatus;
    revision: number;
    proposedAt: Date;
    nextReviewAt: Date;
    updatedAt: Date;
}
export interface R2GoalEventRow {
    id: string;
    storyId: string;
    proposalId: string;
    goal: R2Goal;
    kind: 'proposed' | 'review-due';
    evidenceFingerprint: string;
    occurredAt: Date;
}
declare module 'koishi' {
    interface Tables {
        interlude_r2_goal_state: R2GoalStateRow;
        interlude_r2_goal_event: R2GoalEventRow;
    }
}
/** Only additive candidate tables. Never rewrite the HDSI or R1 canonical tables. */
export declare function registerR2GoalTables(ctx: Context): void;
/**
 * Durable, transaction-bound shadow proposals. Events are observations of a
 * *proposal*, never real-world activity, sent messages, or authorization.
 * The host supplies a trustworthy clock and canonical ScriptEntry database.
 */
export declare class R2GoalLedger {
    private readonly ctx;
    private readonly clock;
    constructor(ctx: Context, clock?: () => Date);
    private prepared?;
    /**
     * SQLite/Minato lazily prepares dynamically registered tables. Preparing
     * outside the write transaction prevents a rejected first proposal from
     * rolling back its CREATE TABLE alongside the proposal.
     * This adapter requires the real Minato driver schema API, or fails closed.
     */
    private ensureSchema;
    current(storyId: string): Promise<R2GoalStateRow | undefined>;
    history(storyId: string): Promise<R2GoalEventRow[]>;
    private transaction;
    /**
     * A model-provided list of "verified IDs" is not proof. The trusted host
     * checks every ID against this story's actual canonical ScriptEntry rows.
     */
    submit(evidence: R2HostEvidence): Promise<R2GoalStateRow>;
    /**
     * Deterministic time advance with an event receipt. It marks only that a
     * proposal needs a fresh host observation. It never says an action occurred.
     */
    advanceReview(storyId: string, at?: Date): Promise<R2GoalStateRow | undefined>;
}
