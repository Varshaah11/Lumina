import { useState, useRef, useEffect } from "react";
import { chatService } from "@/services/chat";
import { useRouter, useSearchParams } from "next/navigation";

export type Role = "user" | "assistant" | "error";

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: Date;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

export function useChat() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialChatId = searchParams?.get("chatId");

  const [chatId, setChatId] = useState<string | null>(initialChatId || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadedChatIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialChatId) {
      if (loadedChatIdRef.current === initialChatId) return; // Prevent re-fetching if we just created it

      setChatId(initialChatId);
      setIsLoading(true);
      loadedChatIdRef.current = initialChatId;
      
      chatService.getChatHistory(initialChatId)
        .then((data) => {
          if (data && data.messages) {
            setMessages(data.messages.map((m: any) => ({
              id: m.id.toString(),
              role: m.role,
              content: m.content,
              timestamp: new Date(m.created_at)
            })));
          }
        })
        .finally(() => setIsLoading(false));
    } else {
      setChatId(null);
      setMessages([]);
      loadedChatIdRef.current = null;
    }
  }, [initialChatId]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const sendMessage = async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: new Date(),
    };
    
    const botMsgId = crypto.randomUUID();
    const botMsg: Message = {
      id: botMsgId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    setIsLoading(true);

    abortControllerRef.current = chatService.streamMessage(
      content,
      chatId,
      (textChunk) => {
        setMessages((prev) => 
          prev.map((msg) => 
            msg.id === botMsgId 
              ? { ...msg, content: msg.content + textChunk } 
              : msg
          )
        );
      },
      (newChatId) => {
        if (!chatId) {
          setChatId(newChatId);
          loadedChatIdRef.current = newChatId;
          router.replace(`/chat?chatId=${newChatId}`, { scroll: false });
        }
      },
      (errorMsg) => {
        setMessages((prev) => {
          const newMessages = prev.filter(msg => !(msg.id === botMsgId && msg.content === ""));
          return [
            ...newMessages,
            {
              id: crypto.randomUUID(),
              role: "error",
              content: errorMsg,
              timestamp: new Date(),
            }
          ];
        });
        setIsLoading(false);
        abortControllerRef.current = null;
      },
      () => {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    );
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  };

  const clearChat = () => setMessages([]);

  return {
    messages,
    isLoading,
    sendMessage,
    stopGeneration,
    clearChat,
  };
}
