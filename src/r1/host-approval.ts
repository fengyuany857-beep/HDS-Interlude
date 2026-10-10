import { createPublicKey, verify } from 'node:crypto'
import type { R1ApprovalRequest, R1ApprovalVerifier } from './authorized-outbox'

export interface R1HostApprovalIdentity {
  credentialId: string
  principalId: string
  publicKeyDerBase64: string
}

/** Stable bytes signed by the trusted host. Every authority-bearing field is included. */
export function r1ApprovalSigningBytes(request: Omit<R1ApprovalRequest, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify([
    'hdsi-r1-approval-v1', request.receiptId, request.storyId, request.participantId,
    request.sourceInboxId, request.platform, request.endpointId, request.commitId,
    request.eventId, request.payloadHash, request.approvalId, request.principalId,
    request.credentialId, request.actionClass, request.approvedAt.toISOString(),
    request.expiresAt.toISOString(),
  ]))
}

/** Ed25519 verifier backed only by host-configured public identities. */
export function createR1HostApprovalVerifier(identities: readonly R1HostApprovalIdentity[]): R1ApprovalVerifier {
  const trusted = new Map(identities.map(identity => {
    if (!identity.credentialId?.trim() || !identity.principalId?.trim() || !identity.publicKeyDerBase64?.trim()) {
      throw Error('R1_HOST_IDENTITY_INVALID')
    }
    let key
    try {
      key = createPublicKey({ key: Buffer.from(identity.publicKeyDerBase64, 'base64'), format: 'der', type: 'spki' })
    } catch { throw Error('R1_HOST_PUBLIC_KEY_INVALID') }
    if (key.asymmetricKeyType !== 'ed25519') throw Error('R1_HOST_PUBLIC_KEY_TYPE_INVALID')
    return [identity.credentialId, { principalId: identity.principalId, key }] as const
  }))
  if (!trusted.size || trusted.size !== identities.length) throw Error('R1_HOST_IDENTITY_DUPLICATE_OR_EMPTY')
  return async request => {
    const identity = trusted.get(request.credentialId)
    if (!identity || identity.principalId !== request.principalId || !request.signature) return false
    let signature: Buffer
    try { signature = Buffer.from(request.signature, 'base64') } catch { return false }
    if (signature.length !== 64) return false
    const { signature: _signature, ...unsigned } = request
    return verify(null, r1ApprovalSigningBytes(unsigned), identity.key, signature)
  }
}
