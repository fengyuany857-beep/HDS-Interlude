import { Engine } from 'json-rules-engine'

export interface ActionEvidence {
  attemptedTravel: boolean
  elapsedMinutes?: number
  minTravelMinutes?: number
  travelExceptionVerified?: boolean
  claimsCompletedAction: boolean
  completionEvidenceVerified: boolean
  /** Only host-controlled verified observations may set these true. */
  authoritative?: boolean
}
export type ActionVerdict = { status: 'allow' | 'reject' | 'needs-data'; reasons: string[] }

/** Engine evaluates genuine host facts; the model may not self-authorize evidence. */
export async function checkAction(evidence: ActionEvidence): Promise<ActionVerdict> {
  if (!evidence.authoritative) return { status: 'needs-data', reasons: ['host-evidence-not-verified'] }
  if (evidence.attemptedTravel
    && (!Number.isFinite(evidence.elapsedMinutes) || !Number.isFinite(evidence.minTravelMinutes)
      || evidence.elapsedMinutes! < 0 || evidence.minTravelMinutes! < 0)) {
    return { status: 'needs-data', reasons: ['travel-time-not-measured'] }
  }
  const engine = new Engine()
  engine.addRule({
    conditions: { all: [{ fact: 'impossibleTravel', operator: 'equal', value: true }] },
    event: { type: 'impossible-travel' },
  })
  engine.addRule({
    conditions: { all: [{ fact: 'unsupportedCompletion', operator: 'equal', value: true }] },
    event: { type: 'unsupported-completion' },
  })
  const { events } = await engine.run({
    impossibleTravel: evidence.attemptedTravel && !evidence.travelExceptionVerified
      && evidence.elapsedMinutes! < evidence.minTravelMinutes!,
    unsupportedCompletion: evidence.claimsCompletedAction && !evidence.completionEvidenceVerified,
  })
  return events.length
    ? { status: 'reject', reasons: events.map(event => String(event.type)) }
    : { status: 'allow', reasons: [] }
}

/** Unknown action provenance is a block, never a permissive fallback. */
export async function assertHostAuthorized(evidence: ActionEvidence): Promise<void> {
  const verdict = await checkAction(evidence)
  if (verdict.status !== 'allow') throw new Error('R1_REALITY_GATE:' + verdict.reasons.join(','))
}
