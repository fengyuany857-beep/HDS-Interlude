import { Context } from 'koishi'
import { SQLiteDriver } from '@minatojs/driver-sqlite'
import { registerTables } from '../../src/database'
import { registerR1Tables } from '../../src/r1/inbox'
import { registerR1ProposalReceiptTable } from '../../src/r1/proposal-receipts'
import { R1AuthorizedOutbox, registerR1OutboxTables } from '../../src/r1/authorized-outbox'

const [path, id, claimAtRaw, startAtRaw] = process.argv.slice(2)
const app = new Context()
app.plugin(SQLiteDriver, { path })
let outbox!: R1AuthorizedOutbox
let ready!: () => void
const injected = new Promise<void>(resolve => { ready = resolve })
app.inject(['database'], ctx => {
  registerTables(ctx)
  registerR1Tables(ctx)
  registerR1ProposalReceiptTable(ctx)
  registerR1OutboxTables(ctx)
  outbox = new R1AuthorizedOutbox(ctx)
  ready()
})

async function main() {
try {
  await app.start()
  await injected
  const delay = Number(startAtRaw) - Date.now()
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
  try {
    const row = await outbox.claim(id, new Date(Number(claimAtRaw)))
    process.stdout.write('\nR1_WORKER_RESULT ' + JSON.stringify({ status: 'fulfilled', attemptId: row.attemptId }) + '\n')
  } catch (error) {
    process.stdout.write('\nR1_WORKER_RESULT ' + JSON.stringify({
      status: 'rejected', error: error instanceof Error ? error.message : String(error),
    }) + '\n')
  }
} finally {
  await app.stop()
}
}

void main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n')
  process.exitCode = 1
})
