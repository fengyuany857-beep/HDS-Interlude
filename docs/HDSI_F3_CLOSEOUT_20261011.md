# HDSI F3 | Source closeout and resume pointer

Recorded (UTC): 2026-10-11T13:45:26Z
Repo: `fengyuany857-beep/HDS-Interlude`
Branch: `hdsi-r1r2-core-graft-20261011`
Verified source baseline before closeout: `941fd16a0f98a4dfd3609167c45c3b6be6ac105b`
Formal release state: **PARTIAL**, not `PRIVATE_DEPLOYED_VERIFIED`.

## What is verified

- Source, R1/R2 adapter and private Discord inbound have prior real integration evidence. One persistent Story and Participant and one Inbox row were observed. Never infer a working outbound model worker from inbound success.
- The latest complete VPS no-credential suite on the baseline had **588 tests / 584 pass / 0 fail / 4 skip**; TypeScript typecheck passed. All four credentialed model-behavior tests were deliberately skipped.
- Latest read-only deployment check: existing Koishi image `hdsi-discord-f-koishi:f13057d` running, Sidecar image `hdsi-discord-f-sidecar:96c1c10` healthy.
- Candidate F3-C image `hdsi-discord-f-koishi:941fd16-f3c2` exists, with ID `sha256:4ea669132c742c69744fb39fb7fae1e4321b77946d66c8b3f63d6db59a56b958`. It is **not** the running Koishi.
- Candidate entrypoint has opt-in-only outbound/background action flags, `HDSI_PHASE_F_OUTBOUND_ARMED` and `HDSI_PHASE_F_BACKGROUND_ARMED`. Both default to off. Runtime patch source SHA-256: `ba8ee427d6860467d8562b63ac99c6e9d4291484685f46e96b55f21318e585b2`. This candidate behavior was statically/syntax inspected; it was not exercised in live Docker.
- Database backup `/srv/hdsi-discord-phase-f/backups/koishi-pre-f3c-20261011T123943Z.sqlite3`, SHA-256 `14491b666865e71f2b3405df50a49024ae76d26ab93194322cceb797a24d793f`, was integrity-checked.
- The separate historical untracked `Dockerfile.koishi-f1` and `package.runtime-f1.json` were intentionally preserved, **not committed**.

## Deliberately deferred by owner

1. **F3-B Live Model**: no four-call DeepSeek evidence. Previous attempt failed before sending a request. Existing `test:model` would make up to ten external requests if configured, so do not run it without a new capped authorization.
2. **F3-C Real Deployment**: candidate image built, but runtime swap was blocked. Current running Koishi remains the old stage-only instance.
3. **F4 Discord Recipient E2E**: no actual outbound has been authorized or verified. Prior maximum six-message budget is not reusable as continuing authority.

These are `DEFERRED_UNVERIFIED`, **never PASS**. Preserve the existing P0/P1 release blockers and do not weaken their acceptance criteria.

## Safe next-session recovery

- Fresh-read the current formal 00 protocols and Project Organ/GLCG as applicable; do not treat this file as registry or current state authority.
- Read the live GitHub branch head, VPS worktree, actual Docker image/container identities, database integrity and backup **before** any proposed mutation.
- Compare the final repository commit and source SHA to this candidate image; image build predates this archive commit.
- Reuse existing project, database and images. Do not restart or modify unrelated VPS containers.
- Confirm separate owner authorization for each of: deployment, paid model testing, and any real Discord message. Discord ordinary-user automation also has platform-account risk.
- No current task requires model credits, secret contents, a production switch or outbound Discord messages.

## Archival boundaries

The checkpoint `docs/r1r2-progress.json` remains `PARTIAL`. This handoff is a source and test evidence snapshot, not formal runtime release or independent production certification. Formal registry status was not changed. The prior GitHub Actions PASS covers the base SHA `941fd16a0f98a4dfd3609167c45c3b6be6ac105b`; closeout-only changes require their own checks.
