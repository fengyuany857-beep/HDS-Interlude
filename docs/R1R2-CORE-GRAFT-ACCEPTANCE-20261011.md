# HDSI R1/R2 candidate continuation and acceptance boundary

Baseline commit: `3ccd55738921b9ebb6d1d588a088e9cd73d32695`.
Isolated development branch: `hdsi-r1r2-core-graft-20261011`.
Original branch and `main` are out of scope. This file is a candidate record, not a production approval.

## A: Implemented in candidate source

- R1 inbox uses real Minato SQLite staging, XState attention CAS, and transactional observation (pre-existing).
- `InterludeService.observeR1AndPrepare()` is an explicit host-only entrypoint: validate Reality Gate, reject concurrent turn work, promote an observed inbox row to canonical user ScriptEntry, build a literal-bound ScriptCommit proposal, persist a durable review receipt.
- R1 stage-only mode keeps actual send disabled. Candidate guard also blocks direct group delivery, stickers, native faces, and Qzone operations; the receipt must never imply sent.
- `pendingR1Review()` / `rejectR1Proposal()` expose durable review queue and idempotent terminal rejection.
- R2 `submitR2HostGoal()` persists only read-only Yuka goal proposals. `restoreR2Review()` schedules a host review marker using a distinct timer namespace, separate from real outgoing script wakeups. The scheduler never performs a goal action.

## B: Tested/Not Tested Boundary

Tests in this candidate include real Koishi Mock + SQLite, host evidence rejection, idempotent replay, durable review receipt, disk restart, repeated/rejected proposal, R2 goal state restoration, and simulated no-send checks for message, group, sticker, native face, Qzone.
The GitHub workflow `.github/workflows/hdsi-real-test-graft.yml` runs Node 22 typecheck, npm tests, and build on this isolated branch.
Inspect the CI run attached to the *latest HEAD*, not a previous green run, before claiming an accepted build.

## Explicit release blockers

1. No demonstrated production-compatible R1 reviewed-turn narrator execution and audited real ScriptCommit persistence/outbox. Current result is a host-mediated *proposal*, not an action authorization or platform delivery.
2. No transport attempt, adapter-confirmed success/failure, or verified external receipt is recorded by the new R1 review ledger. `pending-review` and `rejected` are the only valid statuses.
3. No real OneBot/Satori platform E2E with real access, restarts, disconnect-after-accept faults, or multiple worker races. Koishi Mock is not production OneBot/Satori evidence.
4. Host life-state energy/load and platform approval must come from separately authenticated, current sources. A bare boolean `verifiedByHost` is not an identity/authentication mechanism.
5. CI temporarily installs exact Yuka/Mock/MSW/fast-check versions without committing their dependency lock. Before release, generate and review a deterministic lockfile and rerun `npm ci` without ephemeral install.
6. No production automated send, deployment, merge to `main`, or release has been authorized or attempted. This branch is not ready for production rollout.

## Next controlled engineering sequence

A) Establish a host-owned approval contract and immutable outbox identity; persist authorized ScriptCommit and send-attempt leases with CAS, return `unknown` on ambiguous transport failures rather than retrying.
B) Route every adapter action via a single delivery boundary and enforce host-attested Reality Gate and endpoint allowlist.
C) Integrate R2 scheduler due events with trusted life snapshots and real action receipts only after successful post-condition validation.
D) Run adapter-realistic tests, crash/restart/race fault injection, long-duration soak, dependency lock verification, then seek explicit external E2E and release authorization.

This document must not be used to promote untested candidate functions to CURRENT or verified platform integration.
