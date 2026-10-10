import assert from 'node:assert/strict'
import test from 'node:test'
import { App } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'
import { InterludeService } from '../src/service'
import { R1AuthorizedOutbox, registerR1OutboxTables } from '../src/r1/authorized-outbox'

/**
 * Real Koishi OneBot adapter, actual loopback TCP + WebSocket and Minato SQLite.
 * The upstream OneBot protocol server is a bounded test double, NOT QQ/NapCat.
 * CI must fail rather than skip if adapter, port, handshake or inbound fails.
 */
test('R1 loopback OneBot V11 WS -> actual Koishi adapter -> durable private Inbox, zero sends', async () => {
  const { WebSocketServer } = require('ws') as { WebSocketServer: any }
  const module = require('koishi-plugin-adapter-onebot') as any
  const adapter = module.default ?? module
  assert.ok(adapter, 'real published Koishi OneBot adapter must load')

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = 'ws://127.0.0.1:' + address.port
  const app = new App()
  // Koishi's real OneBot adapter declares ctx.http as a required service.
  // An empty App never auto-installs it; without this the adapter stays dormant.
  const httpModule = require('@koishijs/plugin-http') as any
  app.plugin(httpModule.default ?? httpModule)
  app.plugin(SQLiteDriver, { path: ':memory:' })
  registerTables(app)
  registerR1Tables(app)
  const inbox = new R1Inbox(app)
  const rawMessages: Record<string, unknown>[] = []
  const networkActions: string[] = []
  const staged: R1Arrival[] = []
  let seen!: () => void
  const inbound = new Promise<void>(resolve => { seen = resolve })
  const once = new Set<string>()

  app.middleware(async (session, next) => {
    if (session.platform !== 'onebot' || session.isDirect === false) return next()
    const message: R1Arrival = {
      storyId: 'wire:r1-story', participantId: 'wire:alice', platform: session.platform,
      endpointId: [session.platform, session.selfId, session.userId].join(':'),
      platformMessageId: String(session.messageId),
      content: String(session.content), receivedAt: new Date(),
    }
    staged.push(message)
    await inbox.stage(message)
    seen()
    return // never call a narrator or sender
  })

  server.on('connection', (socket: any) => {
    socket.on('message', (buf: Buffer) => {
      const payload = JSON.parse(buf.toString()) as { action?: string; echo?: number }
      if (!payload.action) return
      networkActions.push(payload.action)
      // A strict loopback mock responds to every adapter API request.
      const data = payload.action === 'get_login_info'
        ? { user_id: 123456, nickname: 'WireOnly' }
        : {}
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo }))
      if (payload.action === 'get_login_info' && !once.has('message')) {
        once.add('message')
        // Wait for login processing before emitting an actual protocol frame.
        setTimeout(() => {
          if (socket.readyState !== 1) return
          const event = {
            time: Math.floor(Date.now() / 1000), self_id: 123456,
            post_type: 'message', message_type: 'private', sub_type: 'friend',
            message_id: 7788, user_id: 2001, font: 0,
            message: '你好', raw_message: '你好',
            sender: { user_id: 2001, nickname: 'Alice' },
          }
          rawMessages.push(event)
          socket.send(JSON.stringify(event))
          socket.send(JSON.stringify(event)) // replay delivery
        }, 30)
      }
    })
  })

  app.plugin(adapter, {
    protocol: 'ws', selfId: '123456', endpoint, responseTimeout: 2000,
  })

  try {
    await app.start()
    await Promise.race([
      inbound,
      new Promise<never>((_, reject) => setTimeout(() => reject(Error('R1_WIRE_INBOUND_TIMEOUT actions=' + JSON.stringify(networkActions) + ' staged=' + staged.length)), 6000)),
    ])
    assert.equal(rawMessages.length, 1, 'real OneBot frame must have been sent on loopback WS')
    assert.ok(networkActions.includes('get_login_info'), 'real Koishi adapter must initialize over WS')
    assert.equal(networkActions.filter(action => /^(send_|delete_|set_)/.test(action)).length, 0,
      'no platform write action may be sent')
    assert.equal(staged[0].platform, 'onebot')
    assert.ok(staged[0].endpointId.includes('123456'), 'inbox identity includes actual bot selfId')
    assert.equal((await inbox.unread('wire:r1-story', 'wire:alice')).length, 1)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: 'wire:r1-story' })).length, 0)
    assert.equal(stableInboxId(staged[0]).length, 64)
  } finally {
    await app.stop()
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()))
  }
})

test('R1 durable authorized row -> service dispatcher -> actual OneBot private write -> accepted receipt', async () => {
  const { WebSocketServer } = require('ws') as { WebSocketServer: any }
  const adapterModule = require('koishi-plugin-adapter-onebot') as any
  const httpModule = require('@koishijs/plugin-http') as any
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const writes: Array<{ action: string, params: Record<string, unknown> }> = []
  let loginSeen!: () => void
  const loginReady = new Promise<void>(resolve => { loginSeen = resolve })
  server.on('connection', (socket: any) => {
    socket.on('message', (buf: Buffer) => {
      const request = JSON.parse(buf.toString()) as { action: string, params: Record<string, unknown>, echo: number }
      if (request.action === 'send_private_msg') writes.push(request)
      const data = request.action === 'get_login_info'
        ? { user_id: 123456, nickname: 'WireOnly' }
        : request.action === 'send_private_msg' ? { message_id: 9001 } : {}
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: request.echo }))
      if (request.action === 'get_login_info') loginSeen()
    })
  })

  const app = new App()
  app.plugin(httpModule.default ?? httpModule)
  app.plugin(SQLiteDriver, { path: ':memory:' })
  registerTables(app)
  registerR1OutboxTables(app)
  app.plugin(adapterModule.default ?? adapterModule, {
    protocol: 'ws', selfId: '123456', endpoint: `ws://127.0.0.1:${address.port}`, responseTimeout: 2000,
  })
  const oldMode = process.env.HDSI_R1_DISPATCH_MODE
  try {
    await app.start()
    const deadline = Date.now() + 3000
    while (!app.bots.some(bot => bot.platform === 'onebot' && String(bot.selfId) === '123456')) {
      if (Date.now() > deadline) throw Error('R1_ONEBOT_LOGIN_TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await loginReady
    await new Promise(resolve => setTimeout(resolve, 30))
    const outbox = new R1AuthorizedOutbox(app)
    const now = new Date()
    await app.database.create('interlude_r1_outbox', {
      id: 'o'.repeat(64), storyId: 'wire:dispatch', participantId: 'wire:alice',
      sourceInboxId: 'i'.repeat(64), platform: 'onebot', endpointId: 'onebot:123456:2001',
      commitId: 'commit', eventId: 'event', payloadHash: 'p'.repeat(64),
      payloadContent: 'exact authorized text', approvalId: 'approval', principalId: 'host',
      credentialId: 'key', status: 'authorized', revision: 1,
      approvedAt: now, expiresAt: new Date(now.getTime() + 30_000), updatedAt: now,
    })
    const fixture: any = Object.create(InterludeService.prototype)
    fixture.ctx = app
    fixture.r1Outbox = outbox
    process.env.HDSI_R1_DISPATCH_MODE = 'authorized'
    const result = await (fixture as InterludeService).dispatchR1Authorized('o'.repeat(64), now)
    assert.equal(result.status, 'accepted', result.reason)
    assert.equal(result.adapterMessageId, '9001')
    assert.equal(writes.length, 1)
    assert.equal(String(writes[0].params.user_id), '2001')
    assert.deepEqual(writes[0].params.message, [{ type: 'text', data: { text: 'exact authorized text' } }])
    await assert.rejects(() => (fixture as InterludeService).dispatchR1Authorized('o'.repeat(64), now),
      /R1_OUTBOX_NOT_CLAIMABLE/)
    assert.equal(writes.length, 1)
  } finally {
    if (oldMode === undefined) delete process.env.HDSI_R1_DISPATCH_MODE
    else process.env.HDSI_R1_DISPATCH_MODE = oldMode
    await app.stop()
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()))
  }
})
