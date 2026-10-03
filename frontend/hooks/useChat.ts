import { useState, useRef, useEffect } from "react";
import { chatService } from "@/services/chat";
import { getErrorMessage, isAbortError } from "@/lib/errors";
import { useSearchParams } from "next/navigation";

export type Role = "user" | "assistant" | "error";

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: Date;
  isVoice?: boolean;
}

interface FailedRequest {
  type: "send" | "regenerate";
  content?: string;
  file?: File | null;
  documentId?: number | null;
  userVisibleContent?: string;
  isVoice?: boolean;
  messageId?: string;
}

function newErrorMessage(content: string): Message {
  return { id: crypto.randomUUID(), role: "error", content, timestamp: new Date() };
}

/** An empty assistant message that streamed tokens are appended to. `extra` carries optional fields such as isVoice. */
function newAssistantPlaceholder(extra: { isVoice?: boolean } = {}): Message {
  return { id: crypto.randomUUID(), role: "assistant", content: "", timestamp: new Date(), ...extra };
}

/** Appends streamed text to one message. */
function appendToMessage(messages: Message[], messageId: string, text: string): Message[] {
  return messages.map((msg) => (msg.id === messageId ? { ...msg, content: msg.content + text } : msg));
}

/**
 * Applies a stream error: an assistant placeholder that never received text is dropped (a partial reply is kept) and an
 * error bubble is appended. With `skipDuplicate`, an error identical to the last message is not added twice.
 */
function appendStreamError(messages: Message[], placeholderId: string, errorMsg: string, skipDuplicate: boolean): Message[] {
  if (skipDuplicate) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "error" && lastMsg.content === errorMsg) {
      return messages;
    }
  }
  const remaining = messages.filter((msg) => !(msg.id === placeholderId && msg.content === ""));
  return [...remaining, newErrorMessage(errorMsg)];
}

// The AI title is generated in the background after the stream closes, so refresh the sidebar list shortly after.
function refreshChatListAfterTitle() {
  [5000, 15000].forEach((delay) =>
    setTimeout(() => window.dispatchEvent(new Event("chats-updated")), delay)
  );
}

export function useChat() {
  const searchParams = useSearchParams();
  const initialChatId = searchParams?.get("chatId");

  const [chatId, setChatId] = useState<string | null>(initialChatId || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const loadedChatIdRef = useRef<string | null>(null);
  const currentChatIdRef = useRef<string | null>(initialChatId || null);
  const wasStreamingNewChatRef = useRef<boolean>(false);
  const lastFailedRequestRef = useRef<FailedRequest | null>(null);

  // Sync ref with current chatId state
  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  useEffect(() => {
    if (isLoading) {
      if (isUploadingRef.current && initialChatId !== loadedChatIdRef.current) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        isUploadingRef.current = false;
        setIsUploading(false);
        setIsLoading(false);
      } else {
        return;
      }
    }

    if (initialChatId) {
      if (loadedChatIdRef.current === initialChatId) {
        return;
      }

      // Abort any ongoing stream when switching to a different chat
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      setChatId(initialChatId);
      setIsLoading(true);
      loadedChatIdRef.current = initialChatId;
      currentChatIdRef.current = initialChatId;

      chatService.getChatHistory(initialChatId)
        .then((data) => {
          if (data && data.messages) {
            setMessages(data.messages.map((m) => ({
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
          console.warn("[useChat] getChatHistory failed:", err);
          setMessages([]);
        })
        .finally(() => setIsLoading(false));
    } else {
      if (loadedChatIdRef.current === null && chatId === null && currentChatIdRef.current === null) {
        setMessages((prev) => (prev.length > 0 ? [] : prev));
        lastFailedRequestRef.current = null;
        return;
      }
      if (isLoading && currentChatIdRef.current && wasStreamingNewChatRef.current) return; // Protect active new chat stream from being wiped
      if (wasStreamingNewChatRef.current) {
        wasStreamingNewChatRef.current = false;
        return;
      }

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      setChatId(null);
      setMessages([]);
      setIsLoading(false);
      loadedChatIdRef.current = null;
      currentChatIdRef.current = null;
      lastFailedRequestRef.current = null;
      wasStreamingNewChatRef.current = false;
    }
  }, [initialChatId, isLoading]);

  useEffect(() => {
    const handleNewChat = () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      isUploadingRef.current = false;
      setIsUploading(false);
      setChatId(null);
      setMessages([]);
      setIsLoading(false);
      loadedChatIdRef.current = null;
      currentChatIdRef.current = null;
      lastFailedRequestRef.current = null;
      wasStreamingNewChatRef.current = false;
    };

    window.addEventListener("new-chat", handleNewChat);
    return () => {
      window.removeEventListener("new-chat", handleNewChat);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  /**
   * Streams the assistant reply for `content` into the placeholder message `botMsgId` (already added by the caller).
   * Shared by sendMessage and the retry path; the only differences are controlled by `isInitialSend`:
   *   - initial send logs stream errors, de-duplicates identical consecutive error bubbles and, for a brand-new chat,
   *     rewrites the URL / notifies the sidebar even when the stream fails;
   *   - a retry does none of those on error (completion handling is identical for both).
   */
  const startAssistantStream = ({
    content,
    documentId,
    isVoice,
    botMsgId,
    isInitialSend,
  }: {
    content: string;
    documentId?: number | null;
    isVoice?: boolean;
    botMsgId: string;
    isInitialSend: boolean;
  }) => {
    setIsLoading(true);

    const activeChatId = currentChatIdRef.current;
    if (!activeChatId) {
      wasStreamingNewChatRef.current = true;
    }

    // A brand-new chat (no chatId in the URL yet) gets its URL rewritten and the sidebar notified
    const publishNewChat = () => {
      if (currentChatIdRef.current && !initialChatId) {
        window.history.replaceState(null, "", `/chat?chatId=${currentChatIdRef.current}`);
        window.dispatchEvent(new Event("chat-created"));
        return true;
      }
      return false;
    };

    abortControllerRef.current = chatService.streamMessage(
      content,
      activeChatId,
      (textChunk) => {
        setMessages((prev) => appendToMessage(prev, botMsgId, textChunk));
      },
      (newChatId) => {
        if (!activeChatId) {
          setChatId(newChatId);
          loadedChatIdRef.current = newChatId;
          currentChatIdRef.current = newChatId;
        }
      },
      (errorMsg) => {
        if (isInitialSend) {
          console.warn("[useChat] streamMessage error:", errorMsg);
        }
        setMessages((prev) => appendStreamError(prev, botMsgId, errorMsg, isInitialSend));
        setIsLoading(false);
        abortControllerRef.current = null;
        if (isInitialSend) {
          publishNewChat();
        }
      },
      () => {
        setIsLoading(false);
        lastFailedRequestRef.current = null;
        abortControllerRef.current = null;
        if (publishNewChat()) {
          refreshChatListAfterTitle();
        }
      },
      isVoice,
      documentId
    );
  };

  const sendMessage = async (content: string, file?: File | null, isVoice: boolean = false) => {
    if ((!content.trim() && !file) || isLoading) return;

    const userPromptText = content.trim();
    let uploadedDocId: number | null = null;
    let userVisibleContent = userPromptText;

    // Track request details for retry support
    lastFailedRequestRef.current = {
      type: "send",
      content: userPromptText,
      file: file || null,
      isVoice,
    };

    if (file) {
      setIsLoading(true);
      setIsUploading(true);
      isUploadingRef.current = true;

      const uploadController = new AbortController();
      abortControllerRef.current = uploadController;
      const targetChatId = currentChatIdRef.current;

      try {
        const uploadResult = await chatService.uploadFile(file, uploadController.signal, targetChatId);
        uploadedDocId = uploadResult.id || null;

        // Discard result if upload was aborted or if user switched chats / started new chat during upload
        if (
          uploadController.signal.aborted ||
          currentChatIdRef.current !== targetChatId
        ) {
          if (abortControllerRef.current === uploadController) {
            abortControllerRef.current = null;
          }
          setIsLoading(false);
          setIsUploading(false);
          isUploadingRef.current = false;
          return;
        }

        const promptPart = userPromptText || "Please analyze and summarize the contents of this document.";
        userVisibleContent = `📄 ${uploadResult.filename}\n\n${promptPart}`;

        if (lastFailedRequestRef.current) {
          lastFailedRequestRef.current.documentId = uploadedDocId;
          // The upload succeeded, so a retry only re-streams with documentId; stop holding the (up to 10 MB) File
          lastFailedRequestRef.current.file = null;
          lastFailedRequestRef.current.userVisibleContent = userVisibleContent;
        }
      } catch (err) {
        // Handle AbortError or discarded chat switch silently without creating an error bubble
        if (
          isAbortError(err) ||
          uploadController.signal.aborted ||
          currentChatIdRef.current !== targetChatId
        ) {
          if (abortControllerRef.current === uploadController) {
            abortControllerRef.current = null;
          }
          setIsLoading(false);
          setIsUploading(false);
          isUploadingRef.current = false;
          return;
        }

        console.warn("[useChat] File upload failed:", err);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "error",
            content: getErrorMessage(err, "Failed to process attached document."),
            timestamp: new Date(),
          },
        ]);
        setIsLoading(false);
        if (abortControllerRef.current === uploadController) {
          abortControllerRef.current = null;
        }
        return;
      } finally {
        setIsUploading(false);
        isUploadingRef.current = false;
      }
    } else {
      if (lastFailedRequestRef.current) {
        lastFailedRequestRef.current.userVisibleContent = userVisibleContent;
      }
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userVisibleContent,
      timestamp: new Date(),
      isVoice,
    };

    const botMsg = newAssistantPlaceholder({ isVoice });

    setMessages((prev) => [...prev, userMsg, botMsg]);

    startAssistantStream({
      content: userVisibleContent,
      documentId: uploadedDocId,
      isVoice,
      botMsgId: botMsg.id,
      isInitialSend: true,
    });
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
      setIsUploading(false);
      isUploadingRef.current = false;
      lastFailedRequestRef.current = null;
    }
  };

  const regenerateResponse = (messageId: string, isVoiceParam?: boolean) => {
    if (isLoading) return;

    const activeChatId = currentChatIdRef.current;
    if (!activeChatId) return;

    const targetIndex = messages.findIndex((m) => m.id === messageId);
    const targetMsg = targetIndex !== -1 ? messages[targetIndex] : undefined;
    if (!targetMsg || targetMsg.role !== "assistant") return;

    const oldContent = targetMsg.content;
    const botMsgId = messageId;

    const precedingUserMsg = targetIndex > 0 ? messages[targetIndex - 1] : undefined;
    const isVoice = typeof isVoiceParam === "boolean"
      ? isVoiceParam
      : Boolean(targetMsg.isVoice ?? precedingUserMsg?.isVoice ?? false);

    lastFailedRequestRef.current = {
      type: "regenerate",
      messageId,
      isVoice,
    };

    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, content: "", isVoice }
          : msg
      )
    );
    setIsLoading(true);

    abortControllerRef.current = chatService.regenerateMessage(
      activeChatId,
      (textChunk) => {
        setMessages((prev) => appendToMessage(prev, botMsgId, textChunk));
      },
      (errorMsg) => {
        console.warn("[useChat] regenerate error:", errorMsg);
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === "error" && lastMsg.content === errorMsg) {
            return prev;
          }

          const updatedMessages = prev.map((msg) => {
            if (msg.id === botMsgId && msg.content === "") {
              return { ...msg, content: oldContent };
            }
            return msg;
          });

          return [...updatedMessages, newErrorMessage(errorMsg)];
        });
        setIsLoading(false);
        abortControllerRef.current = null;
      },
      () => {
        setIsLoading(false);
        lastFailedRequestRef.current = null;
        abortControllerRef.current = null;
      },
      isVoice
    );
  };

  const retryLastMessage = async () => {
    if (isLoading) return;

    let lastErrorIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "error") {
        lastErrorIndex = i;
        break;
      }
    }
    if (lastErrorIndex === -1) return;

    const errorMsgId = messages[lastErrorIndex].id;
    const failedReq = lastFailedRequestRef.current;

    // Remove the error message from state
    setMessages((prev) => prev.filter((m) => m.id !== errorMsgId));

    if (failedReq?.type === "regenerate" && failedReq.messageId) {
      regenerateResponse(failedReq.messageId, failedReq.isVoice);
      return;
    }

    if (failedReq?.type === "send") {
      const { content = "", file, documentId, userVisibleContent, isVoice } = failedReq;

      // If a file was attached, but failed before upload/extraction completed, re-run full send
      if (file && !documentId) {
        sendMessage(content, file, isVoice);
        return;
      }

      const effectiveContent = userVisibleContent || content;
      const precedingUserMsg = messages
        .slice(0, lastErrorIndex)
        .reverse()
        .find((m) => m.role === "user");

      if (precedingUserMsg) {
        // The user message is already in the chat list; replace the error with a fresh assistant placeholder and re-stream
        const botMsg = newAssistantPlaceholder();

        setMessages((prev) => [...prev.filter((m) => m.id !== errorMsgId), botMsg]);

        startAssistantStream({
          content: effectiveContent,
          documentId,
          isVoice,
          botMsgId: botMsg.id,
          isInitialSend: false,
        });
        return;
      }

      sendMessage(content, file, isVoice);
      return;
    }

    // Fallback if failedReq was cleared: find preceding user prompt
    const precedingUserMsg = messages
      .slice(0, lastErrorIndex)
      .reverse()
      .find((m) => m.role === "user");

    if (precedingUserMsg) {
      sendMessage(precedingUserMsg.content);
    }
  };

  const clearChat = () => setMessages([]);

  return {
    messages,
    isLoading,
    isUploading,
    sendMessage,
    stopGeneration,
    regenerateResponse,
    retryLastMessage,
    clearChat,
  };
}
