import { createActor, createMachine } from 'xstate'

export type AttentionMode = 'attentive' | 'ringOnly' | 'dnd' | 'asleep'
export type AttentionEvent = 'RING' | 'DND' | 'SLEEP' | 'WAKE' | 'CHECK'

const modes: AttentionMode[] = ['attentive', 'ringOnly', 'dnd', 'asleep']
const graph: Record<AttentionMode, Partial<Record<AttentionEvent, AttentionMode>>> = {
  attentive: { RING: 'ringOnly', DND: 'dnd', SLEEP: 'asleep' },
  ringOnly: { CHECK: 'attentive', DND: 'dnd', SLEEP: 'asleep' },
  dnd: { CHECK: 'attentive', SLEEP: 'asleep' },
  asleep: { WAKE: 'ringOnly' },
}

/** Real XState execution with host-owned, persistable attention state. */
export function transitionAttention(current: AttentionMode, event: AttentionEvent): AttentionMode {
  if (!modes.includes(current)) throw new Error('R1_INVALID_ATTENTION_STATE')
  const machine = createMachine({
    id: 'hdsi-r1-attention', initial: current,
    states: Object.fromEntries(modes.map(mode => [mode, {
      on: Object.fromEntries(Object.entries(graph[mode]).map(([name, target]) => [name, { target }])),
    }])),
  })
  const actor = createActor(machine).start()
  actor.send({ type: event })
  const value = actor.getSnapshot().value
  actor.stop()
  if (typeof value !== 'string' || !modes.includes(value as AttentionMode)) throw new Error('R1_UNKNOWN_ATTENTION_RESULT')
  return value as AttentionMode
}

export function mayObserve(mode: AttentionMode): boolean { return mode === 'attentive' }
