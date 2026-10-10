# HDSI R2 | Yuka autonomous-goal candidate (isolated)

Current work date: 2026-10-10 (Asia/Shanghai).

## Exact target and boundaries

- Private GitHub repository: `fengyuany857-beep/HDS-Interlude`
- Candidate: `hdsi-r2-yuka-autonomy-candidate-20261010`
- Frozen R1 parent commit: `6a3dbc72a1c1375f8e846ab9f3c25c1c44392a51`
- Unmodified production/base branch: `main` = `3249a2017f9f763d5026236c2a9e7d0a3598fa61`
- License: original HDSI AGPL-3.0 preserved; dependency Yuka is MIT.
- Yuka package version selected: `0.7.8`, npm provenance https://www.npmjs.com/package/yuka, source https://github.com/Mugen87/yuka.
- Yuka 0.7.8 is an older, slow-moving package. Do not treat it as maintained or production-supported merely because installation succeeds.

## Reuse / replaceability architecture

Reuse the actual Yuka `Think` and `GoalEvaluator` for *arbitration only*:

- HDSI `src/agency.ts`: contact capacity, privacy, device access and minimum contact interval. Yuka MUST NOT override it.
- HDSI `src/scheduler.ts`: wakeups, exclusivity and backoffs. Yuka MUST NOT schedule its own timers here.
- HDSI R1 `src/r1/attention.ts`: observed state and attention mode. Yuka can propose contact only in `attentive` mode.
- HDSI `src/service.ts`: dispatch/TurnEngine/ScriptEntry/ScriptCommit/delivery remain under existing code ownership.
- R2 `src/r2/yuka-goal-planner.ts`: compute a deterministic score and use genuine Yuka to select the top proposal; *never* mutate world state.
- The candidate service method `proposeR2ShadowGoal` is disabled by default. A host must explicitly enable `HDSI_R2_SHADOW_PLANNER=proposal-only` and submit validated state. This can only return a proposal, not execute it.

Hard rule: `GOAL_PROPOSED != GOAL_EXECUTED`. An engine proposing `rest` is not evidence that the actor slept. A `consider-contact` selection is not authority to contact a user.

## Evidence and admission controls

- `verifiedByHost` must originate from an actual host data boundary, not LLM output.
- Fresh input observed within 15 min, finite bounded energy, constrained IDs, bounded commitment set, no duplicate commitment IDs.
- Every commitment source ID must exist in the host-resolved ScriptEntry ID list.
- A candidate contact must have linked trusted source IDs, a host-authorized recipient ID, an unexpired matching Agency window whose source IDs are grounded, an attentive state, and enough energy.
- If checks fail, return `needs-evidence` with no execution. This candidate is **read-only even if evidence is wrong**.

## Test and release gates

Path: `.github/workflows/hdsi-r2-yuka.yml`.
R2 test cases in `test/r2-yuka-goals.test.ts`:
- exact imported Yuka Think and GoalEvaluator
- fatigue/overload priority
- grounded urgent commitment
- existing Agency contact gate, unavailable device, asleep attention
- unauthorized participant and mismatched source lineage
- repeatability across a simulated process restart
- invalid/stale/missing provenance fails closed
- disabled-by-default HDSI service bridge

CI is configured to `npm ci` from the original HDSI lockfile, install exact `yuka@0.7.8` **in a temporary CI node_modules only** (`--no-save`), then run typecheck, full tests and build. The published package manifest/lockfile are NOT changed yet. Successful CI must precede pinning a production dependency.

## Open gates

1. Private GitHub Actions job startup failure from the R1 track still requires actual resolution; failed-to-start is not a failed code test.
2. R1 platform receive → Inbox → observed ScriptEntry → real ScriptCommit / delivery E2E remains incomplete.
3. R2 goal selection is not integrated with a durable live character intention ledger or the host observation transition. It must not be treated as autonomous gameplay.
4. No sandbox behavioral trial with actual model/Scheduler effects, no 24h runtime, no production or independent verification.
5. Final merge/release requires R1 hard gates, pinned dependency and lockfile, and R2 E2E. `main` must remain unchanged until separately authorized.

Formal load: global 00 v1.6 / GP-001 v1.0 and Project Organ R9 (UPO-00 v1.7, UPO-01 v1.4, UPO-06 v1.5, UPO-10 v1.0) read. GLCG CURRENT_RUNTIME 0.2.0 registry read; no native Resume/Drive pointer write authorized by this task.

Outcome: `R2_GOAL_PROPOSAL_SOURCE_STAGED / CI_EXECUTION_UNKNOWN_OR_BLOCKED / R1_HARD_GATES_OPEN`.
