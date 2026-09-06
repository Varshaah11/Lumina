"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  MessageSquarePlus,
  Settings,
  LogOut,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  User as UserIcon,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Loader2,
  Pencil,
  Check,
  X,
  Search
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { chatService } from "@/services/chat";

interface SidebarProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

export function Sidebar({ isCollapsed, setIsCollapsed }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchChatId = searchParams?.get("chatId");
  const [currentChatId, setCurrentChatId] = useState<string | null>(searchChatId || null);

  const { logout } = useAuth();
  const [recentChats, setRecentChats] = useState<any[]>([]);

  // State for chat deletion confirmation
  const [chatToDelete, setChatToDelete] = useState<any | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // State for chat renaming inline UI
  const [editingChatId, setEditingChatId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // State for chat search
  const [searchQuery, setSearchQuery] = useState<string>("");

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredChats = trimmedQuery
    ? recentChats.filter((chat) => chat.title?.toLowerCase().includes(trimmedQuery))
    : recentChats;

  useEffect(() => {
    const urlChatId = searchParams?.get("chatId") || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("chatId") : null);
    setCurrentChatId(urlChatId);
  }, [searchParams, pathname]);

  useEffect(() => {
    const loadChats = () => {
      chatService.getChats().then((data) => {
        if (Array.isArray(data)) {
          setRecentChats(data);
        }
      }).catch(console.error);
    };

    loadChats();

    const handleChatCreated = () => {
      loadChats();
      if (typeof window !== "undefined") {
        const activeId = new URLSearchParams(window.location.search).get("chatId");
        setCurrentChatId(activeId);
      }
    };

    window.addEventListener("chat-created", handleChatCreated);
    return () => {
      window.removeEventListener("chat-created", handleChatCreated);
    };
  }, [pathname, searchParams]);

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

      // Update sidebar immediately
      setRecentChats((prev) => prev.filter((c) => c.id !== targetChat.id));

      // If the deleted chat is currently open, navigate to /chat
      const activeId = searchParams?.get("chatId") || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("chatId") : null);
      if (activeId === targetChat.id.toString()) {
        router.push("/chat");
      }

      setChatToDelete(null);
    } catch (err: any) {
      console.error("Failed to delete chat:", err);
      const errorMessage = err?.message || "Failed to delete chat. Please try again.";
      setDeleteError(errorMessage);
      // Retain chat in state if deletion fails
    } finally {
      setIsDeleting(false);
    }
  };

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

      // Immediately update sidebar state
      setRecentChats((prev) =>
        prev.map((c) => (c.id === targetId ? { ...c, title: updatedChat.title } : c))
      );

      setEditingChatId(null);
      setEditingTitle("");
    } catch (err: any) {
      console.error("Failed to rename chat:", err);
      const errorMessage = err?.message || "Failed to rename chat.";
      setRenameError(errorMessage);
      // Keep previous title in state
    } finally {
      setIsRenaming(false);
    }
  };

  const handleKeyDownRename = (e: React.KeyboardEvent, chat: any) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleConfirmRename(e, chat);
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelRename();
    }
  };

  const topItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "New Chat", href: "/chat", icon: MessageSquarePlus },
  ];

  const bottomItems = [
    { name: "Profile", href: "/profile", icon: UserIcon },
    { name: "Settings", href: "/settings", icon: Settings },
  ];

  return (
    <>
      <motion.aside
        initial={{ width: 260 }}
        animate={{ width: isCollapsed ? 80 : 260 }}
        transition={{ duration: 0.3, ease: "easeInOut" }}
        className="hidden md:flex flex-col h-screen bg-black/50 backdrop-blur-xl border-r border-white/10 relative z-20"
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-8 bg-black border border-white/20 rounded-full p-1 text-gray-400 hover:text-white transition-colors z-30"
        >
          {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        <div className="h-20 flex items-center px-6 border-b border-white/5 shrink-0">
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <AnimatePresence>
              {!isCollapsed && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  className="text-xl font-bold tracking-tight text-white whitespace-nowrap overflow-hidden"
                >
                  LUMINA
                </motion.span>
              )}
            </AnimatePresence>
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto py-6 px-3 space-y-6 no-scrollbar flex flex-col">
          <div className="space-y-2">
            {topItems.map((item) => {
              const isActive = pathname === item.href && !currentChatId;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => {
                    if (item.name === "New Chat") {
                      setSearchQuery("");
                      if (pathname === "/chat") {
                        window.history.pushState(null, "", "/chat");
                        window.dispatchEvent(new PopStateEvent("popstate"));
                      }
                    }
                  }}
                  className={`flex items-center gap-3 px-3 py-3 rounded-xl transition-all group ${
                    isActive
                      ? "bg-gradient-to-r from-indigo-500/20 to-purple-500/20 text-indigo-400"
                      : "text-gray-400 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <item.icon className={`w-5 h-5 shrink-0 ${isActive ? "text-indigo-400" : "group-hover:text-white"}`} />
                  <AnimatePresence>
                    {!isCollapsed && (
                      <motion.span
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: "auto" }}
                        exit={{ opacity: 0, width: 0 }}
                        className="font-medium whitespace-nowrap overflow-hidden"
                      >
                        {item.name}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Link>
              );
            })}
          </div>

          {recentChats.length > 0 && (
            <div className="flex-1 space-y-3 flex flex-col min-h-0">
              <AnimatePresence>
                {!isCollapsed && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-2 px-1 shrink-0"
                  >
                    <div className="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      Recent Chats
                    </div>
                    <div className="relative flex items-center">
                      <Search className="w-4 h-4 text-gray-400 absolute left-3 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search chats..."
                        aria-label="Search chats"
                        className="w-full bg-white/5 border border-white/10 focus:border-indigo-500/50 rounded-xl pl-9 pr-8 py-2 text-sm text-white placeholder-gray-500 focus:outline-none transition-all"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2.5 p-1 text-gray-400 hover:text-white rounded-md transition-colors"
                          title="Clear search"
                          aria-label="Clear search"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="space-y-1 overflow-y-auto flex-1 no-scrollbar">
                {filteredChats.length > 0 ? (
                  filteredChats.map((chat) => {
                    const isActive = pathname === "/chat" && currentChatId === chat.id.toString();
                    const isEditing = editingChatId === chat.id;

                    if (isEditing && !isCollapsed) {
                      return (
                        <div key={chat.id} className="relative group/item my-1">
                          <div className="flex items-center gap-1 px-2 py-1.5 rounded-xl bg-white/10 border border-indigo-500/50">
                            <MessageSquare className="w-4 h-4 text-indigo-400 shrink-0 ml-1" />
                            <input
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => handleKeyDownRename(e, chat)}
                              maxLength={255}
                              autoFocus
                              disabled={isRenaming}
                              className="bg-transparent text-white text-sm font-medium focus:outline-none flex-1 min-w-0 px-1 py-0.5"
                              placeholder="Chat title..."
                            />
                            <button
                              type="button"
                              onClick={(e) => handleConfirmRename(e, chat)}
                              disabled={!editingTitle.trim() || isRenaming}
                              className="p-1 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded-lg transition-all disabled:opacity-40 disabled:hover:bg-transparent shrink-0 cursor-pointer"
                              title="Save"
                            >
                              {isRenaming ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
                              ) : (
                                <Check className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelRename}
                              disabled={isRenaming}
                              className="p-1 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-all shrink-0 cursor-pointer"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {renameError && (
                            <div className="px-2 pt-1 text-[11px] text-red-400 truncate">
                              {renameError}
                            </div>
                          )}
                        </div>
                      );
                    }

                    return (
                      <div key={chat.id} className="relative group/item">
                        <Link
                          href={`/chat?chatId=${chat.id}`}
                          className={`flex items-center justify-between px-3 py-2.5 rounded-xl transition-all group ${
                            isActive
                              ? "bg-white/10 text-white"
                              : "text-gray-400 hover:bg-white/5 hover:text-white"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <MessageSquare className="w-4 h-4 shrink-0" />
                            <AnimatePresence>
                              {!isCollapsed && (
                                <motion.span
                                  initial={{ opacity: 0, width: 0 }}
                                  animate={{ opacity: 1, width: "auto" }}
                                  exit={{ opacity: 0, width: 0 }}
                                  className="font-medium text-sm whitespace-nowrap overflow-hidden text-ellipsis flex-1"
                                >
                                  {chat.title}
                                </motion.span>
                              )}
                            </AnimatePresence>
                          </div>
                          {!isCollapsed && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0 ml-1">
                              <button
                                type="button"
                                onClick={(e) => handleRenameClick(e, chat)}
                                className="p-1.5 text-gray-400 hover:text-indigo-300 hover:bg-indigo-500/10 rounded-lg transition-all"
                                title="Rename chat"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteClick(e, chat)}
                                className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                                title="Delete chat"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </Link>
                      </div>
                    );
                  })
                ) : searchQuery.trim() !== "" ? (
                  !isCollapsed && (
                    <div className="px-4 py-3 text-xs text-gray-500 text-center">
                      No chats found
                    </div>
                  )
                ) : null}
              </div>
            </div>
          )}
        </div>


        <div className="p-3 border-t border-white/5 space-y-2 shrink-0">
          {bottomItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-3 rounded-xl transition-all group ${
                  isActive
                    ? "bg-white/10 text-white"
                    : "text-gray-400 hover:bg-white/5 hover:text-white"
                }`}
              >
                <item.icon className="w-5 h-5 shrink-0" />
                <AnimatePresence>
                  {!isCollapsed && (
                    <motion.span
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      exit={{ opacity: 0, width: 0 }}
                      className="font-medium whitespace-nowrap overflow-hidden"
                    >
                      {item.name}
                    </motion.span>
                  )}
                </AnimatePresence>
              </Link>
            );
          })}

          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all group text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <AnimatePresence>
              {!isCollapsed && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  className="font-medium whitespace-nowrap overflow-hidden"
                >
                  Logout
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>
      </motion.aside>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {chatToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
            <motion.div
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
                  <h3 className="text-lg font-semibold text-white">Delete Chat</h3>
                  <p className="text-xs text-gray-400">This action cannot be undone.</p>
                </div>
              </div>

              <p className="text-sm text-gray-300">
                Are you sure you want to delete <span className="font-semibold text-white">"{chatToDelete.title}"</span>? This chat and all of its messages will be permanently deleted.
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
                  className="px-4 py-2 text-sm font-medium text-gray-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={isDeleting}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-xl transition-all shadow-lg shadow-red-600/20 disabled:opacity-50 cursor-pointer"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    "Delete Chat"
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
