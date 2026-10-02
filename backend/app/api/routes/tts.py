import time
import logging
from fastapi import APIRouter, Depends, HTTPException, status, Response, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from app.schemas.user import UserResponse
from app.api.dependencies import get_current_user
from app.core.config import settings
from app.ai.tts import tts_service, TTSBusyError, TTSUnavailableError

logger = logging.getLogger(__name__)
router = APIRouter()

class TTSRequest(BaseModel):
    text: str

@router.post("", response_class=Response)
@router.post("/", response_class=Response)
async def generate_tts(
    request: TTSRequest,
    raw_request: Request,
    current_user: UserResponse = Depends(get_current_user)
):
    """
    Generate speech audio for text using local Kokoro TTS (voice from KOKORO_VOICE).
    Requires authentication.
    """
    start_time = time.perf_counter()

    # Validate input first: nothing below (availability check, worker pool, inference) runs for bad input
    if not request.text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text cannot be empty"
        )

    max_length = settings.KOKORO_MAX_TEXT_LENGTH
    if len(request.text) > max_length:
        logger.warning(f"[TTS Route] Rejected oversized input: {len(request.text)} chars (max {max_length})")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Text is too long (maximum {max_length} characters)"
        )

    if not tts_service.is_available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TTS is currently unavailable"
        )

    if await raw_request.is_disconnected():
        logger.warning("[TTS Route] Client disconnected before TTS generation started.")
        raise HTTPException(
            status_code=499,
            detail="Client disconnected before TTS generation"
        )

    # Client-facing messages are fixed strings; the real exception goes to the server log only
    try:
        wav_bytes = await run_in_threadpool(tts_service.generate_speech, request.text, voice=settings.KOKORO_VOICE)
        elapsed = time.perf_counter() - start_time
        logger.info(f"[TTS Route] Successfully generated {len(wav_bytes)} bytes WAV in {elapsed:.4f}s")
        return Response(content=wav_bytes, media_type="audio/wav")
    except ValueError as e:
        logger.warning(f"[TTS Route] Invalid TTS input: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text contains nothing that can be spoken"
        )
    except TTSBusyError as e:
        logger.warning(f"[TTS Route] {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TTS is busy, please retry shortly",
            headers={"Retry-After": "2"},
        )
    except TTSUnavailableError as e:
        logger.error(f"[TTS Route] TTS unavailable: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TTS is currently unavailable"
        )
    except Exception as e:
        logger.error(f"[TTS Route Error] {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Speech synthesis failed"
        )
