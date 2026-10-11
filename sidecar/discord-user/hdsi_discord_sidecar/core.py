from __future__ import annotations

import asyncio
import hmac
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Awaitable, Callable, Protocol

SNOWFLAKE = re.compile(r"^[1-9][0-9]{5,24}$")
PLATFORM = "discord-user"


def _snowflake(label: str, value: str) -> str:
    value = str(value).strip()
    if not SNOWFLAKE.fullmatch(value):
        raise ValueError(f"{label} must be a decimal Discord snowflake string")
    return value


@dataclass(frozen=True)
class BridgeConfig:
    role_account_id: str
    allowed_user_id: str
    bridge_token: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "role_account_id", _snowflake("role_account_id", self.role_account_id))
        object.__setattr__(self, "allowed_user_id", _snowflake("allowed_user_id", self.allowed_user_id))
        if self.role_account_id == self.allowed_user_id:
            raise ValueError("role account and allowed peer must be different")
        if len(self.bridge_token) < 32:
            raise ValueError("bridge_token must contain at least 32 characters")

    def authorizes(self, authorization: str | None) -> bool:
        expected = f"Bearer {self.bridge_token}"
        return bool(authorization) and hmac.compare_digest(authorization, expected)


@dataclass(frozen=True)
class InboundMessage:
    role_account_id: str
    author_user_id: str
    dm_channel_id: str
    remote_message_id: str
    content: str
    occurred_at: datetime
    is_direct: bool = True
    author_is_self: bool = False


class DiscordTransport(Protocol):
    async def resolve_dm(self, user_id: str) -> str: ...

    async def send_dm(self, channel_id: str, content: str) -> str: ...


EventSink = Callable[[dict], Awaitable[None]]


class BridgeCore:
    """Fail-closed identity gate and lossless Satori mapping.

    This class has no Discord import and no narrative behavior. R1 Inbox owns
    durable inbound deduplication; this layer preserves the remote message ID.
    """

    def __init__(self, config: BridgeConfig, transport: DiscordTransport):
        self.config = config
        self.transport = transport
        self._sinks: set[EventSink] = set()
        self._serial = 1
        self._lock = asyncio.Lock()

    @property
    def login(self) -> dict:
        return {
            "sn": 1,
            "platform": PLATFORM,
            "status": 1,
            "features": [],
            "user": {"id": self.config.role_account_id, "name": "Discord role account"},
        }

    def add_sink(self, sink: EventSink) -> None:
        self._sinks.add(sink)

    def remove_sink(self, sink: EventSink) -> None:
        self._sinks.discard(sink)

    async def accept_inbound(self, message: InboundMessage) -> bool:
        if not message.is_direct or message.author_is_self:
            return False
        if _snowflake("role_account_id", message.role_account_id) != self.config.role_account_id:
            return False
        if _snowflake("author_user_id", message.author_user_id) != self.config.allowed_user_id:
            return False
        channel_id = _snowflake("dm_channel_id", message.dm_channel_id)
        message_id = _snowflake("remote_message_id", message.remote_message_id)
        if not isinstance(message.content, str) or not message.content:
            return False
        async with self._lock:
            self._serial += 1
            event = {
                "sn": self._serial,
                "type": "message-created",
                "login": self.login,
                "self_id": self.config.role_account_id,
                "platform": PLATFORM,
                "timestamp": int(message.occurred_at.astimezone(timezone.utc).timestamp() * 1000),
                "user": {"id": self.config.allowed_user_id, "name": "Allowed Discord peer"},
                "channel": {"id": channel_id, "type": 1},
                "message": {
                    "id": message_id,
                    "content": message.content,
                    "timestamp": int(message.occurred_at.astimezone(timezone.utc).timestamp() * 1000),
                },
            }
            sinks = tuple(self._sinks)
        for sink in sinks:
            await sink(event)
        return True

    async def create_private_channel(self, user_id: str) -> dict:
        user_id = _snowflake("user_id", user_id)
        if user_id != self.config.allowed_user_id:
            raise PermissionError("target user is not allowed")
        channel_id = _snowflake("resolved dm channel", await self.transport.resolve_dm(user_id))
        return {"id": channel_id, "type": 1}

    async def send_message(self, channel_id: str, content: str) -> list[dict]:
        channel_id = _snowflake("channel_id", channel_id)
        expected = _snowflake("resolved dm channel", await self.transport.resolve_dm(self.config.allowed_user_id))
        if channel_id != expected:
            raise PermissionError("channel is not the allowed peer DM")
        if not isinstance(content, str) or not content:
            raise ValueError("content must be a non-empty string")
        remote_id = _snowflake("remote message id", await self.transport.send_dm(channel_id, content))
        return [{"id": remote_id, "content": content}]

