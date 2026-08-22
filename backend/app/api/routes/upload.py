import io
import os
import logging
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from pydantic import BaseModel
from app.schemas.user import UserResponse
from app.api.dependencies import get_current_user
import pypdf
import docx

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB limit
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}

class FileUploadResponse(BaseModel):
    filename: str
    file_type: str
    extracted_text: str
    character_count: int

def get_file_extension(filename: str) -> str:
    _, ext = os.path.splitext(filename or "")
    return ext.lower()

@router.post("", response_model=FileUploadResponse)
@router.post("/", response_model=FileUploadResponse)
async def upload_file_endpoint(
    file: UploadFile = File(...),
    current_user: UserResponse = Depends(get_current_user)
):
    """
    Upload a document (PDF, DOCX, TXT, Markdown) and extract its text content.
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

    extracted_text = ""
    file_type = ext.lstrip(".")
    if file_type == "md":
        file_type = "markdown"

    try:
        if ext == ".pdf":
            reader = pypdf.PdfReader(io.BytesIO(file_bytes))
            page_texts = []
            for i, page in enumerate(reader.pages):
                text = page.extract_text()
                if text:
                    page_texts.append(text)
            extracted_text = "\n\n".join(page_texts)

        elif ext == ".docx":
            doc = docx.Document(io.BytesIO(file_bytes))
            paragraph_texts = [p.text for p in doc.paragraphs if p.text.strip()]
            extracted_text = "\n".join(paragraph_texts)

        elif ext in {".txt", ".md"}:
            try:
                extracted_text = file_bytes.decode("utf-8")
            except UnicodeDecodeError:
                extracted_text = file_bytes.decode("latin-1", errors="replace")

    except Exception as e:
        logger.error(f"Error extracting text from {file.filename}: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not extract text from document: {str(e)}"
        )

    extracted_text = extracted_text.strip()
    if not extracted_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Document appears to be empty or contains no readable text"
        )

    return FileUploadResponse(
        filename=file.filename,
        file_type=file_type,
        extracted_text=extracted_text,
        character_count=len(extracted_text)
    )
