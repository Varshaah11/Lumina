import { api } from "./api";
import { ChatSession } from "@/hooks/useChat";
import Cookies from "js-cookie";

function handleSSEStream(
  url: string,
  payload: any,
  onChunk: (text: string) => void,
  onChatIdReceived: (id: string) => void,
  onError: (error: string) => void,
  onComplete: () => void
): AbortController {
  const controller = new AbortController();
  let hasCalledError = false;

  const token = Cookies.get("token");
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error("Failed to connect to chat stream.");
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error("No reader available");
    }

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            if (data.error) {
              hasCalledError = true;
              onError(data.error);
              return;
            }
            if (data.chat_id) {
              onChatIdReceived(data.chat_id.toString());
            }
            if ("token" in data) {
              onChunk(data.token);
            }
          } catch (e) {
            // Ignore parse errors on partial chunks if any
          }
        }
      }
    }

    if (!hasCalledError) {
      onComplete();
    }
  }).catch((error) => {
    if (hasCalledError) return;
    if (error.name === "AbortError") {
      onComplete();
    } else {
      hasCalledError = true;
      onError(error.message);
    }
  });

  return controller;
}

export interface UploadFileResponse {
  filename: string;
  file_type: string;
  extracted_text: string;
  character_count: number;
}

export const chatService = {
  sendMessage: async (message: string): Promise<string> => {
    const data = await api<{ response: string }>("/chat/", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return data.response;
  },

  uploadFile: async (file: File): Promise<UploadFileResponse> => {
    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const formData = new FormData();
    formData.append("file", file);

    const token = Cookies.get("token");
    const headers: HeadersInit = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(`${API_BASE_URL}/upload`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!res.ok) {
      let errorMsg = `Upload failed with status ${res.status}`;
      try {
        const errorData = await res.json();
        if (errorData.detail) errorMsg = errorData.detail;
      } catch {}
      throw new Error(errorMsg);
    }

    return await res.json();
  },

  getChats: async () => {
    return api<any[]>("/chat/", { method: "GET" });
  },

  getChatHistory: async (chatId: string) => {
    return api<any>(`/chat/${chatId}`, { method: "GET" });
  },

  streamMessage: (
    message: string,
    chatId: string | null,
    onChunk: (text: string) => void,
    onChatIdReceived: (id: string) => void,
    onError: (error: string) => void,
    onComplete: () => void,
    docContext?: string | null,
    isVoice?: boolean
  ): AbortController => {
    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const payload: any = { message };
    if (chatId) {
      payload.chat_id = parseInt(chatId, 10);
    }
    if (docContext) {
      payload.doc_context = docContext;
    }
    if (isVoice) {
      payload.is_voice = true;
    }
    return handleSSEStream(
      `${API_BASE_URL}/chat/stream`,
      payload,
      onChunk,
      onChatIdReceived,
      onError,
      onComplete
    );
  },

  regenerateMessage: (
    chatId: string,
    onChunk: (text: string) => void,
    onError: (error: string) => void,
    onComplete: () => void
  ): AbortController => {
    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    return handleSSEStream(
      `${API_BASE_URL}/chat/${chatId}/regenerate`,
      {},
      onChunk,
      () => {},
      onError,
      onComplete
    );
  },

  deleteChat: async (chatId: string | number): Promise<{ message: string; chat_id: number }> => {
    return api<{ message: string; chat_id: number }>(`/chat/${chatId}`, {
      method: "DELETE",
    });
  },

  renameChat: async (chatId: string | number, title: string): Promise<any> => {
    return api<any>(`/chat/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }
};
