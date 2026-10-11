# HDSI Discord user sidecar

This isolated process maps one Discord user account and one allowed DM peer to
Satori v1. It is not a Discord bot and Discord may terminate automated user
accounts. It contains no risk-control bypass behavior.

The production entrypoint binds only `127.0.0.1`. It requires decimal string
IDs in `HDSI_DISCORD_ROLE_ACCOUNT_ID` and `HDSI_DISCORD_ALLOWED_USER_ID`, plus
`HDSI_DISCORD_TOKEN_FILE` and `HDSI_BRIDGE_TOKEN_FILE`. Both secret files must
be owner-only (`0600`); tokens in environment variables are intentionally not
supported. `HDSI_BRIDGE_PORT` defaults to 5140.

Do not start `run.py` without fresh authorization for the exact Discord
accounts, VPS and real-message scope. `mock_server.py` is the credential-free
test transport used by CI.
