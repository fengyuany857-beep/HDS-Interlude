import test from 'node:test'
import assert from 'node:assert/strict'
import { proposeYukaGoal, type R2HostEvidence } from '../src/r2/yuka-goal-planner'
import { InterludeService } from '../src/service'

const now = '2026-10-10T12:00:00.000Z'
function observed(overrides: Partial<R2HostEvidence> = {}): R2HostEvidence {
  return {
    storyId: 'story:r2-isolated', now, observedAt: '2026-10-10T11:58:00.000Z',
    verifiedByHost: true, energy: 80, activityLoad: 'free',
    attentionMode: 'attentive', commitments: [], verifiedSourceEntryIds: [10, 31, 42],
    permittedContactParticipantIds: ['p:42'], ...overrides,
  }
}

test('R2 uses real Yuka 0.7.8 Think + GoalEvaluator, without a message transport', () => {
  const lib = require('yuka')
  assert.equal(typeof lib.Think, 'function')
  assert.equal(typeof lib.GoalEvaluator, 'function')
  const result = proposeYukaGoal(observed())
  assert.equal(result.status, 'proposed')
  assert.equal(result.goal, 'quiet-reflection')
  assert.equal(result.sideEffects, 'none')
  assert.equal(result.requiresScriptCommitAuthorization, true)
})

test('R2 exhausted or overloaded actor chooses rest before user contact', () => {
  const result = proposeYukaGoal(observed({
    energy: 10, activityLoad: 'overloaded',
    commitments: [{ id: 'c1', urgency: 1, sourceEntryIds: [10] }],
  }))
  assert.equal(result.goal, 'rest')
  assert.equal(result.ranking[0].goal, 'rest')
})

test('R2 grounded urgent commitment wins under sufficient capacity', () => {
  const result = proposeYukaGoal(observed({
    energy: 90, commitments: [{ id: 'work:1', urgency: 0.98, sourceEntryIds: [31] }],
  }))
  assert.equal(result.goal, 'fulfill-commitment')
  assert.equal(result.ranking[0].desirability, 0.94)
})

test('R2 contact consideration requires existing Agency capacity and ScriptEntry evidence', () => {
  const window = {
    activityLoad: 'free' as const, privacy: 'private' as const, deviceAccess: 'available' as const,
    validUntil: '2026-10-10T13:00:00.000Z', updatedAt: '2026-10-10T11:57:00.000Z',
    basis: 'host-observed', sourceEntryIds: [42],
  }
  const proposedContact = {
    participantId: 'p:42', origin: 'relationship-follow-up' as const,
    motive: 'follow up on a real interaction', disclosure: 'ordinary' as const,
    sourceEntryIds: [42], willingness: 0.99, outcome: 'send-now' as const,
    expiresAt: '2026-10-10T13:00:00.000Z',
  }
  const parent = observed({
    energy: 80, commitments: [{ id: 'c:42', urgency: 0, sourceEntryIds: [42] }],
    agencyWindow: window, proposedContact,
  })
  const allowed = proposeYukaGoal(parent)
  assert.equal(allowed.goal, 'consider-contact')
  assert.equal(allowed.sideEffects, 'none') // No automatic delivery.
  assert.equal(proposeYukaGoal(observed({ ...parent,
    agencyWindow: { ...window, deviceAccess: 'unavailable' },
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    attentionMode: 'asleep',
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    proposedContact: { ...proposedContact, sourceEntryIds: [99] },
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    permittedContactParticipantIds: ['different-person'],
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    agencyWindow: { ...window, sourceEntryIds: [99] },
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    proposedContact: { ...proposedContact, outcome: 'let-go' },
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    proposedContact: { ...proposedContact, notBefore: '2026-10-10T12:30:00.000Z' },
  })).goal, 'fulfill-commitment')
  assert.equal(proposeYukaGoal(observed({ ...parent,
    proposedContact: { ...proposedContact, expiresAt: '2026-10-10T11:00:00.000Z' },
  })).goal, 'fulfill-commitment')
})

test('R2 proposals are deterministic across simulated process restart', () => {
  const evidence = observed({ energy: 45 })
  const a = proposeYukaGoal(evidence)
  const b = proposeYukaGoal(JSON.parse(JSON.stringify(evidence)))
  assert.deepEqual(a, b)
  assert.equal(a.goal, 'rest')
})

test('R2 missing host evidence, stale clocks and invalid values fail closed', () => {
  const cases: Array<Partial<R2HostEvidence>> = [
    { verifiedByHost: false },
    { observedAt: '2026-10-10T11:00:00Z' },
    { observedAt: '2026-10-10T13:00:00Z' },
    { energy: Number.NaN },
    { energy: 105 },
    { commitments: [{ id: 'c', urgency: 1, sourceEntryIds: [] }] },
    { commitments: [{ id: 'c', urgency: 1, sourceEntryIds: [99] }] },
    { verifiedSourceEntryIds: [10, 10] },
    { commitments: [{ id: 'c', urgency: 1, sourceEntryIds: [2] },
      { id: 'c', urgency: 1, sourceEntryIds: [31] }] },
  ]
  for (const item of cases) {
    const result = proposeYukaGoal(observed(item))
    assert.equal(result.status, 'needs-evidence')
    assert.equal(result.goal, undefined)
    assert.equal(result.sideEffects, 'none')
    assert.deepEqual(result.ranking, [])
  }
})

test('R2 HDSI service route is disabled by default and only yields a proposal when explicitly enabled', () => {
  const old = process.env.HDSI_R2_SHADOW_PLANNER
  delete process.env.HDSI_R2_SHADOW_PLANNER
  try {
    assert.throws(() => InterludeService.prototype.proposeR2ShadowGoal(observed()), /R2_SHADOW_DISABLED/)
    process.env.HDSI_R2_SHADOW_PLANNER = 'proposal-only'
    const result = InterludeService.prototype.proposeR2ShadowGoal(observed())
    assert.equal(result.status, 'proposed')
    assert.equal(result.goal, 'quiet-reflection')
    assert.equal(result.sideEffects, 'none')
  } finally {
    if (old === undefined) delete process.env.HDSI_R2_SHADOW_PLANNER
    else process.env.HDSI_R2_SHADOW_PLANNER = old
  }
})
