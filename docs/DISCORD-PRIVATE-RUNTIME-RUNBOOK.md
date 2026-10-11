# Discord private runtime runbook

Status: deployment design and local artifact verification only. None of these
commands have been run on a VPS or with a real Discord credential.

## Isolation and secrets

Use a new directory, Compose project and HDSI database. Do not reuse production
VCW/Gateway/Runner networks, ports or volumes. The sidecar binds its Satori
listener to host loopback only. Both secret source files must be `0600`; the
Discord token is never an environment value, build argument or image layer.

The Compose service is behind the explicit `phase-f-authorized` profile so a
plain `docker compose up` cannot start it. Starting it requires the separately
authorized phase-F command:

```sh
docker compose -f compose.private.yaml --profile phase-f-authorized up -d
```

## Persistent data

- `hdsi-discord-sidecar-state`: append-only inbound replay journal.
- separate HDSI/Koishi volume: story, participant, R1 Inbox, ScriptCommit,
  Authorized Outbox and receipts. It must not be shared with QQ production.

Back up each SQLite file with `backup.py SOURCE DESTINATION`; it uses SQLite's
online backup API and verifies the copy. Store backups outside both runtime
volumes with mode `0600`. Restore only while both Koishi and sidecar are stopped:

1. preserve the current volumes as rollback snapshots;
2. run `PRAGMA integrity_check` on the selected backup;
3. restore into newly created empty volumes, never over a running database;
4. start sidecar and Koishi without enabling dispatch, inspect Inbox/Outbox;
5. enable dispatch only after UNKNOWN rows have been reviewed manually.

## Emergency stop and rollback

Emergency stop is `docker compose -f compose.private.yaml stop
discord-user-sidecar`, followed by stopping the isolated Koishi service. Do not
restart automatically after an account lock, invalid session, unexpected peer,
journal-full condition, or repeated rate-limit condition.

Rollback uses the previous image digest and the pre-upgrade database snapshots.
Never downgrade a live database in place. UNKNOWN Outbox rows survive rollback
and must not be reset to authorized or retried blindly.

## Phase-F evidence required

Record exact image digest, dependency-lock checksum, container inspection,
loopback bind, volume names, database integrity, connected role account ID,
allowed peer ID, received Discord message IDs, adapter receipt IDs, restart and
delayed/proactive observations. Redact tokens completely. API acceptance is not
recipient-visible delivery proof.
