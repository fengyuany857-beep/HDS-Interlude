import asyncio
import unittest
from datetime import datetime, timezone

from hdsi_discord_sidecar import BridgeConfig, BridgeCore, InboundMessage


ROLE = "100000000000000001"
PEER = "200000000000000002"
CHANNEL = "300000000000000003"
MESSAGE = "400000000000000004"
TOKEN = "local-bridge-token-32-characters-minimum"


class MockTransport:
    def __init__(self):
        self.sent = []

    async def resolve_dm(self, user_id):
        if user_id != PEER:
            raise PermissionError
        return CHANNEL

    async def send_dm(self, channel_id, content):
        self.sent.append((channel_id, content))
        return "500000000000000005"


class BridgeCoreTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = MockTransport()
        self.core = BridgeCore(BridgeConfig(ROLE, PEER, TOKEN), self.transport)

    async def test_inbound_preserves_snowflakes_and_rejects_wrong_scope(self):
        events = []

        async def sink(event):
            events.append(event)

        self.core.add_sink(sink)
        base = dict(role_account_id=ROLE, author_user_id=PEER, dm_channel_id=CHANNEL,
                    remote_message_id=MESSAGE, content="hello",
                    occurred_at=datetime(2026, 10, 11, tzinfo=timezone.utc))
        self.assertTrue(await self.core.accept_inbound(InboundMessage(**base)))
        self.assertEqual(events[0]["message"]["id"], MESSAGE)
        self.assertEqual(events[0]["channel"]["id"], CHANNEL)
        self.assertFalse(await self.core.accept_inbound(InboundMessage(**(base | {"is_direct": False}))))
        self.assertFalse(await self.core.accept_inbound(InboundMessage(**(base | {"author_is_self": True}))))
        self.assertFalse(await self.core.accept_inbound(InboundMessage(**(base | {"author_user_id": "600000000000000006"}))))
        self.assertEqual(len(events), 1)

    async def test_outbound_is_bound_to_peer_channel_and_exact_content(self):
        channel = await self.core.create_private_channel(PEER)
        self.assertEqual(channel, {"id": CHANNEL, "type": 1})
        with self.assertRaises(PermissionError):
            await self.core.create_private_channel("600000000000000006")
        with self.assertRaises(PermissionError):
            await self.core.send_message("700000000000000007", "no")
        receipt = await self.core.send_message(CHANNEL, "exact reviewed content")
        self.assertEqual(receipt[0]["id"], "500000000000000005")
        self.assertEqual(self.transport.sent, [(CHANNEL, "exact reviewed content")])

    async def test_config_and_auth_fail_closed(self):
        with self.assertRaises(ValueError):
            BridgeConfig("not-a-snowflake", PEER, TOKEN)
        with self.assertRaises(ValueError):
            BridgeConfig(ROLE, ROLE, TOKEN)
        with self.assertRaises(ValueError):
            BridgeConfig(ROLE, PEER, "short")
        self.assertTrue(self.core.config.authorizes(f"Bearer {TOKEN}"))
        self.assertFalse(self.core.config.authorizes(f"Bearer {TOKEN}x"))


if __name__ == "__main__":
    unittest.main()
