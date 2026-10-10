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
- R2 `src/r2/yuka-goal-planner.ts`: use genuine Yuka to choose one evidence-bound, read-only goal.
- R2 `src/r2/goal-ledger.ts`: own independent, append-only proposal/review event receipts plus a CAS-controlled current-goal row; never write HDSI canonical world events.
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

CI is configured to `npm ci` from the original HDSI lockfile, install exact `yuka@0.7.8` **temporarily in CI node_modules only** (`--no-save`), then run typecheck, full tests and build. The production package manifest/lockfile are not changed yet.

### Exact real execution and repair evidence

- `src/r2/goal-ledger.ts`: Minato SQLite schema prepared outside write transactions, proposal current-state revision CAS, event journal, goal-specific next-review deadline, deterministic simulated `review-due` transition.
- Cross-instance writes sharing one Minato SQLite driver are serialized to prevent nested `BEGIN TRANSACTION` errors. This serialization does **not** prove cross-process/multi-host coordination.
- `test/r2-goal-ledger-sqlite.test.ts`: real on-disk SQLite cold restart, R1 unobserved → attention check → canonical ScriptEntry → R2 proposal, exact evidence IDs, persistent history, idempotent time review, invalid source rollback, per-story isolation and host-clock gate.
- `test/r2-goal-ledger-race.test.ts`: stale proposal replay cannot restore superseded goal; three simultaneous duplicate submits create exactly one journal event.
- Real GitHub Actions `38036807277` on source commit `44cacee535eb7931a273ebca5d692bd041ab3610`: **SUCCESS**. Node 22, genuine `yuka@0.7.8`, TypeScript typecheck, **555 tests / 551 pass / 4 skip / 0 fail**, and JS/declaration build PASS.
- Earlier attempts `38036473809` exposed primary-key update and lazy-schema rollback; `38036746230` exposed nested SQLite transactions. These failures were fixed and the new tests rerun without removal or suppression.
- Verification is GitHub-hosted single-executor integration/regression, not independent production validation.

## Open gates

1. Public GitHub-hosted CI works and test commands execute. The former private-runner startup blocker is no longer applicable to **current public** candidate, but private policy/billing cause was never independently proven.
2. R1 real platform Session → Inbox → observation → TurnEngine → ScriptCommit → early/delayed/cross-platform send E2E remains incomplete. The R1→R2 **database** integration case is already tested and must not be misrepresented as platform E2E.
3. The R2 ledger is used by isolated test callers; `src/service.ts` only exposes disabled-by-default proposal generation. Wiring the trusted host observation provider, authorized goal refresh and Scheduler requires separate integration and end-to-end tests.
4. R2 source-of-truth energy/activity still needs a verified host data provider. The `verifiedByHost` boolean alone is not an authentication mechanism.
5. No 24-hour soak, cross-process/multi-host contention proof, actual character life-action enactment, production rollout, or independent verification.
6. The four skipped tests remain skipped; R1 platform hard gates, production-pinned Yuka dependency, release and merge still remain unapproved.

Formal load: global 00 v1.6 / GP-001 v1.0 and Project Organ R9 (UPO-00 v1.7, UPO-01 v1.4, UPO-06 v1.5, UPO-10 v1.0) read. GLCG CURRENT_RUNTIME 0.2.0 registry read; no native Resume/Drive pointer write authorized by this task.

Outcome: `R2_YUKA_AND_SQLITE_LEDGER_BUILD_VERIFIED / GOAL_EXECUTION_DISABLED / R1_PLATFORM_E2E_PENDING / PARTIAL`. Candidate source commit verified: `44cacee535eb7931a273ebca5d692bd041ab3610`. This documentation commit is provenance-only, not a new runtime test attestation.
