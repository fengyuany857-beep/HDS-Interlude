# Discord user-account bridge decision

Observed: 2026-10-11 UTC  
Target: Ubuntu 24.04, Python 3.12 sidecar, Node 22 / Koishi 4 host  
Release target: `PRIVATE_DEPLOYED_VERIFIED` (not a public package release)

## Boundary

Discord explicitly prohibits automating normal user accounts. This project does
not claim otherwise and does not include risk-control bypasses. The bridge is
restricted to one independently provisioned role account, one explicitly
allowed peer user ID, and direct-message channels. Guild/server traffic,
unknown peers, self-authored messages and non-text payloads fail closed.

No real Discord credential, login, message or VPS action was used for this
decision. Real connectivity and recipient verification remain a separately
authorized phase-F activity.

## Reused components

The selected path is deliberately thin:

```text
discord.py-self 2.1.0
  -> isolated Python Satori-v1 sidecar on loopback
  -> @koishijs/plugin-adapter-satori 1.5.1
  -> real Koishi Session/Bot contract
  -> existing HDSI R1 Inbox / ScriptCommit / authorized Outbox
```

It does not introduce another personality, memory, story, scheduler or delivery
authority. The official Koishi Satori adapter already has a passing real-wire
loopback test in this branch and is the compatibility seam. Directly enabling
Satori Discord `type: user` was rejected as the main path because its gateway
startup uses bot-only gateway behavior; a configuration field alone is not
evidence of a working user-account connection.

## Dependency/API observation

The following was queried and installed from the public project/package on
2026-10-11:

- project: `dolfies/discord.py-self`, default branch `master`, not archived;
- observed master: `2ba64a9a997e151a9c259984e0a179b1fdf4aff4`;
- selected release/PyPI version: `2.1.0`, published 2026-01-18;
- license: MIT; declared Python: `>=3.10`, classifiers through Python 3.14;
- observed package interfaces after an isolated install:
  - `Client.start(token, reconnect=True)` and `Client.close()`;
  - `User.create_dm() -> DMChannel`;
  - `DMChannel.send(...) -> Message`;
  - `HTTPException` and `RateLimited` are separately exposed.

Version `2.1.0` is the initial compatibility pin. A fully hashed transitive
lock belongs to the deployment artifact and must be regenerated and verified
before phase F; floating `master` is not a deployable dependency.

## Bridge contract

The sidecar speaks only Satori v1 operations needed by the already-pinned
Koishi adapter:

- WebSocket `/v1/events`: IDENTIFY/READY and `message-created` events;
- HTTP `/v1/user.channel.create`: resolve the one allowed peer's DM;
- HTTP `/v1/message.create`: deliver exact reviewed content to that DM.

Every request requires a separate local bridge bearer secret. Discord tokens
never cross the sidecar boundary. Snowflakes are decimal strings throughout;
JavaScript number conversion is forbidden.

Inbound acceptance binds all of:

- configured role account ID equals the connected Discord account;
- author ID equals the configured peer allowlist entry;
- channel is a direct-message channel whose recipient mapping is that peer;
- author is not the role account;
- remote message ID is retained unchanged for R1 durable deduplication.

Outbound acceptance binds all of:

- Satori platform and login/self ID equal the configured role account;
- target user and resolved DM channel equal the configured peer;
- content comes through the existing authorized R1 Outbox path;
- an adapter timeout/disconnect after write becomes `UNKNOWN`, never an
  automatic replay.

## Evidence levels and remaining work

This decision completes phase A at `STATIC_API_VERIFIED`: upstream status,
license, package install and callable signatures were directly checked. It is
not Discord connectivity evidence. Phase B must implement the isolated server
and Mock E2E. Phases C-E must prove HDSI story/participant persistence,
authorized replies, delayed/proactive paths, failures and regressions without
real credentials. Phase F alone may produce `PRIVATE_DEPLOYED_VERIFIED`, after
fresh authorization for the exact accounts, VPS and message scope.

