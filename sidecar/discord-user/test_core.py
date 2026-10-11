import asyncio
import unittest
import tempfile
from types import SimpleNamespace
from datetime import datetime, timezone
from aiohttp.test_utils import TestClient, TestServer

from hdsi_discord_sidecar import BridgeConfig, BridgeCore, EventJournal, InboundMessage
from hdsi_discord_sidecar.server import create_app


ROLE = "100000000000000001"
PEER = "200000000000000002"
CHANNEL = "300000000000000003"
MESSAGE = "400000000000000004"
TOKEN = "local-bridge-token-32-characters-minimum"


class MockTransport:
    def __init__(self):
        self.sent = []
        self.ready = False
        self.user = None

    def is_ready(self):
        return self.ready

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

    async def test_health_requires_ready_exact_discord_identity(self):
        client = TestClient(TestServer(create_app(self.core)))
        await client.start_server()
        try:
            self.assertEqual((await client.get('/healthz')).status, 503)
            self.transport.ready = True
            self.transport.user = SimpleNamespace(id=int(ROLE) + 1)
            self.assertEqual((await client.get('/healthz')).status, 503)
            self.transport.user = SimpleNamespace(id=int(ROLE))
            response = await client.get('/healthz')
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())['account_id'], ROLE)
        finally:
            await client.close()

    async def test_no_subscriber_replays_after_reconnect_and_restart_without_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/events.sqlite3"
            journal = EventJournal(path)
            core = BridgeCore(BridgeConfig(ROLE, PEER, TOKEN), self.transport, journal)
            event = InboundMessage(ROLE, PEER, CHANNEL, MESSAGE, "offline message",
                                   datetime(2026, 10, 11, tzinfo=timezone.utc))
            self.assertTrue(await core.accept_inbound(event))
            first = []
            await core.replay_to(lambda body: _capture(first, body))
            self.assertEqual([item["sn"] for item in first], [2])
            self.assertTrue(await core.accept_inbound(event))
            self.assertEqual(len(journal.events()), 1)
            journal.close()
            restored = EventJournal(path)
            second = []
            await BridgeCore(BridgeConfig(ROLE, PEER, TOKEN), self.transport, restored).replay_to(
                lambda body: _capture(second, body)
            )
            self.assertEqual(second, first)
            restored.close()

    async def test_long_reconnect_soak_keeps_monotonic_sequence_and_exactly_one_remote_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = f"{directory}/soak.sqlite3"
            journal = EventJournal(path, max_events=1200)
            core = BridgeCore(BridgeConfig(ROLE, PEER, TOKEN), self.transport, journal)
            for index in range(1000):
                message_id = str(500000000000000000 + index)
                message = InboundMessage(ROLE, PEER, CHANNEL, message_id, f"message-{index}",
                                         datetime(2026, 10, 11, tzinfo=timezone.utc))
                self.assertTrue(await core.accept_inbound(message))
                if index % 50 == 0:
                    replay = []
                    await core.replay_to(lambda body: _capture(replay, body))
                    self.assertEqual(len(replay), index + 1)
            rows = journal.events()
            self.assertEqual([row["sn"] for row in rows], list(range(2, 1002)))
            self.assertEqual(len({row["message"]["id"] for row in rows}), 1000)
            journal.close()
            restored = EventJournal(path, max_events=1200)
            self.assertEqual(restored.events(), rows)
            restored.close()


async def _capture(target, body):
    target.append(body)


if __name__ == "__main__":
    unittest.main()
