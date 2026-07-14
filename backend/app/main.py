from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.core.logging import setup_logging
from app.core.exceptions import (
    custom_http_exception_handler,
    validation_exception_handler,
    general_exception_handler
)
from app.database.init_db import init_db
from app.api.routes import auth, health

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

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Exception Handlers
app.add_exception_handler(StarletteHTTPException, custom_http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, general_exception_handler)

# Routers
app.include_router(health.router, tags=["Health"])
app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
