import type { Context } from 'koishi';
import type { NarrativeDecision } from '../types';
import { type ScriptCommitDraft } from '../script/contract';
export interface ObservedCommitInput {
    storyId: string;
    participantId: string;
    inboxId: string;
    scriptEntryId: number;
    frameId: string;
    burstId: string;
    now: Date;
    decision: NarrativeDecision;
}
export interface ObservedCommitProposal {
    status: 'proposal-only';
    sideEffects: 'none';
    requiresHostRealityGate: true;
    requiresHostDeliveryAuthorization: true;
    sourceInboxId: string;
    sourceScriptEntryId: number;
    commit: ScriptCommitDraft;
}
/** Read-only bridge from a verified promoted Inbox row to an unexecuted script proposal. */
export declare function prepareObservedCommit(ctx: Context, request: ObservedCommitInput, reader?: Pick<Context['database'], 'get'>): Promise<ObservedCommitProposal>;
