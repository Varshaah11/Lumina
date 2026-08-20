from fastapi import APIRouter, Depends, HTTPException, status, Response, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from app.schemas.user import UserResponse
from app.api.dependencies import get_current_user
from app.ai.tts import tts_service

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
    Generate speech audio for text using local Kokoro TTS (af_sarah).
    Requires authentication.
    """
    if not tts_service.is_loaded:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Kokoro TTS service is unavailable on the server"
        )

    if not request.text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text cannot be empty"
        )

    if await raw_request.is_disconnected():
        raise HTTPException(
            status_code=499,
            detail="Client disconnected before TTS generation"
        )

    try:
        wav_bytes = await run_in_threadpool(tts_service.generate_speech, request.text, voice="af_sarah")
        return Response(content=wav_bytes, media_type="audio/wav")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"TTS generation failed: {str(e)}"
        )
