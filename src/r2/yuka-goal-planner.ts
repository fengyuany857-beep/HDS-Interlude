import { createHash } from 'node:crypto'
import { activeAgencyWindow, evaluateAgencyCapacity, resolveAgencyConfig } from '../agency'
import type { AgencyWindowState, ProactiveContactDraft } from '../types'
import type { AttentionMode } from '../r1/attention'

export type R2Goal = 'rest' | 'fulfill-commitment' | 'consider-contact' | 'quiet-reflection'
export interface R2Commitment {
  id: string
  urgency: number
  sourceEntryIds: number[]
}
export interface R2HostEvidence {
  storyId: string
  observedAt: string
  now: string
  /** The observer, never the language model, supplies this evidence. */
  verifiedByHost: boolean
  energy: number
  activityLoad: 'free' | 'occupied' | 'overloaded'
  attentionMode: AttentionMode
  commitments: R2Commitment[]
  /** Existing HDSI Agency is the sole authority for contact capacity. */
  agencyWindow?: AgencyWindowState
  proposedContact?: ProactiveContactDraft
  lastCharacterMessageAt?: string
}
export interface R2GoalProposal {
  status: 'proposed' | 'needs-evidence'
  goal?: R2Goal
  reason: string
  evidenceFingerprint: string
  ranking: Array<{ goal: R2Goal; desirability: number }>
  /** Yuka never creates a platform delivery, ScriptEntry, or world fact. */
  sideEffects: 'none'
  requiresScriptCommitAuthorization: true
}

interface YukaThink {
  addEvaluator(evaluator: unknown): YukaThink
  arbitrate(): YukaThink
}
interface YukaLibrary {
  Think: new (owner: object) => YukaThink
  GoalEvaluator: new (bias?: number) => {
    calculateDesirability(owner: object): number
    setGoal(owner: object): void
  }
}

const bounded = (value: number) => Math.max(0, Math.min(1, value))
const goals: R2Goal[] = ['rest', 'fulfill-commitment', 'consider-contact', 'quiet-reflection']

/**
 * The original Yuka 0.7.8 Think and GoalEvaluator run the arbitration.
 * Dynamic loading keeps the R1 production dependency graph unchanged until
 * the exact npm package and lockfile are separately verified in CI.
 */
function loadYuka(): YukaLibrary {
  let loaded: unknown
  try {
    loaded = require('yuka') as unknown
  } catch {
    throw new Error('R2_YUKA_0_7_8_NOT_INSTALLED')
  }
  const candidate = loaded as Partial<YukaLibrary>
  if (!candidate || typeof candidate.Think !== 'function' || typeof candidate.GoalEvaluator !== 'function') {
    throw new Error('R2_YUKA_API_MISMATCH')
  }
  return candidate as YukaLibrary
}

function validEvidence(input: R2HostEvidence): boolean {
  if (!input || !input.verifiedByHost || typeof input.storyId !== 'string' || !input.storyId.trim()) return false
  const now = Date.parse(input.now)
  const observed = Date.parse(input.observedAt)
  if (!Number.isFinite(now) || !Number.isFinite(observed) || observed > now || now - observed > 15 * 60_000) return false
  if (!Number.isFinite(input.energy) || input.energy < 0 || input.energy > 100) return false
  if (!['free', 'occupied', 'overloaded'].includes(input.activityLoad)) return false
  if (!['attentive', 'ringOnly', 'dnd', 'asleep'].includes(input.attentionMode)) return false
  if (!Array.isArray(input.commitments) || input.commitments.length > 100) return false
  if (new Set(input.commitments.map(item => item.id)).size !== input.commitments.length) return false
  if (input.commitments.some(item => !item.id || !Number.isFinite(item.urgency)
    || item.urgency < 0 || item.urgency > 1 || !Array.isArray(item.sourceEntryIds)
    || !item.sourceEntryIds.length || item.sourceEntryIds.some(id => !Number.isSafeInteger(id) || id < 1))) return false
  return true
}

/** Deterministic, bounded and read-only. There is no autonomous world mutation. */
export function proposeYukaGoal(input: R2HostEvidence): R2GoalProposal {
  const evidenceFingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  if (!validEvidence(input)) return {
    status: 'needs-evidence', reason: 'missing-stale-or-invalid-host-evidence',
    evidenceFingerprint, ranking: [], sideEffects: 'none', requiresScriptCommitAuthorization: true,
  }
  const now = new Date(input.now)
  const window = activeAgencyWindow(input.agencyWindow, now)
  const contact = input.proposedContact
  const contactSources = contact?.sourceEntryIds ?? []
  const contactGrounded = !!contact && contactSources.length > 0 && input.commitments
    .some(item => item.sourceEntryIds.some(id => contactSources.includes(id)))
  const contactCapacity = contact && contactGrounded && window && input.attentionMode === 'attentive'
    ? evaluateAgencyCapacity(window, contact, now, resolveAgencyConfig(), input.lastCharacterMessageAt)
    : undefined

  const able = input.activityLoad !== 'overloaded'
  const mostUrgent = input.commitments.reduce((best, item) => Math.max(best, item.urgency), 0)
  const scoring: Record<R2Goal, number> = {
    rest: input.activityLoad === 'overloaded'
      ? 0.98 : input.energy <= 50 ? bounded(0.65 + (50 - input.energy) / 50 * 0.35) : 0.08,
    'fulfill-commitment': able && input.energy > 25 && input.commitments.length
      ? bounded(0.45 + mostUrgent * 0.5) : 0,
    'consider-contact': able && input.energy > 40 && contact && contactCapacity?.allowed
      ? bounded(0.25 + (contact.willingness ?? 0) * 0.35) : 0,
    'quiet-reflection': 0.15,
  }

  // Yuka's Think.arbitrate() resolves equal scores using the last evaluator.
  // Reverse lexical registration yields stable lexical tie-breaks.
  const yuka = loadYuka()
  const owner: { goal?: R2Goal } = {}
  const brain = new yuka.Think(owner)
  for (const goal of [...goals].sort().reverse()) {
    class CandidateEvaluator extends yuka.GoalEvaluator {
      calculateDesirability(): number { return scoring[goal] }
      setGoal(): void { owner.goal = goal }
    }
    brain.addEvaluator(new CandidateEvaluator(1))
  }
  brain.arbitrate()
  if (!owner.goal || !(owner.goal in scoring)) throw new Error('R2_YUKA_ARBITRATION_MISSING')
  return {
    status: 'proposed', goal: owner.goal, reason: 'yuka-read-only-goal-arbitration',
    evidenceFingerprint,
    ranking: goals.map(goal => ({ goal, desirability: scoring[goal] }))
      .sort((a, b) => b.desirability - a.desirability || a.goal.localeCompare(b.goal)),
    sideEffects: 'none', requiresScriptCommitAuthorization: true,
  }
}
