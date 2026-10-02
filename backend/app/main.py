from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.core.body_limit import UploadBodyLimitMiddleware
from app.core.cors import add_cors
from app.core.logging import setup_logging
from app.core.exceptions import (
    custom_http_exception_handler,
    validation_exception_handler,
    general_exception_handler
)
from app.database.init_db import init_db
from app.api.routes import auth, health, chat, tts, upload

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    setup_logging()
    init_db()
    yield
    # Shutdown
    pass

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="Backend API for Lumina AI",
    version="1.0.0",
    lifespan=lifespan
)

# Early request-size limit for /upload. Added BEFORE CORS so CORS stays the outermost layer
# and 413 responses still carry the CORS headers.
app.add_middleware(UploadBodyLimitMiddleware)

# CORS
add_cors(app, settings.cors_origins)

# Exception Handlers
app.add_exception_handler(StarletteHTTPException, custom_http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, general_exception_handler)

# Routers
app.include_router(health.router, tags=["Health"])
app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
app.include_router(chat.router, prefix="/chat", tags=["Chat"])
app.include_router(tts.router, prefix="/tts", tags=["TTS"])
app.include_router(upload.router, prefix="/upload", tags=["Upload"])
