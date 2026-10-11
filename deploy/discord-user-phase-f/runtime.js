'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')
const { App } = require('koishi')
const { SQLiteDriver } = require('@minatojs/driver-sqlite')
const httpModule = require('@koishijs/plugin-http')
const satoriModule = require('@koishijs/plugin-adapter-satori')
const hdsi = require('/app/lib')

const secret = fs.readFileSync('/run/secrets/local_bridge_token', 'utf8').trim()
if (secret.length < 32) throw new Error('bridge secret is invalid')
const modelKey = fs.readFileSync('/run/secrets/model_api_key', 'utf8').trim()
if (!modelKey) throw new Error('model secret is invalid')
const hostPrivateKey = crypto.createPrivateKey({
  key: fs.readFileSync('/run/secrets/r1_host_private_key_der'), format: 'der', type: 'pkcs8',
})
if (hostPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('host signing key is not Ed25519')
const hostPublicKey = crypto.createPublicKey(hostPrivateKey).export({ format: 'der', type: 'spki' }).toString('base64')
const roleId = '1535516476050767992'
const peerId = '1048470989958303874'
const exactEndpoint = `discord-user:${roleId}:${peerId}`
process.env.HDSI_R1_PRIVATE_INBOX = 'review-authorized'
const outboundArmed = process.env.HDSI_PHASE_F_OUTBOUND_ARMED === '1'
const backgroundArmed = outboundArmed && process.env.HDSI_PHASE_F_BACKGROUND_ARMED === '1'
process.env.HDSI_R1_DISPATCH_MODE = outboundArmed ? 'authorized' : 'disabled'
process.env.HDSI_R1_HOST_CREDENTIAL_ID = 'hdsi-discord-f-host-v1'
process.env.HDSI_R1_HOST_PRINCIPAL_ID = 'hdsi-discord-f-reviewer'
process.env.HDSI_R1_HOST_PUBLIC_KEY_DER_BASE64 = hostPublicKey

const app = new App()
app.plugin(httpModule.default ?? httpModule)
app.plugin(SQLiteDriver, { path: '/var/lib/hdsi-koishi/hdsi.sqlite3' })
app.plugin(satoriModule.default ?? satoriModule, {
  endpoint: 'http://hdsi-discord-f-sidecar:5140', token: secret, retryTimes: 0,
})
app.plugin(hdsi, {
  storyDefaults: { characterName: 'Discord Role', characterProfile: 'isolated private Discord role' },
  model: {
    providers: [{
      id: 'deepseek-v41-flash', label: 'DeepSeek V4.1 Flash', enabled: true,
      mode: 'deepseek-official', protocol: 'chat-completions',
      endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: modelKey,
      model: 'deepseek-flash', deepseekThinking: 'disabled',
      temperature: 0.3, topP: 1, maxTokens: 4096, timeout: 60000,
      responseFormat: 'json-object', extraHeaders: '', extraBody: '',
      useForMain: true, useForCompaction: true, useForAlter: true,
      useForEmbedding: false, useForStickers: false, useForVision: false,
    }],
    failover: { enabled: false, strategy: 'priority', maxAttemptsPerProvider: 1, cooldownMinutes: 5 },
    mainResponseFormat: 'json-object',
  },
  onebot: { enabled: false }, sharedStory: {},
  memory: { enabled: backgroundArmed },
  schedulePreplan: { enabled: backgroundArmed },
  agency: { enabled: backgroundArmed },
  runtime: { autoCreate: true, captureDirectMessages: true, ignoreCommandMessages: true, allowProactiveMessages: false, autoAdvanceEnabled: backgroundArmed },
})

let reviewRunning = false
async function reviewOneImmediate() {
  if (reviewRunning) throw new Error('PHASE_F_REVIEW_BUSY')
  reviewRunning = true
  try {
    const rows = await app.database.get('interlude_r1_inbox', { status: 'unobserved' }, { sort: { receivedAt: 'asc' }, limit: 2 })
    if (rows.length !== 1) throw new Error(`PHASE_F_EXPECTED_ONE_UNOBSERVED:${rows.length}`)
    const row = rows[0]
    if (row.platform !== 'discord-user' || row.endpointId !== exactEndpoint) throw new Error('PHASE_F_INBOX_SCOPE_MISMATCH')
    const used = await app.database.get('interlude_r1_outbox', { status: { $in: ['attempting', 'accepted', 'unknown'] } })
    const immediateUsed = used.filter(item => (item.deliveryKind || 'immediate') === 'immediate').length
    if (used.length >= 6 || immediateUsed >= 3) throw new Error('PHASE_F_SEND_CAP_REACHED')
    const service = app.interlude
    const now = new Date()
    await service.transitionR1Attention(row.storyId, 'CHECK', now)
    const evidence = { authoritative: true, attemptedTravel: false, claimsCompletedAction: false, completionEvidenceVerified: false }
    const proposal = await service.prepareR1NarratedReview(row.id, evidence, now)
    const event = proposal.commit.events.find(item => item.kind === 'outgoing-message' && item.deliveryMode === 'immediate')
    if (!event || event.participantId !== row.participantId || !event.content?.trim()) throw new Error('PHASE_F_NO_REVIEWABLE_IMMEDIATE_REPLY')
    const reviews = await service.pendingR1Review(row.storyId, row.participantId)
    const receipt = reviews.find(item => item.commitId === proposal.commit.commitId && item.eventId === event.eventId)
    if (!receipt || receipt.endpointId && receipt.endpointId !== exactEndpoint) throw new Error('PHASE_F_RECEIPT_SCOPE_MISMATCH')
    const approvedAt = new Date()
    const unsigned = {
      receiptId: receipt.id, storyId: receipt.storyId, participantId: receipt.participantId,
      sourceInboxId: receipt.sourceInboxId, platform: row.platform, endpointId: exactEndpoint,
      commitId: receipt.commitId, eventId: receipt.eventId, payloadHash: receipt.contentHash,
      payloadContent: receipt.payloadContent, approvalId: `phase-f-immediate:${receipt.id}`,
      principalId: 'hdsi-discord-f-reviewer', credentialId: 'hdsi-discord-f-host-v1',
      actionClass: 'r1-private-text', deliveryKind: 'immediate', approvedAt,
      expiresAt: new Date(approvedAt.getTime() + 45000),
    }
    const signature = crypto.sign(null, hdsi.r1ApprovalSigningBytes(unsigned), hostPrivateKey).toString('base64')
    const outbox = await service.authorizeR1Proposal({ ...unsigned, signature })
    const settled = await service.dispatchR1Authorized(outbox.id, new Date())
    console.log(`HDSI_PHASE_F_IMMEDIATE_RESULT status=${settled.status} outbox=${settled.id} adapterMessage=${settled.adapterMessageId || ''}`)
  } finally {
    reviewRunning = false
  }
}

app.start().then(() => {
  console.log('HDSI_PHASE_F_KOISHI_READY')
  process.on('SIGUSR1', () => {
    if (!outboundArmed) { console.warn('HDSI_PHASE_F_OUTBOUND_DISARMED'); return }
    reviewOneImmediate().catch(error => console.error('HDSI_PHASE_F_REVIEW_FAILED', error?.stack || error))
  })
}).catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  await app.stop()
  process.exit(0)
})