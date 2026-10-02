from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import logging

logger = logging.getLogger(__name__)

async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    logger.error(f"HTTP error occurred: {exc.detail} - Status code: {exc.status_code}")
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )

def _safe_validation_errors(exc: RequestValidationError) -> list[dict]:
    """Field location + message only: never echo submitted values (passwords!) or validator internals."""
    safe = []
    for err in exc.errors():
        msg = str(err.get("msg", "Invalid value"))
        if msg.startswith("Value error, "):
            msg = msg[len("Value error, "):]
        safe.append({"loc": list(err.get("loc", [])), "msg": msg, "type": err.get("type", "value_error")})
    return safe

async def validation_exception_handler(request: Request, exc: RequestValidationError):
    safe_errors = _safe_validation_errors(exc)
    logger.error(f"Validation error on {request.method} {request.url.path}: {safe_errors}")
    return JSONResponse(
        status_code=422,
        content={"detail": safe_errors},
    )

async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )
