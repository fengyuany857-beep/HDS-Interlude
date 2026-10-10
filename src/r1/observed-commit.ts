import type { Context } from 'koishi'
import type { NarrativeDecision } from '../types'
import { decisionToScriptCommit } from '../script/commit-builder'
import { isOutgoingScriptEvent, type ScriptCommitDraft } from '../script/contract'
import { validateScriptCommit } from '../script/validator'

export interface ObservedCommitInput {
  storyId: string
  participantId: string
  inboxId: string
  scriptEntryId: number
  frameId: string
  burstId: string
  now: Date
  decision: NarrativeDecision
}

export interface ObservedCommitProposal {
  status: 'proposal-only'
  sideEffects: 'none'
  requiresHostRealityGate: true
  requiresHostDeliveryAuthorization: true
  sourceInboxId: string
  sourceScriptEntryId: number
  commit: ScriptCommitDraft
}

/** Read-only bridge from a verified promoted Inbox row to an unexecuted script proposal. */
export async function prepareObservedCommit(ctx: Context, request: ObservedCommitInput,
  reader: Pick<Context['database'], 'get'> = ctx.database): Promise<ObservedCommitProposal> {
  if (!request.storyId?.trim() || !request.participantId?.trim() || !request.inboxId?.trim()
    || !Number.isSafeInteger(request.scriptEntryId) || request.scriptEntryId <= 0
    || !request.frameId?.trim() || !request.burstId?.trim()) throw Error('R1_INVALID_OBSERVATION_IDENTITY')
  const now = request.now instanceof Date ? request.now.getTime() : NaN
  if (!Number.isFinite(now)) throw Error('R1_INVALID_OBSERVATION_TIME')
  const row = (await reader.get('interlude_r1_inbox', {
    id: request.inboxId, storyId: request.storyId,
    participantId: request.participantId, status: 'observed',
  }))[0]
  if (!row || !row.observedAt || row.scriptEntryId !== request.scriptEntryId) throw Error('R1_NOT_OBSERVED')
  const entry = (await reader.get('interlude_script_entry', {
    id: request.scriptEntryId, storyId: request.storyId, participantId: request.participantId,
  }))[0]
  if (!entry || entry.kind !== 'user-message' || entry.actor !== 'user'
    || entry.metadata?.sourceInboxId !== row.id
    || entry.metadata?.platform !== row.platform
    || entry.metadata?.messageId !== row.platformMessageId
    || entry.content !== row.content.slice(0, 12_000)) throw Error('R1_PROVENANCE_MISMATCH')
  const received = new Date(row.receivedAt).getTime()
  const observed = new Date(row.observedAt).getTime()
  if (!Number.isFinite(received) || !Number.isFinite(observed) || observed < received || now < observed) {
    throw Error('R1_OBSERVATION_TIME_INVALID')
  }
  const decision = request.decision
  if (!decision || !decision.script?.trim() || decision.interaction?.seen !== true) {
    throw Error('R1_UNGROUNDED_DECISION')
  }
  if (decision.crossConversationActions?.length || decision.intents?.length || decision.browserIntents?.length
    || decision.followUpCommitment || decision.localMedia || decision.nativeFace
    || decision.messageReactions?.length) throw Error('R1_UNREVIEWED_ACTION')
  if (decision.interaction?.reply?.mode === 'delayed') throw Error('R1_DELAYED_ACTION_UNREVIEWED')
  const commit = decisionToScriptCommit({
    storyId: request.storyId, participantId: request.participantId,
    phase: 'user-message', from: new Date(received), now: request.now,
    frameId: request.frameId, burstId: request.burstId, decision,
  })
  const validation = validateScriptCommit(commit)
  if (!validation.valid) throw Error('R1_INVALID_COMMIT:' + validation.errors.join(','))
  for (const event of commit.events) {
    if (['group-message', 'platform-action', 'browser-intent', 'future-intent'].includes(event.kind)) {
      throw Error('R1_OUT_OF_SCOPE_EVENT')
    }
    if (isOutgoingScriptEvent(event)
      && (event.kind !== 'outgoing-message' || event.participantId !== request.participantId
        || event.deliveryMode !== 'immediate' || event.scriptBinding?.status !== 'bound')) {
      throw Error('R1_UNBOUND_DELIVERY')
    }
  }
  return {
    status: 'proposal-only', sideEffects: 'none', requiresHostRealityGate: true,
    requiresHostDeliveryAuthorization: true, sourceInboxId: row.id,
    sourceScriptEntryId: request.scriptEntryId, commit,
  }
}
