'use strict'
const fs = require('node:fs')
const { App } = require('koishi')
const { SQLiteDriver } = require('@minatojs/driver-sqlite')
const httpModule = require('@koishijs/plugin-http')
const satoriModule = require('@koishijs/plugin-adapter-satori')
const hdsi = require('/app/lib')

const secret = fs.readFileSync('/run/secrets/local_bridge_token', 'utf8').trim()
if (secret.length < 32) throw new Error('bridge secret is invalid')
process.env.HDSI_R1_PRIVATE_INBOX = 'stage-only'

const app = new App()
app.plugin(httpModule.default ?? httpModule)
app.plugin(SQLiteDriver, { path: '/var/lib/hdsi-koishi/hdsi.sqlite3' })
app.plugin(satoriModule.default ?? satoriModule, {
  endpoint: 'http://hdsi-discord-f-sidecar:5140', token: secret, retryTimes: 0,
})
app.plugin(hdsi, {
  storyDefaults: { characterName: 'Discord Role', characterProfile: 'isolated private Discord role' },
  model: {}, onebot: { enabled: false }, sharedStory: {},
  runtime: { autoCreate: true, captureDirectMessages: true, ignoreCommandMessages: true },
})

app.start().then(() => console.log('HDSI_PHASE_F_KOISHI_READY')).catch(error => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  await app.stop()
  process.exit(0)
})
