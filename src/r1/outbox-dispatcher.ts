import type { R1AuthorizedOutbox, R1OutboxRow } from './authorized-outbox'

export interface R1TransportAttempt {
  attemptId: string
  platform: string
  endpointId: string
  content: string
}

export type R1TransportResult =
  | { status: 'accepted', adapterMessageId: string }
  | { status: 'rejected', reason: string }

export interface R1OutboxTransport {
  sendExact(attempt: Readonly<R1TransportAttempt>): Promise<R1TransportResult>
}

/** One durable claim, one transport call, one terminal receipt. Throws become UNKNOWN. */
export class R1OutboxDispatcher {
  constructor(private readonly outbox: R1AuthorizedOutbox, private readonly transport: R1OutboxTransport) {}

  async dispatch(id: string, at = new Date()): Promise<R1OutboxRow> {
    const claim = await this.outbox.claim(id, at)
    try {
      const result = await this.transport.sendExact({
        attemptId: claim.attemptId!, platform: claim.platform,
        endpointId: claim.endpointId, content: claim.payloadContent,
      })
      if (result.status === 'accepted') {
        if (!result.adapterMessageId?.trim()) throw Error('R1_TRANSPORT_INVALID_ACCEPTANCE')
        return this.outbox.settle(id, claim.attemptId!, 'accepted', new Date(), result.adapterMessageId)
      }
      if (result.status === 'rejected' && result.reason?.trim()) {
        return this.outbox.settle(id, claim.attemptId!, 'rejected', new Date(), undefined, result.reason)
      }
      throw Error('R1_TRANSPORT_INVALID_RESULT')
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'transport-threw-non-error'
      return this.outbox.settle(id, claim.attemptId!, 'unknown', new Date(), undefined,
        ('transport-ambiguous:' + reason).slice(0, 255))
    }
  }
}
