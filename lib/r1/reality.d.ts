export interface ActionEvidence {
    attemptedTravel: boolean;
    elapsedMinutes?: number;
    minTravelMinutes?: number;
    travelExceptionVerified?: boolean;
    claimsCompletedAction: boolean;
    completionEvidenceVerified: boolean;
    /** Only host-controlled verified observations may set these true. */
    authoritative?: boolean;
}
export type ActionVerdict = {
    status: 'allow' | 'reject' | 'needs-data';
    reasons: string[];
};
/** Engine evaluates genuine host facts; the model may not self-authorize evidence. */
export declare function checkAction(evidence: ActionEvidence): Promise<ActionVerdict>;
/** Unknown action provenance is a block, never a permissive fallback. */
export declare function assertHostAuthorized(evidence: ActionEvidence): Promise<void>;
