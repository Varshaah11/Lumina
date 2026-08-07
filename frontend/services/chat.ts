import { api } from "./api";
import { ChatSession } from "@/hooks/useChat";
import Cookies from "js-cookie";

export const chatService = {
  sendMessage: async (message: string): Promise<string> => {
    const data = await api<{ response: string }>("/chat/", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return data.response;
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
    onComplete: () => void
  ): AbortController => {
    const controller = new AbortController();
    
    const token = Cookies.get("token");
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    
    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    
    const payload: any = { message };
    if (chatId) {
      payload.chat_id = parseInt(chatId, 10);
    }

    fetch(`${API_BASE_URL}/chat/stream`, {
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
                onError(data.error);
                return;
              }
              if (data.chat_id) {
                onChatIdReceived(data.chat_id.toString());
              }
              if (data.token) {
                onChunk(data.token);
              }
            } catch (e) {
              // Ignore parse errors on partial chunks if any
            }
          }
        }
      }
      
      onComplete();
    }).catch((error) => {
      if (error.name === "AbortError") {
        onComplete();
      } else {
        onError(error.message);
      }
    });
    
    return controller;
  }
};
