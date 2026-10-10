import assert from 'node:assert/strict'
import test from 'node:test'
import { App } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'

/**
 * Published Koishi Satori adapter over an actual loopback WebSocket speaking
 * Satori v1. The local gateway is protocol-only: it is not Discord/QQ and no
 * external account or platform endpoint is contacted.
 */
test('R1 loopback Satori v1 WS -> actual Koishi adapter -> durable direct Inbox, zero sends', async () => {
  const { WebSocketServer } = require('ws') as { WebSocketServer: any }
  const httpModule = require('@koishijs/plugin-http') as any
  const module = require('@koishijs/plugin-adapter-satori') as any
  const adapter = module.default ?? module
  assert.ok(adapter, 'published Koishi Satori adapter must load')

  const upgrades: Array<{ path?: string, authorization?: string }> = []
  const clientFrames: Array<{ op: number, body?: Record<string, unknown> }> = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const app = new App()
  app.plugin(httpModule.default ?? httpModule)
  app.plugin(SQLiteDriver, { path: ':memory:' })
  registerTables(app)
  registerR1Tables(app)
  const inbox = new R1Inbox(app)
  const staged: R1Arrival[] = []
  let seen!: () => void
  const inbound = new Promise<void>(resolve => { seen = resolve })

  app.middleware(async (session, next) => {
    if (session.platform !== 'satori-test' || !session.isDirect) return next()
    const arrival: R1Arrival = {
      storyId: 'wire:satori-story', participantId: 'wire:satori-alice',
      platform: session.platform,
      endpointId: [session.platform, session.selfId, session.channelId, session.userId].join(':'),
      platformMessageId: String(session.messageId), content: String(session.content),
      receivedAt: new Date(),
    }
    staged.push(arrival)
    await inbox.stage(arrival)
    seen()
    return // the inbound-only test never reaches any narrator or sender
  })

  server.on('connection', (socket: any, request: any) => {
    upgrades.push({ path: request.url, authorization: request.headers.authorization })
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as { op: number, body?: Record<string, unknown> }
      clientFrames.push(frame)
      if (frame.op === 1) return socket.send(JSON.stringify({ op: 2, body: {} }))
      if (frame.op !== 3) return
      assert.equal(frame.body?.token, 'loopback-test-token')
      const login = {
        sn: 1, adapter: 'loopback', platform: 'satori-test', status: 1,
        features: [], user: { id: 'bot-42', name: 'WireOnly' },
      }
      socket.send(JSON.stringify({ op: 4, body: { logins: [login], proxy_urls: [] } }))
      socket.send(JSON.stringify({
        op: 0,
        body: {
          sn: 2, type: 'message-created', login, self_id: 'bot-42',
          platform: 'satori-test', timestamp: Date.now(),
          user: { id: 'alice', name: 'Alice' },
          channel: { id: 'dm-alice', type: 1 },
          message: { id: 'satori-msg-7788', content: '你好 Satori', timestamp: Date.now() },
        },
      }))
    })
  })

  app.plugin(adapter, {
    endpoint: `http://127.0.0.1:${address.port}`,
    token: 'loopback-test-token', retryTimes: 0,
  })

  try {
    await app.start()
    await Promise.race([
      inbound,
      new Promise<never>((_, reject) => setTimeout(() => reject(Error(
        'R1_SATORI_INBOUND_TIMEOUT frames=' + JSON.stringify(clientFrames) + ' staged=' + staged.length,
      )), 6000)),
    ])
    assert.deepEqual(upgrades, [{ path: '/v1/events', authorization: 'Bearer loopback-test-token' }])
    assert.equal(clientFrames.filter(frame => frame.op === 3).length, 1, 'adapter must identify once')
    assert.equal(staged.length, 1)
    assert.equal(staged[0].platform, 'satori-test')
    assert.equal(staged[0].endpointId, 'satori-test:bot-42:dm-alice:alice')
    assert.equal(staged[0].platformMessageId, 'satori-msg-7788')
    assert.equal(staged[0].content, '你好 Satori')
    assert.equal((await inbox.unread('wire:satori-story', 'wire:satori-alice')).length, 1)
    assert.equal((await app.database.get('interlude_script_entry', { storyId: 'wire:satori-story' })).length, 0)
    assert.equal(stableInboxId(staged[0]).length, 64)
    assert.equal(clientFrames.some(frame => frame.op === 0), false,
      'client must not emit Satori events or platform writes')
  } finally {
    await app.stop()
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()))
  }
})
