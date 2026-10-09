# HDSI R1 private-repository continuation checkpoint

Observed: 2026-10-10, Asia/Shanghai. This document is a GitHub-side handoff, **not** a GLCG CURRENT_RUNTIME or Google Drive pointer mutation.

## Exact source and action scope
- Repository: `fengyuany857-beep/HDS-Interlude`; visibility confirmed **private**.
- Development branch: `hdsi-r1-real-graft-20261010`.
- Canonical main baseline: `3249a2017f9f763d5026236c2a9e7d0a3598fa61`; main was not modified.
- Candidate pre-handoff head: `8c38589c46f239c3d4675cec6f7b3482b65e09a8`.
- Previous original-source provenance: upstream `338e7096bf2df66fa0643b6518172066da379479`.
- No production deploy, active Inbox switch, live platform message, or public mirror.

## Implemented patches (source evidence, not test attestation)
- `src/r1/inbox.ts`, commit `9741b1f96ec121b10629ab1518548a7c376f471e`: reject identical-scoped platform message IDs with conflicting content; verify canonical ScriptEntry, actor, kind, sourceInboxId, and content before accepting duplicate promotion receipt.
- `test/r1-inbox-integrity.test.ts`, commit `045c44274af8d8eda7fc478f900c4c3fb251d4fa`: 3 actual Koishi + SQLite regression cases for collision, tampered source receipt, and mutated script content. Written but **NOT executed**.
- `.github/workflows/hdsi-r1-verify.yml`, commit `8c38589c46f239c3d4675cec6f7b3482b65e09a8`: restrict GitHub token to `contents: read`, use pinned committed lockfile with `npm ci`, remove redundant online dependency mutation and auto-commit, retain real npm smoke, typecheck, full test, and build steps. This workflow has **NOT executed successfully** after the revision.

## GitHub CI evidence
- Last full completed real Koishi/SQLite and HDSI suite on earlier commit `b2a7935f42fdc32a7bb6baeeba6b4d2fd10aeca7`: run `37977972413`, SUCCESS; 541 tests total, 537 PASS, 4 SKIP, 0 FAIL. Not evidence for later repairs.
- Prior inbox-fix-only run `37980691073`, SUCCESS; does not include the three newer regressions.
- Run `37980724663` on new tests, FAILED with no actual job steps; repeated attempt was also FAILED before any reported step.
- Run `37981498652` on read-only CI, FAILED with no reported job steps.
- Observed failure characteristic: job completes rapidly without a runner/steps/logs after repo became private. Precise GitHub platform cause **UNKNOWN** (account billing/private Actions availability/runner policy are hypotheses, not verified diagnosis).
- Treat CI as **not attempted at test-command level**, not as test assertions failing. Do not retry indefinitely without a state change. Do not publish private code into a public CI workaround.

## Hard gates still pending
1. Private GitHub Actions runner actually provisions and executes the pinned workflow on the current candidate commit.
2. Real Koishi private incoming Session → durable Inbox → attention observation → ScriptEntry → TurnEngine → ScriptCommit → outgoing delivery, with all identity/auth boundaries validated.
3. Host-verified json-rules-engine physical-action checks wired before ALL relevant script commits and delivery paths. The current `src/r1/reality.ts` remains a tested but separate implementation.
4. Full failure injection including simultaneous duplicate delivery, restart around transactional promotion, streaming pre-send, group/private isolation and receipt reconciliation.
5. Release/GLCG checkpoint update only after evidence bound to exact current commit. No Drive pointer save without explicit user save request.

Current terminal state: **PARTIAL / PRIVATE_ACTIONS_RUNNER_UNAVAILABLE / R1_PLATFORM_E2E_PENDING**.
