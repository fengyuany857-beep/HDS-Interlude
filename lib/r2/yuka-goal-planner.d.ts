import type { AgencyWindowState, ProactiveContactDraft } from '../types';
import type { AttentionMode } from '../r1/attention';
export type R2Goal = 'rest' | 'fulfill-commitment' | 'consider-contact' | 'quiet-reflection';
export interface R2Commitment {
    id: string;
    urgency: number;
    sourceEntryIds: number[];
}
export interface R2HostEvidence {
    storyId: string;
    observedAt: string;
    now: string;
    /** The observer, never the language model, supplies this evidence. */
    verifiedByHost: boolean;
    energy: number;
    activityLoad: 'free' | 'occupied' | 'overloaded';
    attentionMode: AttentionMode;
    commitments: R2Commitment[];
    /** Exact ScriptEntry IDs independently resolved by the trusted host. */
    verifiedSourceEntryIds: number[];
    /** Existing platform authorization supplies the allowed recipient set. */
    permittedContactParticipantIds: string[];
    /** Existing HDSI Agency is the sole authority for contact capacity. */
    agencyWindow?: AgencyWindowState;
    proposedContact?: ProactiveContactDraft;
    lastCharacterMessageAt?: string;
}
export interface R2GoalProposal {
    status: 'proposed' | 'needs-evidence';
    goal?: R2Goal;
    reason: string;
    evidenceFingerprint: string;
    ranking: Array<{
        goal: R2Goal;
        desirability: number;
    }>;
    /** Yuka never creates a platform delivery, ScriptEntry, or world fact. */
    sideEffects: 'none';
    requiresScriptCommitAuthorization: true;
}
/** Deterministic, bounded and read-only. There is no autonomous world mutation. */
export declare function proposeYukaGoal(input: R2HostEvidence): R2GoalProposal;
