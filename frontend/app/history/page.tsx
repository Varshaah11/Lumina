"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PageHeader } from "@/components/ui/PageHeader";
import { chatService } from "@/services/chat";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageSquare,
  Search,
  Trash2,
  Pencil,
  Check,
  X,
  Loader2,
  AlertTriangle,
  MessageSquarePlus,
  Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export default function HistoryPage() {
  const router = useRouter();
  const [chats, setChats] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Deletion state
  const [chatToDelete, setChatToDelete] = useState<any | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Renaming state
  const [editingChatId, setEditingChatId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const loadChats = async () => {
    setIsLoading(true);
    try {
      const data = await chatService.getChats();
      if (Array.isArray(data)) {
        setChats(data);
      }
    } catch (err) {
      console.error("Failed to load chat history:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadChats();
  }, []);

  const handleDeleteClick = (e: React.MouseEvent, chat: any) => {
    e.stopPropagation();
    e.preventDefault();
    setDeleteError(null);
    setChatToDelete(chat);
  };

  const handleConfirmDelete = async () => {
    if (!chatToDelete) return;
    const targetChat = chatToDelete;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      await chatService.deleteChat(targetChat.id);
      setChats((prev) => prev.filter((c) => c.id !== targetChat.id));
      setChatToDelete(null);
      window.dispatchEvent(new Event("chats-updated"));
    } catch (err: any) {
      console.error("Failed to delete chat:", err);
      setDeleteError(err?.message || "Failed to delete chat.");
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (!chatToDelete) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDeleting) {
        setChatToDelete(null);
        setDeleteError(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [chatToDelete, isDeleting]);

  const handleRenameClick = (e: React.MouseEvent, chat: any) => {
    e.stopPropagation();
    e.preventDefault();
    setRenameError(null);
    setEditingChatId(chat.id);
    setEditingTitle(chat.title);
  };

  const handleCancelRename = (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setEditingChatId(null);
    setEditingTitle("");
    setRenameError(null);
  };

  const handleConfirmRename = async (e?: React.FormEvent | React.MouseEvent, chat?: any) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (!editingChatId) return;

    const trimmedTitle = editingTitle.trim();
    if (!trimmedTitle || isRenaming) return;

    const targetId = editingChatId;
    setIsRenaming(true);
    setRenameError(null);

    try {
      const updatedChat = await chatService.renameChat(targetId, trimmedTitle);
      setChats((prev) =>
        prev.map((c) => (c.id === targetId ? { ...c, title: updatedChat.title } : c))
      );
      setEditingChatId(null);
      setEditingTitle("");
      window.dispatchEvent(new Event("chats-updated"));
    } catch (err: any) {
      console.error("Failed to rename chat:", err);
      setRenameError(err?.message || "Failed to rename chat.");
    } finally {
      setIsRenaming(false);
    }
  };

  const filteredChats = searchQuery.trim()
    ? chats.filter((c) => c.title?.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : chats;

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto pb-12">
        <PageHeader
          title="Conversation History"
          description="View, search, and manage all your past interactions with Lumina."
          action={
            <Button
              onClick={() => router.push("/chat")}
              className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-lg"
            >
              <MessageSquarePlus className="w-4 h-4 mr-2" />
              New Conversation
            </Button>
          }
        />

        {/* Search Bar */}
        <div className="mb-6 relative max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-3.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="w-full bg-white/5 border border-white/10 focus:border-indigo-500/50 rounded-xl pl-10 pr-10 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none transition-all shadow-sm"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-3 p-1 text-gray-400 hover:text-white rounded-md transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* History List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-gray-500 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
            <span>Loading conversation history...</span>
          </div>
        ) : filteredChats.length === 0 ? (
          <div className="p-12 rounded-2xl bg-white/5 border border-white/10 text-center max-w-md mx-auto my-8 space-y-4">
            <div className="w-12 h-12 rounded-full bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
              <MessageSquare className="w-6 h-6" />
            </div>
            <h3 className="text-lg font-bold text-white">No Conversations Found</h3>
            <p className="text-sm text-gray-400">
              {searchQuery ? "No chat titles matched your search query." : "You haven't started any conversations with Lumina yet."}
            </p>
            <Button
              onClick={() => router.push("/chat")}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-xl"
            >
              Start a Conversation
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredChats.map((chat) => {
              const isEditing = editingChatId === chat.id;

              return (
                <motion.div
                  key={chat.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-5 rounded-2xl bg-white/5 border border-white/10 hover:border-indigo-500/30 hover:bg-white/[0.07] transition-all group relative flex flex-col justify-between"
                >
                  {isEditing ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 bg-black/40 p-2 rounded-xl border border-indigo-500/50">
                        <MessageSquare className="w-4 h-4 text-indigo-400 shrink-0" />
                        <input
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          maxLength={255}
                          autoFocus
                          disabled={isRenaming}
                          className="bg-transparent text-white text-sm font-medium focus:outline-none flex-1 min-w-0 px-1"
                        />
                        <button
                          type="button"
                          onClick={handleConfirmRename}
                          disabled={!editingTitle.trim() || isRenaming}
                          className="p-1 text-emerald-400 hover:bg-emerald-500/10 rounded-lg shrink-0 cursor-pointer"
                        >
                          {isRenaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelRename}
                          disabled={isRenaming}
                          className="p-1 text-gray-400 hover:bg-white/10 rounded-lg shrink-0 cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      {renameError && <div className="text-xs text-red-400">{renameError}</div>}
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div
                          onClick={() => router.push(`/chat?chatId=${chat.id}`)}
                          className="flex items-center gap-3 flex-1 cursor-pointer group-hover:text-indigo-300 transition-colors"
                        >
                          <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 shrink-0">
                            <MessageSquare className="w-5 h-5" />
                          </div>
                          <h3 className="font-semibold text-white text-base line-clamp-2 leading-snug">
                            {chat.title}
                          </h3>
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            type="button"
                            onClick={(e) => handleRenameClick(e, chat)}
                            className="p-1.5 text-gray-400 hover:text-indigo-300 hover:bg-indigo-500/10 rounded-lg transition-colors"
                            title="Rename conversation"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteClick(e, chat)}
                            className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Delete conversation"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div
                        onClick={() => router.push(`/chat?chatId=${chat.id}`)}
                        className="flex items-center gap-2 text-xs text-gray-500 mt-4 cursor-pointer"
                      >
                        <Calendar className="w-3.5 h-3.5" />
                        <span>{formatDate(chat.updated_at || chat.created_at)}</span>
                      </div>
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Delete Modal */}
        <AnimatePresence>
          {chatToDelete && (
            <div
              onClick={() => {
                if (!isDeleting) {
                  setChatToDelete(null);
                  setDeleteError(null);
                }
              }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md"
            >
              <motion.div
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="w-full max-w-md bg-zinc-900 border border-white/10 rounded-2xl p-6 shadow-2xl space-y-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                    <AlertTriangle className="w-5 h-5 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-white">Delete Conversation</h3>
                    <p className="text-xs text-gray-400">This action cannot be undone.</p>
                  </div>
                </div>

                <p className="text-sm text-gray-300">
                  Are you sure you want to delete <span className="font-semibold text-white">"{chatToDelete.title}"</span>?
                </p>

                {deleteError && (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
                    {deleteError}
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setChatToDelete(null);
                      setDeleteError(null);
                    }}
                    disabled={isDeleting}
                    className="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={isDeleting}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-xl transition-all shadow-lg shadow-red-600/20 cursor-pointer"
                  >
                    {isDeleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete"}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </DashboardLayout>
  );
}
