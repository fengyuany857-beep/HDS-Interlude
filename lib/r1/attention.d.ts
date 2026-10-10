export type AttentionMode = 'attentive' | 'ringOnly' | 'dnd' | 'asleep';
export type AttentionEvent = 'RING' | 'DND' | 'SLEEP' | 'WAKE' | 'CHECK';
/** Real XState execution with host-owned, persistable attention state. */
export declare function transitionAttention(current: AttentionMode, event: AttentionEvent): AttentionMode;
export declare function mayObserve(mode: AttentionMode): boolean;
