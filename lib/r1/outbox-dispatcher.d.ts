import type { R1AuthorizedOutbox, R1OutboxRow } from './authorized-outbox';
export interface R1TransportAttempt {
    attemptId: string;
    platform: string;
    endpointId: string;
    content: string;
    deliveryKind: 'immediate' | 'delayed' | 'proactive';
}
export type R1TransportResult = {
    status: 'accepted';
    adapterMessageId: string;
} | {
    status: 'rejected';
    reason: string;
};
export interface R1OutboxTransport {
    sendExact(attempt: Readonly<R1TransportAttempt>): Promise<R1TransportResult>;
}
/** One durable claim, one transport call, one terminal receipt. Throws become UNKNOWN. */
export declare class R1OutboxDispatcher {
    private readonly outbox;
    private readonly transport;
    constructor(outbox: R1AuthorizedOutbox, transport: R1OutboxTransport);
    dispatch(id: string, at?: Date): Promise<R1OutboxRow>;
}
