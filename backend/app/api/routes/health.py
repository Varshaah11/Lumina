import asyncio
import logging
from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.ai.client import ollama_client
from app.ai.tts import tts_service
from app.core.config import settings
from app.database.database import engine

logger = logging.getLogger(__name__)
router = APIRouter()

# A health probe must answer quickly even when Ollama is down or hung
OLLAMA_CHECK_TIMEOUT_SECONDS = 2.0


@router.get("/")
def read_root():
    return {"message": "Welcome to Lumina AI Backend"}


def _check_database() -> bool:
    """Lightweight query on a fresh connection. Details stay in the log, never in the response."""
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception as e:
        logger.warning(f"[Health] database check failed: {type(e).__name__}: {e}")
        return False


def _installed_model_names(response) -> set[str]:
    raw_models = getattr(response, "models", None)
    if raw_models is None:
        raw_models = response.get("models", []) if isinstance(response, dict) else []
    names = set()
    for m in raw_models:
        name = getattr(m, "model", None) or (m.get("model") or m.get("name", "") if isinstance(m, dict) else "")
        if name:
            names.add(name)
    return names


async def _check_ollama() -> bool:
    """Ollama reachable (GET /api/tags, no generation) and at least one configured chat model installed."""
    try:
        response = await asyncio.wait_for(ollama_client.list_models(), timeout=OLLAMA_CHECK_TIMEOUT_SECONDS)
        installed = _installed_model_names(response)
        return bool(installed & {settings.OLLAMA_PRIMARY_MODEL, settings.OLLAMA_FALLBACK_MODEL})
    except Exception as e:
        logger.warning(f"[Health] Ollama check failed: {type(e).__name__}: {e}")
        return False


@router.get("/health")
async def check_health():
    """
    Dependency health. Never loads the TTS model and never asks Ollama to generate anything.

    status:
      "healthy"     database, Ollama (with a configured chat model) and TTS are all usable
      "degraded"    the database works but Ollama or TTS is unavailable: the app still serves requests (HTTP 200)
      "unavailable" the database cannot be reached: nothing works (HTTP 503)
    tts: "ready" (model loaded), "not_loaded" (model files present, loads on first use) or "unavailable".
    """
    database_ok, ollama_ok = await asyncio.gather(run_in_threadpool(_check_database), _check_ollama())
    tts_status = tts_service.status()

    if not database_ok:
        overall, http_status = "unavailable", 503
    elif ollama_ok and tts_status != "unavailable":
        overall, http_status = "healthy", 200
    else:
        overall, http_status = "degraded", 200

    return JSONResponse(
        status_code=http_status,
        content={
            "status": overall,
            "database": "healthy" if database_ok else "unhealthy",
            "ollama": "healthy" if ollama_ok else "unhealthy",
            "tts": tts_status,
        },
    )
