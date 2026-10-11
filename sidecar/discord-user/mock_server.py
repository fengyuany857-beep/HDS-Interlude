"""Test-only Satori process. It cannot contact Discord."""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from aiohttp import web
from hdsi_discord_sidecar import BridgeConfig, BridgeCore, InboundMessage
from hdsi_discord_sidecar.server import create_app


class MockTransport:
    def __init__(self, peer_id: str, channel_id: str):
        self.peer_id, self.channel_id = peer_id, channel_id
        self.next_message = 500000000000000005

    async def resolve_dm(self, user_id: str) -> str:
        if user_id != self.peer_id:
            raise PermissionError("unknown peer")
        return self.channel_id

    async def send_dm(self, channel_id: str, content: str) -> str:
        if channel_id != self.channel_id:
            raise PermissionError("wrong DM")
        self.next_message += 1
        return str(self.next_message)


async def main() -> None:
    role, peer = os.environ["HDSI_TEST_ROLE_ID"], os.environ["HDSI_TEST_PEER_ID"]
    channel, token = os.environ["HDSI_TEST_CHANNEL_ID"], os.environ["HDSI_TEST_BRIDGE_TOKEN"]
    core = BridgeCore(BridgeConfig(role, peer, token), MockTransport(peer, channel))
    app = create_app(core)

    async def inject(request: web.Request) -> web.Response:
        body = await request.json()
        accepted = await core.accept_inbound(InboundMessage(
            role_account_id=str(body.get("role_account_id", "")),
            author_user_id=str(body.get("author_user_id", "")),
            dm_channel_id=str(body.get("dm_channel_id", "")),
            remote_message_id=str(body.get("remote_message_id", "")),
            content=str(body.get("content", "")), occurred_at=datetime.now(timezone.utc),
            is_direct=body.get("is_direct") is True,
            author_is_self=body.get("author_is_self") is True,
        ))
        return web.json_response({"accepted": accepted})

    app.router.add_post("/__test/inbound", inject)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    print(f"PORT={site._server.sockets[0].getsockname()[1]}", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
