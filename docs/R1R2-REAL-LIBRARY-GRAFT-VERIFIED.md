# R1/R2 real test-library graft: verified candidate

Observed: 2026-10-10 Asia/Shanghai. This is a source-bound candidate handoff, not a production or global runtime release.

## Exact scope
- Repository: `fengyuany857-beep/HDS-Interlude`
- Branch: `hdsi-r1r2-real-test-graft-20261010`
- Frozen R2 parent: `bac4af1d4b84bfd3d8fae689f263f0b34e0fbd84`
- Tested source commit: `f32736012bc2b14df0541782ac4c47cbedb83f06`
- GitHub Actions: https://github.com/fengyuany857-beep/HDS-Interlude/actions/runs/38054105447
- `main` was not changed. No release, deploy, live user message or auto-action.

## Verified implementation
- Genuine npm packages installed in isolated GitHub runner:
  - `yuka@0.7.8`
  - `@koishijs/plugin-mock@2.6.6`
  - `msw@3.0.3`
  - `fast-check@4.10.2`
- Workflow checks exact package versions using package manifests, confirms R2 ancestry, verifies canonical `src/database.ts` blob, and fails if either repository package manifest or lockfile changes.
- Actual CI `38054105447`: **SUCCESS**. TypeScript `npm run typecheck`, full `npm test` (559 total, 555 PASS, 4 SKIP, 0 FAIL), `npm run build`: all PASS.
- New test source `test/r1r2-real-test-graft.test.ts` exercises:
  1. Official Koishi MockBot private Session -> R1 Inbox staging with genuine Koishi SQLite; no invented user ScriptEntry before observation, duplicate handling, conflicting-ID rejection, attention gate, idempotent promotion.
  2. Official Mock group channel reports `platform: mock`, not OneBot.
  3. Actual MSW server intercepts test HTTP requests and returns both 200 and 503 responses.
  4. Actual fast-check produces 150 randomized exhausted-actor decisions and 150 invalid-energy adversarial inputs through genuine Yuka goal arbitration.

## Important exclusions
- The Mock Session is connected to the R1 Inbox through a **test-only middleware**. It does NOT exercise all of `InterludeService.receive()`, the real OneBot allowlist, live session transport or full TurnEngine ScriptCommit.
- In `stage-only` mode R1 intentionally suppresses downstream model generation and outgoing messages. A "no reply" assertion is not delivery proof.
- MSW requests exercise an isolated test URL; no HDSI model provider was intercepted. Neither actual network latency nor upstream delivery success is established.
- fast-check proves bounded generated test cases, not exhaustive freedom from race conditions.
- Node 22.15.0 is used in CI; MSW 3.0.3 requires Node >= 22.12.0. Runtime Node constraints must be checked before operational adoption.
- Candidate libraries are ephemeral test-runner installs with `--no-save`. They are **not** pinned as declared HDSI dependencies. The existing Zod tree dependency remains indirect; no Zod 4 migration has been done.
- The four original skipped tests are still skipped and have not been claimed as passing.
- No independent executor, 24-hour soak, live OneBot/Satori delivery, or production approval.

## Remaining work in recommended order
1. Build the real HDSI private/group Session -> authorized R1 transition -> TurnEngine -> ScriptCommit -> actual outbound dry-run receipt route, with full denial/duplicate regression.
2. Put the authoritative R1 Reality Gate before all outgoing execution paths and test early/streaming/delayed behavior.
3. Connect the trusted host activity/energy observation provider and Scheduler to the already-verified R2 Goal Ledger, without allowing the model to declare its own source authority.
4. Test real OneBot/Satori external transport, failure-after-send, restart/timeout ambiguity and multi-endpoint identity.
5. Pin production-appropriate runtime dependencies only after reviewed code changes and verification; run bounded soak and consider a separate release authorization.

Formal governance sources fresh-read: global 00 v1.6 / GP-001 v1.0, UPO Manifest R9 / UPO-00 v1.7 / Composition v1.2 / Verification v1.5, GLCG CURRENT_RUNTIME v0.2.0. No formal governance or Project Organ registry mutation.

Outcome: `BOUNDED_CONVERGED: REAL_TEST_DEPENDENCY_GRAFT_BUILD_VERIFIED` for the isolated tests only. Whole HDSI release remains `PARTIAL`.
