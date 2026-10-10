# HDS-Interlude R1/R2 mainline handoff: atomic review, shadow outbox, real OneBot wire

Observed date: 2026-10-11 (Asia/Shanghai)
Candidate branch: `hdsi-r1r2-core-graft-20261011`
Accepted source HEAD before this documentation commit: `e4c85433155acb74badfca37eb697efc5ffa5037`
Accepted GitHub Actions run: https://github.com/fengyuany857-beep/HDS-Interlude/actions/runs/38080660835
Evidence: Node 22, 569 tests, 565 PASS / 0 FAIL / 4 SKIP, typecheck + build success.

## Immutable mainline boundaries

- Keep existing R1Inbox, XState attention, TurnEngine, ScriptCommit, Koishi/Minato SQLite.
- Keep existing R2 Yuka goal ledger + existing scheduler, proposal-only.
- R1 `stage-only` is NOT a production send mode. Never imply reviewed, attempted, adapter-accepted and recipient-delivered are identical.
- Do not change `main`, enable real sends, require real QQ/Satori credentials, or switch production connections through this candidate.
- Do not embed Node >=24 `onebots` into Node 22 HDSI as a side-effect of protocol test discovery.
- External donor modules are transport/test capabilities, not sources of HDSI authority or life-state truth.

## Implemented and verified in this candidate

1. **Atomic review path**: `R1Inbox.observeWith()` runs promotion, `prepareObservedCommit(..., tx)` provenance validation and `R1ProposalReceipts.open(..., tx)` in one database transaction. Rejected ScriptCommit or receipt-write failure leaves Inbox unread and no canonical ScriptEntry. The old `observe()` API retains its standalone transaction behavior.
2. **Additive R1 authorized outbox**: `src/r1/authorized-outbox.ts` has review/source/endpoint/payload hash binding; separately provided trusted-host verifier; 60-second max approval TTL; SQLite CAS claim; append-only transition receipts; terminal accepted/rejected/unknown; no retry from unknown. No transport and no notifier exist in this class.
3. **Fail-closed service integration**: `HDSI_R1_PRIVATE_INBOX=stage-only` registers additive outbox tables, creates R1 outbox **without** a verifier, and exposes `uncertainR1Outbox()` as read-only observation. No public host authorization or platform send route has been enabled.
4. **Strict genuine protocol wire test**: `test/r1-onebot-real-adapter-wire.test.ts` starts local `ws` TCP/WebSocket server, installs published `koishi-plugin-adapter-onebot@6.9.4` and required `@koishijs/plugin-http@0.6.3`, receives actual OneBot V11 inbound frame in Koishi and inserts a real Minato SQLite Inbox record. Asserts zero outbound write API calls and zero synthetic ScriptEntries. The fake server is NOT `onebots` and is NOT an external QQ/NapCat endpoint.
5. **Real SQLite regression**: `test/r1-authorized-outbox-sqlite.test.ts` checks review, principal-verifier fail-close, endpoint and payload binding, CAS contention, expired authorization, adapter response shape, unknown quarantine and restart. `test/r1r2-service-core-graft.test.ts` now explicitly checks transaction rollback after invalid binding and injected receipt-write exception.

## Release blockers remain

- **P1 AUTH**: no real authenticated host principal/evidence adapter or concrete public host authorization API installed. A verifier callback is not proof of production host integration; the service instantiates outbox with no verifier by design.
- **P1 DELIVERY**: no real transport attempt/wire send under a host-bound approval, no external receipt reconciler, no audit of all outbound bypasses, and no production recovery policy after unknown.
- **P1 MULTIPROTOCOL**: OneBot loopback PASS is not Satori E2E or OneBots Node24 mock gateway integration. Satori account/channel route continuity remains untested.
- **P1 CHAOS**: no actual Toxiproxy TCP-reset, after-accept-ack-loss, cross-process worker race or prolonged restart/soak acceptance.
- **P1 RELEASE**: CI still adds optional test packages via `npm install --no-save`; deterministic dependency-lock review and separate deployment authorization are not done.
- **P2 LIFE**: R2 proposal-only review scheduler cannot claim actual life-state/action completion, pending trusted host source integration.

## Next bounded mainline sequence

A. Separate Satori v1 real adapter and protocol mock test using a version pinned to HDSI's Koishi 4 environment (do not pull the new incompatible `@satorijs/core` 5 alpha into the production graph). Preserve zero-send assertion.

B. Wire a separately authenticated real host approval provider to the durable outbox, still under a new disabled-by-default test-only dispatch mode. Verify exact payload/endpoint/action/TTL and one attempt claim, never infer sent status from reviewing.

C. Add local network fault injection and reconciliation/readback for ambiguous acknowledgements. Unknown is a quarantine, not an automatic retry; two-process data races and late acknowledgements require explicit tests.

D. Deterministic lockfile, outbound route audit, crash/restart soak, independent acceptance, then separate user authorization before any real platform deployment or external sends.

## Result classification

Goal/Scope: candidate-only R1/R2 compressed build continuation, no additional product features.
Action: source/test/workflow edits on isolated GitHub candidate; no main/production/real bot actions.
Verification: GitHub Actions Node 22 real Koishi SQLite and loopback OneBot Mock transport + static code inspection; same-executor CI, no independent reproduction.
Convergence: **PARTIAL**, CI-accepted candidate milestone, not production acceptance.
