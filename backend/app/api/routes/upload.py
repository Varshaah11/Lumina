import asyncio
import os
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.schemas.user import UserResponse
from app.api.dependencies import get_current_user, get_db
from app.services.rag_service import rag_service

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB limit
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}

class FileUploadResponse(BaseModel):
    id: int
    filename: str
    file_type: str
    extracted_text: str
    character_count: int
    chunk_count: int

def get_file_extension(filename: str) -> str:
    _, ext = os.path.splitext(filename or "")
    return ext.lower()

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
    Requires authentication. Max file size: 10 MB.
    """
    if not file or not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No file provided"
        )

    ext = get_file_extension(file.filename)
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type '{ext}'. Allowed types: PDF, DOCX, TXT, MD"
        )

    # Read bytes and validate size
    try:
        file_bytes = await file.read()
    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to read uploaded file"
        )

    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File size ({len(file_bytes) / (1024 * 1024):.2f} MB) exceeds maximum 10 MB limit"
        )

    # Process and store document using RAG service (extraction runs off-thread)
    try:
        # Offload CPU-heavy parsing and store in DB with embeddings
        doc = await asyncio.to_thread(
            # First extract and validate off-thread
            rag_service.extract_document_sync,
            file_bytes,
            file.filename
        )
        full_text, pages = doc
        if not full_text.strip():
            raise ValueError("Document appears to be empty or contains no readable text")

        stored_doc = await rag_service.process_and_store_document(
            file_bytes=file_bytes,
            filename=file.filename,
            user_id=current_user.id,
            chat_id=chat_id,
            db=db
        )

    except ValueError as e:
        logger.warning(f"Validation error processing document {file.filename}: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error processing document {file.filename}: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not extract or process document: {str(e)}"
        )

    return FileUploadResponse(
        id=stored_doc.id,
        filename=stored_doc.filename,
        file_type=stored_doc.file_type,
        extracted_text=full_text,
        character_count=len(full_text),
        chunk_count=len(stored_doc.chunks)
    )
