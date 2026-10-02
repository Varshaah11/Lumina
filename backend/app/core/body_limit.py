"""
Early request-body limit for the upload endpoint (pure ASGI middleware).

FastAPI/Starlette parse the whole multipart body (spooling it to a temp file) BEFORE a route handler runs, so a check
inside the route cannot stop a huge request from being consumed. This middleware rejects it earlier:
  * if Content-Length is declared and too big, it answers 413 without reading any body;
  * otherwise it counts bytes as they stream in and aborts once the limit is crossed.
The limit is the upload size limit plus a small allowance for multipart framing; exact file-size enforcement
(and the "File is too large" message for slightly-over files) happens in the route.
"""
import json
from app.core.config import settings

BODY_OVERHEAD_ALLOWANCE = 256 * 1024
LIMITED_PATH = "/upload"


class _BodyTooLarge(Exception):
    pass


class UploadBodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    @staticmethod
    def _limit_bytes() -> int:
        return int(settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024) + BODY_OVERHEAD_ALLOWANCE

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"].rstrip("/") != LIMITED_PATH:
            await self.app(scope, receive, send)
            return

        limit = self._limit_bytes()
        declared = None
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = None
                break

        if declared is not None and declared > limit:
            await self._send_413(send)
            return

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise _BodyTooLarge()
            return message

        async def guarded_send(message):
            # The framework wraps the aborted body read in its own 400; swap that for a 413
            nonlocal response_started
            if exceeded:
                if message["type"] == "http.response.start":
                    response_started = True
                    await self._send_413_start(send)
                elif message["type"] == "http.response.body":
                    await send({"type": "http.response.body", "body": self._body_bytes()})
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _BodyTooLarge:
            if not response_started:
                await self._send_413(send)

    @staticmethod
    def _body_bytes() -> bytes:
        return json.dumps({"detail": "File is too large"}).encode()

    async def _send_413_start(self, send):
        body = self._body_bytes()
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), (b"connection", b"close")],
        })

    async def _send_413(self, send):
        await self._send_413_start(send)
        await send({"type": "http.response.body", "body": self._body_bytes()})
