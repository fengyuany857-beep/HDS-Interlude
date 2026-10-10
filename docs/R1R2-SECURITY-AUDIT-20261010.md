# R1/R2 candidate outbound security audit

Scope: manual changed-path review from `1acb650d471c47b8fbbf0cd4c76b04eb1ed74dd7` through `5729c292926b4d28c13a9072d25acca485c9350c`, plus unchanged outbound call sites needed to verify bypass behavior.

Classification: candidate security review evidence, not a formal Codex Security/SARIF scan. The configured security-scan skill did not expose its required preflight references or helper tools in this executor.

## Threat boundary and result

The model, incoming platform content, ScriptCommit draft, approval request, adapter response and late transport receipt are untrusted. Trust is limited to the configured Ed25519 public identity, the exact signed approval fields, SQLite transaction outcome and the selected Koishi adapter instance.

No P0 security finding was identified in the reviewed diff. No real platform, production service or external user was contacted during this review.

## Outbound inventory reviewed

- `src/service.ts`: legacy `session.send`, `bot.sendMessage`, image/face sends, cross-group sends, Qzone/desktop host calls, and the new `dispatchR1Authorized` route.
- `src/index.ts`: interactive administrator command response.
- `src/r1/outbox-dispatcher.ts`: the only new R1 transport callback.
- `src/anthropic.ts` and `src/narrator.ts`: model-provider HTTP calls; these are not platform-message delivery routes.

When R1 Inbox mode is active, the legacy private/group/media/Qzone paths retain their existing early fail-closed guards. The new route is separately disabled unless `HDSI_R1_DISPATCH_MODE=authorized`, requires a previously signed and persisted authorized row, selects exact platform + bot self ID + user ID, claims durably before the adapter call, and never retries `UNKNOWN`.

## Controls verified by tests

- Ed25519 signature covers principal, credential, action class, receipt, story, participant, source Inbox, platform, endpoint, commit, event, exact content/hash and approval timestamps.
- Source Inbox, proposal receipt and payload are checked again inside the authorization transaction.
- `BEGIN IMMEDIATE` prevents two SQLite connections or two Node processes from both claiming one row.
- OneBot and Satori loopback tests assert exact account, user and content and persist the adapter message ID.
- TCP read followed by lost acknowledgement becomes `UNKNOWN`; repeat dispatch cannot create a second write.
- Restart recovery changes stale `attempting` rows to `UNKNOWN` without calling transport.

## Remaining release-security gaps

- A formal scanner-produced report/SARIF remains unavailable in this executor and is a P1 evidence gap.
- The four credentialed production-model behavior tests still require the protected manual workflow.
- Live OneBot/Satori production authorization and delivery are intentionally not tested; loopback protocol acceptance is not recipient delivery.
- Secret rotation/revocation operations and a long-duration soak still require release acceptance evidence.

