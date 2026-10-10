import assert from 'node:assert/strict'
import test from 'node:test'
import { App } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../src/database'
import { R1Inbox, registerR1Tables, stableInboxId, type R1Arrival } from '../src/r1/inbox'

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
