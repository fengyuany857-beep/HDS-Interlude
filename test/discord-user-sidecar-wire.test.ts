import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { R1Inbox, registerR1Tables, type R1Arrival } from '../src/r1/inbox'
import { registerTables } from '../src/database'
import { InterludeService } from '../src/service'
import { R1ProposalReceipts, registerR1ProposalReceiptTable } from '../src/r1/proposal-receipts'
import { R1AuthorizedOutbox, registerR1OutboxTables, type R1ApprovalRequest } from '../src/r1/authorized-outbox'
import { createR1HostApprovalVerifier, r1ApprovalSigningBytes } from '../src/r1/host-approval'
import { createTurnEngine } from '../src/turn-engine'
import * as hdsiPlugin from '../src/index'

const ROLE = '100000000000000001', PEER = '200000000000000002'
const CHANNEL = '300000000000000003', MESSAGE = '400000000000000004'
const TOKEN = 'local-bridge-token-32-characters-minimum'

async function startSidecar() {
  const child = spawn('python3', ['sidecar/discord-user/mock_server.py'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: 'sidecar/discord-user', HDSI_TEST_ROLE_ID: ROLE,
      HDSI_TEST_PEER_ID: PEER, HDSI_TEST_CHANNEL_ID: CHANNEL, HDSI_TEST_BRIDGE_TOKEN: TOKEN },
  }) as ChildProcessWithoutNullStreams
  let stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`sidecar start timeout: ${stderr}`)), 8000)
    child.once('exit', code => reject(Error(`sidecar exited ${code}: ${stderr}`)))
    child.stdout.on('data', data => {
      const match = data.toString().match(/PORT=(\d+)/)
      if (match) { clearTimeout(timeout); resolve(Number(match[1])) }
    })
  })
  return { child, port }
}

async function stopSidecar(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, 3000)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
  })
}

test('Discord user sidecar -> published Satori adapter -> R1 Inbox and scoped outbound', async () => {
  const sidecar = await startSidecar()
  const endpoint = `http://127.0.0.1:${sidecar.port}`
  const httpModule = require('@koishijs/plugin-http') as any
  const adapterModule = require('@koishijs/plugin-adapter-satori') as any
  const app = new App()
  app.plugin(httpModule.default ?? httpModule)
  app.plugin(SQLiteDriver, { path: ':memory:' })
  registerTables(app); registerR1Tables(app); registerR1ProposalReceiptTable(app); registerR1OutboxTables(app)
  const inbox = new R1Inbox(app)
  let seen!: () => void
  const inbound = new Promise<void>(resolve => { seen = resolve })
  app.middleware(async (session, next) => {
    if (session.platform !== 'discord-user') return next()
    const arrival: R1Arrival = {
      storyId: 'discord-story', participantId: 'discord-peer', platform: session.platform,
      endpointId: [session.platform, session.selfId, session.userId].join(':'),
      platformMessageId: String(session.messageId), content: String(session.content), receivedAt: new Date(),
    }
    await inbox.stage(arrival); seen()
  })
  app.plugin(adapterModule.default ?? adapterModule, { endpoint, token: TOKEN, retryTimes: 0 })
  try {
    await app.start(); await new Promise(resolve => setTimeout(resolve, 100))
    const inject = (body: Record<string, unknown>) => fetch(`${endpoint}/__test/inbound`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const accepted = await inject({ role_account_id: ROLE, author_user_id: PEER,
      dm_channel_id: CHANNEL, remote_message_id: MESSAGE, content: '真实契约入站',
      is_direct: true, author_is_self: false })
    assert.deepEqual(await accepted.json(), { accepted: true })
    await Promise.race([inbound, new Promise((_, reject) => setTimeout(() => reject(Error('inbound timeout')), 5000))])
    const staged = await inbox.unread('discord-story', 'discord-peer')
    assert.equal(staged.length, 1); assert.equal(staged[0].platformMessageId, MESSAGE)
    assert.equal(staged[0].endpointId, `discord-user:${ROLE}:${PEER}`)
    const stranger = await inject({ role_account_id: ROLE, author_user_id: '600000000000000006',
      dm_channel_id: CHANNEL, remote_message_id: '700000000000000007', content: 'blocked',
      is_direct: true, author_is_self: false })
    assert.deepEqual(await stranger.json(), { accepted: false })
    assert.equal((await inbox.unread('discord-story', 'discord-peer')).length, 1)
    const inboxRow = staged[0]
    const receiptLedger = new R1ProposalReceipts(app)
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const verifier = createR1HostApprovalVerifier([{
      credentialId: 'discord-wire-key', principalId: 'trusted-test-host',
      publicKeyDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }])
    const service: any = Object.create(InterludeService.prototype)
    service.ctx = app; service.r1Inbox = inbox; service.r1ProposalReceipts = receiptLedger
    service.r1Outbox = new R1AuthorizedOutbox(app, verifier); service.queues = new Map()
    service.turnEngine = createTurnEngine({ setTimeout: () => () => {}, userMessageDebounceSeconds: 0, reportOperation: () => {} })
    const now = new Date()
    await service.transitionR1Attention('discord-story', 'CHECK', now)
    const proposal = await service.observeR1AndPrepare({
      storyId: 'discord-story', participantId: 'discord-peer', inboxId: inboxRow.id,
      frameId: 'discord-frame', burstId: 'discord-burst', now,
      decision: { script: '她看见消息，回复“exact authorized payload”。', interaction: {
        seen: true, reply: { mode: 'immediate', content: 'exact authorized payload' },
      } },
    }, { authoritative: true, attemptedTravel: false, claimsCompletedAction: false, completionEvidenceVerified: false })
    assert.equal(proposal.status, 'proposal-only')
    const review = (await receiptLedger.pending('discord-story', 'discord-peer'))[0]
    assert.ok(review)
    const unsigned: Omit<R1ApprovalRequest, 'signature'> = {
      receiptId: review.id, storyId: review.storyId, participantId: review.participantId,
      sourceInboxId: review.sourceInboxId, platform: 'discord-user', endpointId: `discord-user:${ROLE}:${PEER}`,
      commitId: review.commitId, eventId: review.eventId, payloadHash: review.contentHash,
      payloadContent: review.payloadContent, approvalId: 'discord-wire-approval',
      principalId: 'trusted-test-host', credentialId: 'discord-wire-key', actionClass: 'r1-private-text', deliveryKind: 'immediate',
      approvedAt: now, expiresAt: new Date(now.getTime() + 30_000),
    }
    const approval = { ...unsigned, signature: sign(null, r1ApprovalSigningBytes(unsigned), privateKey).toString('base64') }
    const authorized = await service.authorizeR1Proposal(approval, now)
    const previous = process.env.HDSI_R1_DISPATCH_MODE
    process.env.HDSI_R1_DISPATCH_MODE = 'authorized'
    try {
      const delivered = await service.dispatchR1Authorized(authorized.id, now)
      assert.equal(delivered.status, 'accepted')
      assert.equal(delivered.adapterMessageId, '500000000000000006')
    } finally {
      if (previous === undefined) delete process.env.HDSI_R1_DISPATCH_MODE
      else process.env.HDSI_R1_DISPATCH_MODE = previous
    }
  } finally {
    await app.stop(); await stopSidecar(sidecar.child)
  }
})

test('formal HDSI middleware auto-creates and resumes one Discord story across database restart', async () => {
  const sidecar = await startSidecar()
  const endpoint = `http://127.0.0.1:${sidecar.port}`
  const databasePath = join(mkdtempSync(join(tmpdir(), 'hdsi-discord-story-')), 'story.sqlite3')
  const previous = process.env.HDSI_R1_PRIVATE_INBOX
  process.env.HDSI_R1_PRIVATE_INBOX = 'stage-only'
  const inject = (messageId: string, content: string) => fetch(`${endpoint}/__test/inbound`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role_account_id: ROLE, author_user_id: PEER, dm_channel_id: CHANNEL,
      remote_message_id: messageId, content, is_direct: true, author_is_self: false }),
  })
  const start = async () => {
    const app = new App()
    const httpModule = require('@koishijs/plugin-http') as any
    const adapterModule = require('@koishijs/plugin-adapter-satori') as any
    app.plugin(httpModule.default ?? httpModule)
    app.plugin(SQLiteDriver, { path: databasePath })
    app.plugin(adapterModule.default ?? adapterModule, { endpoint, token: TOKEN, retryTimes: 0 })
    app.plugin(hdsiPlugin, {
      storyDefaults: { characterName: 'Discord Role', characterProfile: 'isolated test role' },
      model: {}, onebot: { enabled: false }, sharedStory: {},
      runtime: { autoCreate: true, captureDirectMessages: true, ignoreCommandMessages: true },
    } as any)
    await app.start(); await new Promise(resolve => setTimeout(resolve, 100))
    return app
  }
  let first: App | undefined
  let second: App | undefined
  try {
    first = await start()
    assert.deepEqual(await (await inject('410000000000000004', 'first turn')).json(), { accepted: true })
    await waitFor(async () => (await first!.database.get('interlude_r1_inbox', {})).length === 1)
    const stories = await first.database.get('interlude_story', {})
    const participants = await first.database.get('interlude_participant', {})
    assert.equal(stories.length, 1); assert.equal(stories[0].platform, 'discord-user')
    assert.equal(stories[0].selfId, ROLE)
    assert.equal(participants.length, 1); assert.equal(participants[0].userId, PEER)
    const storyId = stories[0].id, participantId = participants[0].id
    await first.stop(); first = undefined

    second = await start()
    assert.deepEqual(await (await inject('420000000000000004', 'second turn')).json(), { accepted: true })
    await waitFor(async () => (await second!.database.get('interlude_r1_inbox', {})).length === 2)
    const restoredStories = await second.database.get('interlude_story', {})
    const restoredParticipants = await second.database.get('interlude_participant', {})
    assert.deepEqual(restoredStories.map(row => row.id), [storyId])
    assert.deepEqual(restoredParticipants.map(row => row.id), [participantId])
    const inboxRows = await second.database.get('interlude_r1_inbox', {}, { sort: { receivedAt: 'asc' } })
    assert.deepEqual(inboxRows.map(row => row.storyId), [storyId, storyId])
    assert.deepEqual(inboxRows.map(row => row.participantId), [participantId, participantId])
  } finally {
    if (first) await first.stop()
    if (second) await second.stop()
    await stopSidecar(sidecar.child)
    if (previous === undefined) delete process.env.HDSI_R1_PRIVATE_INBOX
    else process.env.HDSI_R1_PRIVATE_INBOX = previous
  }
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition timeout')
}
