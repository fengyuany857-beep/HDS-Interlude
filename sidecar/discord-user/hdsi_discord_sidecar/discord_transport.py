from __future__ import annotations

from datetime import timezone
from typing import TYPE_CHECKING

import discord

from .core import BridgeCore, InboundMessage

if TYPE_CHECKING:
    from discord import DMChannel, Message


class DiscordUserTransport(discord.Client):
    """discord.py-self transport; all policy decisions remain in BridgeCore."""

    def __init__(self, role_account_id: str, allowed_user_id: str):
        super().__init__(chunk_guilds_at_startup=False)
        self.role_account_id = role_account_id
        self.allowed_user_id = allowed_user_id
        self.core: BridgeCore | None = None

    async def on_ready(self) -> None:
        if str(self.user.id if self.user else "") != self.role_account_id:
            await self.close()
            raise RuntimeError("connected Discord account does not match configured role account")

    async def on_message(self, message: "Message") -> None:
        if self.core is None:
            return
        channel = message.channel
        is_direct = isinstance(channel, discord.DMChannel)
        await self.core.accept_inbound(InboundMessage(
            role_account_id=str(self.user.id if self.user else ""),
            author_user_id=str(message.author.id),
            dm_channel_id=str(channel.id),
            remote_message_id=str(message.id),
            content=message.content,
            occurred_at=message.created_at.astimezone(timezone.utc),
            is_direct=is_direct,
            author_is_self=bool(self.user and message.author.id == self.user.id),
        ))

    async def _dm(self) -> "DMChannel":
        user = self.get_user(int(self.allowed_user_id)) or await self.fetch_user(int(self.allowed_user_id))
        return user.dm_channel or await user.create_dm()

    async def resolve_dm(self, user_id: str) -> str:
        if user_id != self.allowed_user_id:
            raise PermissionError("target user is not allowed")
        return str((await self._dm()).id)

    async def send_dm(self, channel_id: str, content: str) -> str:
        dm = await self._dm()
        if str(dm.id) != channel_id:
            raise PermissionError("target channel is not the allowed peer DM")
        receipt = await dm.send(content)
        return str(receipt.id)

