import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createR1HostApprovalVerifier, r1ApprovalSigningBytes } from '../src/r1/host-approval'
import type { R1ApprovalRequest } from '../src/r1/authorized-outbox'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const identity = {
  credentialId: 'host-key-2026-10', principalId: 'desktop-host',
  publicKeyDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
}

function signed(): R1ApprovalRequest {
  const unsigned: Omit<R1ApprovalRequest, 'signature'> = {
    receiptId: 'r'.repeat(64), storyId: 'story', participantId: 'alice',
    sourceInboxId: 'i'.repeat(64), platform: 'satori-test',
    endpointId: 'satori-test:bot-42:dm-alice:alice', commitId: 'commit-1',
    eventId: 'event-1', payloadHash: 'p'.repeat(64), payloadContent: 'exact message', approvalId: 'approval-1',
    principalId: identity.principalId, credentialId: identity.credentialId,
    actionClass: 'r1-private-text', approvedAt: new Date('2026-10-10T12:00:00Z'),
    expiresAt: new Date('2026-10-10T12:00:30Z'),
  }
  return { ...unsigned, signature: sign(null, r1ApprovalSigningBytes(unsigned), privateKey).toString('base64') }
}

test('trusted host Ed25519 approval binds identity, endpoint, payload, action and expiry', async () => {
  const verifier = createR1HostApprovalVerifier([identity])
  const approval = signed()
  assert.equal(await verifier(approval), true)
  for (const forged of [
    { ...approval, participantId: 'mallory' },
    { ...approval, endpointId: 'satori-test:other-bot:dm-alice:alice' },
    { ...approval, payloadHash: '0'.repeat(64) },
    { ...approval, payloadContent: 'changed message' },
    { ...approval, actionClass: 'r1-private-text-other' as any },
    { ...approval, expiresAt: new Date('2026-10-10T12:00:31Z') },
    { ...approval, principalId: 'model' },
    { ...approval, credentialId: 'unknown-key' },
  ]) assert.equal(await verifier(forged), false)
})

test('host verifier rejects malformed, duplicate and non-Ed25519 identities', async () => {
  assert.throws(() => createR1HostApprovalVerifier([]), /DUPLICATE_OR_EMPTY/)
  assert.throws(() => createR1HostApprovalVerifier([identity, identity]), /DUPLICATE_OR_EMPTY/)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
  assert.throws(() => createR1HostApprovalVerifier([{
    ...identity, publicKeyDerBase64: rsa.export({ format: 'der', type: 'spki' }).toString('base64'),
  }]), /PUBLIC_KEY_TYPE_INVALID/)
  assert.equal(await createR1HostApprovalVerifier([identity])({ ...signed(), signature: 'not-base64' }), false)
})
