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
  const currentChatIdRef = useRef<string | null>(initialChatId || null);

  // Sync ref with current chatId state
  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  useEffect(() => {
    console.log("[useChat] useEffect(initialChatId) triggered", { initialChatId, loadedChatId: loadedChatIdRef.current, isLoading });
    if (isLoading) {
      console.log("[useChat] Skipping useEffect(initialChatId) because stream is currently active (isLoading = true)");
      return;
    }

    if (initialChatId) {
      if (loadedChatIdRef.current === initialChatId) {
        console.log("[useChat] Skipping getChatHistory because loadedChatIdRef matches initialChatId:", initialChatId);
        return;
      }

      // Abort any ongoing stream when switching to a different chat
      if (abortControllerRef.current) {
        console.log("[useChat] Aborting ongoing stream due to initialChatId change");
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      setChatId(initialChatId);
      setIsLoading(true);
      loadedChatIdRef.current = initialChatId;
      currentChatIdRef.current = initialChatId;

      console.log("[useChat] Calling chatService.getChatHistory for chatId:", initialChatId);
      chatService.getChatHistory(initialChatId)
        .then((data) => {
          console.log("[useChat][setMessages] Source: history load (getChatHistory resolved)", data?.messages?.length || 0, "messages");
          if (data && data.messages) {
            setMessages(data.messages.map((m: any) => ({
              id: m.id.toString(),
              role: m.role,
              content: m.content,
              timestamp: new Date(m.created_at)
            })));
          } else {
            setMessages([]);
          }
        })
        .catch((err) => {
          console.error("[useChat] getChatHistory failed:", err);
          setMessages([]);
        })
        .finally(() => setIsLoading(false));
    } else {
      if (loadedChatIdRef.current === null && chatId === null) return;
      if (isLoading && currentChatIdRef.current) return; // Protect active new chat stream from being wiped

      if (abortControllerRef.current) {
        console.log("[useChat] Aborting stream on reset to new chat");
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      console.log("[useChat][setMessages] Source: reset to new chat");
      setChatId(null);
      setMessages([]);
      setIsLoading(false);
      loadedChatIdRef.current = null;
      currentChatIdRef.current = null;
    }
  }, [initialChatId, isLoading]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const sendMessage = async (content: string) => {
    console.log("[useChat] sendMessage() called with content:", content);
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

    console.log("[useChat][setMessages] Source: sendMessage (add userMsg & botMsg placeholder)");
    setMessages((prev) => [...prev, userMsg, botMsg]);
    setIsLoading(true);

    const activeChatId = currentChatIdRef.current;

    abortControllerRef.current = chatService.streamMessage(
      content,
      activeChatId,
      (textChunk) => {
        console.log(
          "[onChunk]",
          JSON.stringify(textChunk),
          "botMsgId:",
          botMsgId
        );

        setMessages((prev) => {
          console.log(
            "[setMessages before]",
            prev.map(m => ({
              id: m.id,
              role: m.role,
              content: m.content
            }))
          );

          return prev.map((msg) =>
            msg.id === botMsgId
              ? {
                ...msg,
                content: msg.content + textChunk,
              }
              : msg
          );
        });
      },
      (newChatId) => {
        console.log("[useChat] onChatIdReceived() received newChatId:", newChatId, "activeChatId was:", activeChatId);
        if (!activeChatId) {
          setChatId(newChatId);
          loadedChatIdRef.current = newChatId;
          currentChatIdRef.current = newChatId;
        }
      },
      (errorMsg) => {
        console.log("[useChat] onError() called with errorMsg:", errorMsg);
        console.log("[useChat][setMessages] Source: error");
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
        if (currentChatIdRef.current && !initialChatId) {
          window.history.replaceState(null, "", `/chat?chatId=${currentChatIdRef.current}`);
          window.dispatchEvent(new Event("chat-created"));
        }
      },
      () => {
        console.log("[useChat] onComplete() streaming finished successfully");
        setIsLoading(false);
        abortControllerRef.current = null;
        if (currentChatIdRef.current && !initialChatId) {
          window.history.replaceState(null, "", `/chat?chatId=${currentChatIdRef.current}`);
          window.dispatchEvent(new Event("chat-created"));
        }
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
