import io
import re
import os
import json
import hashlib
import logging
from typing import List, Dict, Any, Optional, Tuple
import numpy as np
import pypdf
import docx
from sqlalchemy.orm import Session

from app.models.document import Document, DocumentChunk
from app.ai.client import ollama_client
from app.core.config import settings

logger = logging.getLogger(__name__)

TARGET_CHUNK_CHARS = 1500  # Approx 375-500 tokens
OVERLAP_CHARS = 150        # Approx 40-50 tokens
MIN_CHUNK_CHARS = 60
TOP_K_DEFAULT = 4
SIMILARITY_THRESHOLD = 0.25

class RAGService:
    @staticmethod
    def compute_sha256(data: bytes) -> str:
        """Computes SHA-256 hash of file bytes for deduplication."""
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def extract_document_sync(file_bytes: bytes, filename: str) -> Tuple[str, List[Dict[str, Any]]]:
        """
        Synchronous document extraction (CPU-bound).
        MUST be called via asyncio.to_thread from async routes.
        Returns (full_text, pages_list) where each page item is {'page_number': int | None, 'text': str}.
        """
        _, ext = os.path.splitext(filename.lower())
        pages: List[Dict[str, Any]] = []

        if ext == ".pdf":
            reader = pypdf.PdfReader(io.BytesIO(file_bytes))
            for i, page in enumerate(reader.pages):
                page_text = page.extract_text() or ""
                cleaned = page_text.strip()
                if cleaned:
                    pages.append({"page_number": i + 1, "text": cleaned})

        elif ext == ".docx":
            doc = docx.Document(io.BytesIO(file_bytes))
            docx_elements: List[str] = []

            # Iterate through body elements to preserve paragraph and table order
            for child in doc.element.body:
                if child.tag.endswith('p'):
                    p = docx.text.paragraph.Paragraph(child, doc)
                    txt = p.text.strip()
                    if txt:
                        docx_elements.append(txt)
                elif child.tag.endswith('tbl'):
                    tbl = docx.table.Table(child, doc)
                    table_rows = []
                    for row in tbl.rows:
                        # Extract cell texts cleanly
                        cell_texts = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                        if any(cell_texts):
                            table_rows.append("| " + " | ".join(cell_texts) + " |")
                    if table_rows:
                        # Add markdown header separator after row 0 if multiple rows exist
                        if len(table_rows) > 1 and len(tbl.columns) > 0:
                            header_sep = "| " + " | ".join(["---"] * len(tbl.columns)) + " |"
                            table_rows.insert(1, header_sep)
                        docx_elements.append("\n".join(table_rows))

            full_docx_text = "\n\n".join(docx_elements).strip()
            if full_docx_text:
                # Word docs typically don't have static page markers; treat as single continuous flow
                pages.append({"page_number": None, "text": full_docx_text})

        elif ext in {".txt", ".md"}:
            try:
                raw_text = file_bytes.decode("utf-8")
            except UnicodeDecodeError:
                raw_text = file_bytes.decode("latin-1", errors="replace")
            cleaned = raw_text.strip()
            if cleaned:
                pages.append({"page_number": None, "text": cleaned})

        else:
            raise ValueError(f"Unsupported file format: {ext}")

        full_text = "\n\n".join(p["text"] for p in pages if p.get("text"))
        return full_text, pages

    @staticmethod
    def chunk_document(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Structure-aware chunking preserving paragraphs, sentences, and page boundaries.
        Returns a list of chunks: [{'page_number': int | None, 'text': str}].
        """
        chunks: List[Dict[str, Any]] = []

        for page in pages:
            page_num = page.get("page_number")
            page_text = page.get("text", "").strip()
            if not page_text:
                continue

            # If page text fits easily in one chunk, keep it intact
            if len(page_text) <= TARGET_CHUNK_CHARS:
                chunks.append({"page_number": page_num, "text": page_text})
                continue

            # Split page text into paragraphs first
            paragraphs = [p.strip() for p in re.split(r'\n\s*\n', page_text) if p.strip()]
            current_chunk = ""

            for p in paragraphs:
                # If paragraph itself is huge, split by sentences
                if len(p) > TARGET_CHUNK_CHARS:
                    sentences = re.split(r'(?<=[.?!])\s+', p)
                    for s in sentences:
                        s = s.strip()
                        if not s:
                            continue
                        if len(current_chunk) + len(s) + 1 <= TARGET_CHUNK_CHARS:
                            current_chunk = f"{current_chunk} {s}".strip()
                        else:
                            if len(current_chunk) >= MIN_CHUNK_CHARS:
                                chunks.append({"page_number": page_num, "text": current_chunk})
                                # Retain overlap
                                overlap = current_chunk[-OVERLAP_CHARS:] if len(current_chunk) > OVERLAP_CHARS else ""
                                current_chunk = f"{overlap} {s}".strip()
                            else:
                                current_chunk = s
                else:
                    if len(current_chunk) + len(p) + 2 <= TARGET_CHUNK_CHARS:
                        current_chunk = f"{current_chunk}\n\n{p}".strip() if current_chunk else p
                    else:
                        if len(current_chunk) >= MIN_CHUNK_CHARS:
                            chunks.append({"page_number": page_num, "text": current_chunk})
                            overlap = current_chunk[-OVERLAP_CHARS:] if len(current_chunk) > OVERLAP_CHARS else ""
                            current_chunk = f"{overlap}\n\n{p}".strip()
                        else:
                            current_chunk = p

            if current_chunk and len(current_chunk) >= MIN_CHUNK_CHARS:
                chunks.append({"page_number": page_num, "text": current_chunk})
            elif current_chunk and chunks:
                # Append remainder to previous chunk if very short
                chunks[-1]["text"] = f"{chunks[-1]['text']}\n\n{current_chunk}".strip()

        return chunks

    @staticmethod
    async def process_and_store_document(
        file_bytes: bytes,
        filename: str,
        user_id: int,
        chat_id: Optional[int],
        db: Session
    ) -> Document:
        """
        Extracts, hashes, chunks, embeds, and stores a document in SQLite.
        Detects duplicates per user to avoid re-extraction and re-embedding.
        """
        file_hash = RAGService.compute_sha256(file_bytes)
        _, ext = os.path.splitext(filename.lower())
        file_type = ext.lstrip(".")
        if file_type == "md":
            file_type = "markdown"

        # Check for existing document for this user with the same hash
        existing_doc = (
            db.query(Document)
            .filter(
                Document.user_id == user_id,
                Document.file_hash == file_hash
            )
            .first()
        )

        if existing_doc:
            logger.info(f"Duplicate document upload detected ({filename}, hash={file_hash[:8]}). Reusing existing chunks.")
            # If chat_id is provided and was not previously set, associate it with this chat
            if chat_id and not existing_doc.chat_id:
                existing_doc.chat_id = chat_id
                db.commit()
                db.refresh(existing_doc)
            return existing_doc

        # Extract document (CPU-bound, synchronous)
        full_text, pages = RAGService.extract_document_sync(file_bytes, filename)
        if not full_text.strip():
            raise ValueError("Document appears to be empty or contains no readable text")

        # Chunk document
        chunk_data = RAGService.chunk_document(pages)
        if not chunk_data:
            raise ValueError("No meaningful text chunks could be extracted from this document")

        # Create Document record
        doc = Document(
            user_id=user_id,
            chat_id=chat_id,
            filename=filename,
            file_type=file_type,
            file_hash=file_hash,
            char_count=len(full_text)
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)

        # Generate embeddings in batch via Ollama
        chunk_texts = [c["text"] for c in chunk_data]
        try:
            embeddings = await ollama_client.get_embeddings_batch(chunk_texts)
        except Exception as e:
            logger.error(f"Failed to generate embeddings for document {doc.id}: {e}")
            # Fallback: persist chunks with empty embeddings so retrieval can still fall back
            embeddings = [[] for _ in chunk_texts]

        # Insert DocumentChunk records
        for i, c in enumerate(chunk_data):
            emb = embeddings[i] if i < len(embeddings) else []
            chunk_record = DocumentChunk(
                document_id=doc.id,
                chunk_index=i,
                page_number=c.get("page_number"),
                content=c["text"],
                embedding_json=json.dumps(emb)
            )
            db.add(chunk_record)

        db.commit()
        db.refresh(doc)
        logger.info(f"Successfully processed and stored document ID={doc.id} ({filename}) with {len(chunk_data)} chunks.")
        return doc

    @staticmethod
    async def retrieve_relevant_chunks(
        query: str,
        user_id: int,
        chat_id: Optional[int] = None,
        document_id: Optional[int] = None,
        db: Session = None,
        top_k: int = TOP_K_DEFAULT
    ) -> List[Dict[str, Any]]:
        """
        Performs semantic similarity search against document chunks in SQLite using NumPy cosine similarity.
        Guarantees strict user isolation.
        """
        if not db:
            return []

        # Find target document(s) strictly belonging to this user
        doc_query = db.query(Document).filter(Document.user_id == user_id)
        if document_id:
            doc_query = doc_query.filter(Document.id == document_id)
        elif chat_id:
            doc_query = doc_query.filter(Document.chat_id == chat_id)
        else:
            return []

        docs = doc_query.all()
        if not docs:
            return []

        doc_ids = [d.id] if isinstance(docs, Document) else [d.id for d in docs]
        doc_map = {d.id: d for d in (docs if isinstance(docs, list) else [docs])}

        # Query all chunks for these documents
        chunks = (
            db.query(DocumentChunk)
            .filter(DocumentChunk.document_id.in_(doc_ids))
            .all()
        )
        if not chunks:
            return []

        # Generate query embedding
        try:
            query_vec = await ollama_client.get_embedding(query)
        except Exception as e:
            logger.warning(f"Could not generate query embedding: {e}. Falling back to first chunks.")
            return [
                {
                    "content": c.content,
                    "filename": doc_map[c.document_id].filename,
                    "page_number": c.page_number,
                    "chunk_index": c.chunk_index,
                    "similarity": 0.5
                }
                for c in chunks[:top_k]
            ]

        if not query_vec:
            return []

        # Extract chunk embeddings
        valid_chunks = []
        vectors = []
        for c in chunks:
            vec = c.embedding
            if vec and len(vec) == len(query_vec):
                valid_chunks.append(c)
                vectors.append(vec)

        if not vectors:
            # If embeddings weren't available, fall back to sequential top_k
            return [
                {
                    "content": c.content,
                    "filename": doc_map[c.document_id].filename,
                    "page_number": c.page_number,
                    "chunk_index": c.chunk_index,
                    "similarity": 0.5
                }
                for c in chunks[:top_k]
            ]

        # Vectorized cosine similarity with NumPy
        chunk_matrix = np.array(vectors, dtype=np.float32)
        q_vec = np.array(query_vec, dtype=np.float32)

        dot_products = np.dot(chunk_matrix, q_vec)
        matrix_norms = np.linalg.norm(chunk_matrix, axis=1)
        q_norm = np.linalg.norm(q_vec)

        denominators = matrix_norms * q_norm
        denominators[denominators == 0] = 1e-10
        similarities = dot_products / denominators

        # Sort indices by similarity descending
        sorted_indices = np.argsort(-similarities)

        results = []
        for idx in sorted_indices:
            sim = float(similarities[idx])
            # Strictly enforce similarity threshold: reject irrelevant chunks below 0.25
            if sim < SIMILARITY_THRESHOLD:
                break

            c = valid_chunks[idx]
            doc_obj = doc_map.get(c.document_id)
            results.append({
                "content": c.content,
                "filename": doc_obj.filename if doc_obj else "Document",
                "page_number": c.page_number,
                "chunk_index": c.chunk_index,
                "similarity": sim
            })

            if len(results) >= top_k:
                break

        return results

    @staticmethod
    def build_defensive_context(retrieved_chunks: List[Dict[str, Any]]) -> str:
        """
        Wraps retrieved chunks in defensive XML envelopes to prevent prompt injection.
        Includes clear source citations (page numbers and filename).
        """
        if not retrieved_chunks:
            return ""

        context_blocks = []
        for c in retrieved_chunks:
            page_attr = f' page="{c["page_number"]}"' if c.get("page_number") is not None else ""
            filename = c.get("filename", "Document")
            content = c.get("content", "").strip()
            block = f'<uploaded_document filename="{filename}"{page_attr}>\n{content}\n</uploaded_document>'
            context_blocks.append(block)

        return "\n\n".join(context_blocks)

rag_service = RAGService()
