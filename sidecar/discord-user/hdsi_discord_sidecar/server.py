from __future__ import annotations

import json
from aiohttp import WSMsgType, web

from .core import BridgeCore, PLATFORM


def create_app(core: BridgeCore) -> web.Application:
    app = web.Application(client_max_size=128 * 1024)

    @web.middleware
    async def authorize(request: web.Request, handler):
        if request.path == "/healthz":
            return await handler(request)
        if not core.config.authorizes(request.headers.get("Authorization")):
            raise web.HTTPUnauthorized(text="unauthorized")
        try:
            return await handler(request)
        except PermissionError as error:
            raise web.HTTPForbidden(text=str(error)) from error
        except (ValueError, json.JSONDecodeError) as error:
            raise web.HTTPBadRequest(text=str(error)) from error

    app.middlewares.append(authorize)

    async def events(request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=128 * 1024)
        await ws.prepare(request)

        async def emit(body: dict) -> None:
            if not ws.closed:
                await ws.send_json({"op": 0, "body": body})

        identified = False
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    frame = json.loads(message.data)
                except (TypeError, json.JSONDecodeError):
                    await ws.close(code=1008, message=b"invalid json")
                    break
                if frame.get("op") == 1:
                    await ws.send_json({"op": 2, "body": {}})
                elif frame.get("op") == 3:
                    body = frame.get("body") or {}
                    if body.get("token") != core.config.bridge_token:
                        await ws.close(code=1008, message=b"invalid identify token")
                        break
                    await ws.send_json({"op": 4, "body": {"logins": [core.login], "proxy_urls": []}})
                    if not identified:
                        identified = True
                        core.add_sink(emit)
                        await core.replay_to(emit)
                else:
                    await ws.close(code=1008, message=b"unsupported opcode")
                    break
        finally:
            if identified:
                core.remove_sink(emit)
        return ws

    async def private_channel(request: web.Request) -> web.Response:
        _headers(request, core)
        body = await request.json()
        return web.json_response(await core.create_private_channel(str(body.get("user_id", ""))))

    async def message_create(request: web.Request) -> web.Response:
        _headers(request, core)
        body = await request.json()
        return web.json_response(await core.send_message(
            str(body.get("channel_id", "")), str(body.get("content", "")),
        ))

    async def health(request: web.Request) -> web.Response:
        transport = core.transport
        ready = bool(getattr(transport, "is_ready", lambda: False)())
        user = getattr(transport, "user", None)
        if not ready or str(getattr(user, "id", "")) != core.config.role_account_id:
            raise web.HTTPServiceUnavailable(text="discord gateway not ready")
        return web.json_response({"status": "ready", "account_id": core.config.role_account_id})

    app.router.add_get("/v1/events", events)
    app.router.add_post("/v1/user.channel.create", private_channel)
    app.router.add_post("/v1/message.create", message_create)
    app.router.add_get("/healthz", health)
    return app


def _headers(request: web.Request, core: BridgeCore) -> None:
    if request.headers.get("Satori-Platform") != PLATFORM:
        raise web.HTTPForbidden(text="platform mismatch")
    if request.headers.get("Satori-User-ID") != core.config.role_account_id:
        raise web.HTTPForbidden(text="login mismatch")

