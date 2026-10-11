import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import test from 'node:test'
import { App } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { R1Inbox, registerR1Tables, type R1Arrival } from '../src/r1/inbox'
import { registerTables } from '../src/database'

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
  registerTables(app); registerR1Tables(app)
  const inbox = new R1Inbox(app)
  let seen!: () => void
  const inbound = new Promise<void>(resolve => { seen = resolve })
  app.middleware(async (session, next) => {
    if (session.platform !== 'discord-user') return next()
    const arrival: R1Arrival = {
      storyId: 'discord-story', participantId: 'discord-peer', platform: session.platform,
      endpointId: [session.platform, session.selfId, session.channelId, session.userId].join(':'),
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
    assert.equal(staged[0].endpointId, `discord-user:${ROLE}:${CHANNEL}:${PEER}`)
    const stranger = await inject({ role_account_id: ROLE, author_user_id: '600000000000000006',
      dm_channel_id: CHANNEL, remote_message_id: '700000000000000007', content: 'blocked',
      is_direct: true, author_is_self: false })
    assert.deepEqual(await stranger.json(), { accepted: false })
    assert.equal((await inbox.unread('discord-story', 'discord-peer')).length, 1)
    const bot = app.bots.find(bot => bot.platform === 'discord-user' && bot.selfId === ROLE)
    assert.ok(bot)
    assert.deepEqual(await bot.sendPrivateMessage(PEER, 'exact authorized payload'), ['500000000000000006'])
    await assert.rejects(() => bot.sendPrivateMessage('600000000000000006', 'blocked'))
  } finally {
    await app.stop(); await stopSidecar(sidecar.child)
  }
})
