"""Production entrypoint. Starting it is a separately authorized phase-F action."""
from __future__ import annotations

import asyncio
import os
import stat
from pathlib import Path

from aiohttp import web

from hdsi_discord_sidecar import BridgeConfig, BridgeCore, EventJournal
from hdsi_discord_sidecar.discord_transport import DiscordUserTransport
from hdsi_discord_sidecar.server import create_app


def read_secret(name: str) -> str:
    path = Path(os.environ[f"{name}_FILE"])
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise PermissionError(f"{name}_FILE must not be accessible by group/other")
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise ValueError(f"{name}_FILE is empty")
    return value


async def main() -> None:
    role = os.environ["HDSI_DISCORD_ROLE_ACCOUNT_ID"]
    peer = os.environ["HDSI_DISCORD_ALLOWED_USER_ID"]
    bridge_token = read_secret("HDSI_BRIDGE_TOKEN")
    discord_token = read_secret("HDSI_DISCORD_TOKEN")
    port = int(os.environ.get("HDSI_BRIDGE_PORT", "5140"))
    bind = os.environ.get("HDSI_BRIDGE_BIND", "127.0.0.1")
    if bind not in {"127.0.0.1", "0.0.0.0"}:
        raise ValueError("HDSI_BRIDGE_BIND must be 127.0.0.1 or 0.0.0.0")
    state_dir = Path(os.environ.get("HDSI_SIDECAR_STATE_DIR", "/var/lib/hdsi-discord"))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    transport = DiscordUserTransport(role, peer)
    journal = EventJournal(state_dir / "inbound.sqlite3")
    core = BridgeCore(BridgeConfig(role, peer, bridge_token), transport, journal)
    transport.core = core
    runner = web.AppRunner(create_app(core), access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, bind, port)
    await site.start()
    try:
        await transport.start(discord_token, reconnect=True)
    finally:
        await transport.close()
        await runner.cleanup()
        journal.close()


if __name__ == "__main__":
    asyncio.run(main())

