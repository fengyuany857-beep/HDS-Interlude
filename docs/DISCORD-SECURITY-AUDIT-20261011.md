# Discord private runtime security audit

Scope: `sidecar/discord-user`, Discord endpoint additions, R1 approval/outbox
changes and CI/deployment artifacts at the candidate branch on 2026-10-11.

Evidence classification: source-backed manual audit plus automated dependency
audits. This is **not** a completed Codex Security scan artifact: the selected
security skill's mandatory `scan-prologue.md` resource was unavailable in this
environment, so its formal workflow could not truthfully be run or finalized.

## Boundaries reviewed

- Discord token entry, storage, logs and image history;
- local bridge authentication and bind address;
- role account, peer user and DM channel authorization;
- remote Message ID deduplication and disconnected event retention;
- signed action/payload/endpoint/TTL/delivery-kind authorization;
- ambiguous delivery and restart recovery;
- container user, capabilities, filesystem and persistent volume;
- repository credential patterns and runtime dependencies.

## Results

No validated high/critical issue was found in the scoped implementation.

- Secrets are read only from owner-only files. The production sidecar contains
  no token logging path; image history is checked for token-named inputs.
- Host exposure is limited to a loopback port mapping. Requests require a
  constant-time bearer comparison and Satori platform/login headers.
- Snowflakes remain decimal strings. Unknown users, guild messages, self
  messages, role mismatch and wrong DM channels fail closed.
- Inbound events commit to SQLite WAL with FULL synchronization before emit.
  Reconnect/restart replay retains stable sequence and remote Message IDs;
  capacity exhaustion stops admission rather than deleting unacknowledged data.
- Outbound authority binds Ed25519 principal/key, action, delivery lifecycle,
  exact payload, endpoint, source, commit/event and validity interval. UNKNOWN
  cannot return to an automatically claimable state.
- The container uses a digest-pinned base, hashed runtime/build locks, non-root
  UID 10001, read-only root, dropped capabilities and no-new-privileges.

Automated observations:

- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities;
- `pip-audit -r sidecar/discord-user/requirements.lock`: 0 known vulnerabilities;
- repository token-pattern scan: no credential-like value found;
- isolated Docker build/import and image metadata checks passed.

## Residual risks

- Discord user automation violates Discord policy and can terminate the role
  account. This project does not mitigate or bypass platform enforcement.
- Satori v1 has no durable consumer acknowledgement. The sidecar conservatively
  retains and replays events; R1 Inbox provides final deduplication. Operators
  must treat `SIDECAR_INBOUND_JOURNAL_FULL` as an emergency stop condition.
- Adapter acceptance is not recipient-visible delivery. Real phase-F evidence
  must inspect the receiving account and preserve UNKNOWN isolation.
- Four credentialed model-behavior tests remain skipped; they are unrelated to
  transport safety but still prevent a claim of full production behavior.
