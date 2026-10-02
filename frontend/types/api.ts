/**
 * Shapes returned by the Lumina backend, mirrored from backend/app/schemas/chat.py
 * (MessageResponseDB, ChatResponseDB, ChatHistoryResponseDB, ChatRequest, RegenerateRequest)
 * and the SSE events emitted by backend/app/services/chat_service.py.
 * Dates are ISO-8601 strings on the wire.
 */

export interface ChatMessageDTO {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

/** GET /chat/ items, and the response of PATCH /chat/{id} (rename). */
export interface ChatSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

/** GET /chat/{id}: the chat plus its messages in chronological order. */
export interface ChatDetail extends ChatSummary {
  messages: ChatMessageDTO[];
}

/** Body of POST /chat/stream. (doc_context was removed: the backend reads document text itself.) */
export interface ChatStreamPayload {
  message: string;
  chat_id?: number;
  document_id?: number;
  is_voice?: boolean;
}

/** Body of POST /chat/{id}/regenerate. */
export interface RegenerateStreamPayload {
  is_voice: boolean;
}

/** One `data:` event on the chat SSE streams: exactly one of these keys is set per event. */
export interface ChatStreamEvent {
  chat_id?: number;
  token?: string;
  error?: string;
}

/** Error bodies produced by the backend: FastAPI `{detail: string | [{msg,...}]}` or a plain `{message}`. */
export interface ApiErrorBody {
  detail?: string | { msg?: string }[];
  message?: string;
}
