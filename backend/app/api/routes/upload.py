import logging
import asyncio
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.schemas.user import UserResponse
from app.api.dependencies import get_current_user, get_db
from app.services.rag_service import rag_service, DocumentContentError
from app.services import upload_validation as uv

logger = logging.getLogger(__name__)

router = APIRouter()

class FileUploadResponse(BaseModel):
    id: int
    filename: str
    file_type: str
    character_count: int
    chunk_count: int

@router.post("", response_model=FileUploadResponse)
@router.post("/", response_model=FileUploadResponse)
async def upload_file_endpoint(
    file: UploadFile = File(...),
    chat_id: Optional[int] = Form(None),
    current_user: UserResponse = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Upload a document (PDF, DOCX, TXT, Markdown), parse off-thread,
    chunk, generate embeddings, and persist in SQLite RAG store.
    Requires authentication. Size limit: MAX_UPLOAD_SIZE_MB.

    Everything up to process_and_store_document is cheap validation that runs before any extraction,
    chunking, embedding or database write. File name and Content-Type are hints only; the bytes must match the type.
    """
    try:
        filename = uv.sanitize_filename(file.filename)      # also strips any directory components
        ext = uv.get_extension(filename)
        data = await uv.read_upload_bounded(file, ext)      # size-capped read + signature check on the first chunk
        await asyncio.to_thread(uv.check_full_content, ext, data)
    except uv.UploadRejected as rejected:
        logger.warning(f"Upload rejected ({rejected.status_code}): {rejected.message} [name={file.filename!r}, content_type={file.content_type!r}]")
        raise HTTPException(status_code=rejected.status_code, detail=rejected.message)

    # Extraction/chunking runs once, off the event loop, inside the RAG service
    try:
        stored_doc = await rag_service.process_and_store_document(
            file_bytes=data,
            filename=filename,
            user_id=current_user.id,
            chat_id=chat_id,
            db=db
        )
    except DocumentContentError as e:
        logger.warning(f"Document {filename!r} could not be used: {e}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Error processing document {filename!r}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Document processing failed"
        )

    return FileUploadResponse(
        id=stored_doc.id,
        filename=stored_doc.filename,
        file_type=stored_doc.file_type,
        character_count=stored_doc.char_count,
        chunk_count=len(stored_doc.chunks)
    )
