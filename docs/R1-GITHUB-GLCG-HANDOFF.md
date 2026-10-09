# HDSI R1 | GitHub / GLCG continuation handoff

Date: 2026-10-10 (Asia/Shanghai)

## Authoritative source identity

- Repository: https://github.com/fengyuany857-beep/HDS-Interlude
- Upstream: https://github.com/yunwuneo/hds-interlude
- Upstream rc36 commit: `338e7096bf2df66fa0643b6518172066da379479`
- Key source blob: `src/database.ts` = `d1ceae17cb7ede3b241d533179c343acc5c7dfe6`
- Main import commit: `3249a2017f9f763d5026236c2a9e7d0a3598fa61`
- R1 development branch: `hdsi-r1-real-graft-20261010`
- Verified real-dependency pin commit: `b1a796e5819b18d3c3ec0767270033534a1ca878`
- License: AGPL-3.0; upstream LICENSE preserved.

The imported upstream Git ancestry is preserved via an unrelated-history merge into a newly created repository. The upstream source is not an official user-owned release, and the original author repository remains unchanged.

## GitHub Actions evidence

- Source import: https://github.com/fengyuany857-beep/HDS-Interlude/actions/runs/37976539912
- Real dependency verification: https://github.com/fengyuany857-beep/HDS-Interlude/actions/runs/37976719782
- Baseline and after-install HDSI unit tests: 537 discovered, 533 passed, 4 skipped, 0 failed in each execution.
- Baseline and after-install TypeScript typecheck: PASS.
- Baseline and after-install HDSI build: PASS.
- Installed pinned npm libraries: `xstate@5.33.2` and `json-rules-engine@7.3.1`.
- Runtime smoke: 12 / 12 PASS; explicitly tests attention-state restoration and rules gating.
- Source branch candidate dependency manifest and lockfile are committed; `main` retains the untouched rc36 dependency set.

## Status and safety gates

Status: **R1.1_REAL_DEPENDENCIES_VERIFIED / R1.2_INTEGRATION_PENDING**.

**NOT VERIFIED**: production Koishi environment; durable Inbox admission and atomic ScriptEntry promotion; real service.ts and TurnEngine wiring; early private reply pre-send fencing; crash recovery with stable platform event IDs; real Koishi/SQLite end-to-end and actual message delivery.

Do not mark R1 fully accepted or enable automatic inbound ingestion/character replies from these smoke tests. In particular:
1. `service.receive()` persists user-message entries and interruptions before `TurnEngine`; inbox admission/visibility gating must precede any model-visible script persistence.
2. The in-memory `TurnEngine` cannot be treated as durable authoritative state; replay cannot fabricate original `Koishi.Session`.
3. The early streaming path `deliverEarlyPrivateReply()` and both script/delivery ledgers must be gated before sends.
4. Story/character/participant scoped idempotency and exact platform IDs are mandatory.

## GLCG continuity

Previous local GLCG checkpoint: `WS-b2b53975170949669996b98fd5ad3f46`, `CP-HDSI-R1-OFFLINE-STAGED-20261010`. It represented an offline-staged, partially blocked candidate, **not** real Koishi acceptance. This GitHub branch and Actions run provide newer evidence only for the real-dependency gate. **No native GLCG CURRENT_RESUME or Google Drive pointer has been changed by this GitHub operation**. Keep HDSI continuation separate from Observer / VCW / other project pointers.

Next tasks: integrate real XState and rules engine through fail-closed adapters on this branch; implement durable atomic admission/promotion in actual Koishi DB; run crash, duplicate, multi-participant, private/group, and delivery ledger E2E; then create a new GLCG native checkpoint with explicit real evidence. Do not merge this branch into main until the gates are met.
