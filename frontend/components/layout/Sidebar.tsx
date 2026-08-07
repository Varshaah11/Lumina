"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
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
  MessageSquare
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { chatService } from "@/services/chat";

interface SidebarProps {
  isCollapsed: boolean;
  setIsCollapsed: (value: boolean) => void;
}

export function Sidebar({ isCollapsed, setIsCollapsed }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentChatId = searchParams?.get("chatId");
  
  const { logout } = useAuth();
  const [recentChats, setRecentChats] = useState<any[]>([]);

  useEffect(() => {
    chatService.getChats().then((data) => {
      if (Array.isArray(data)) {
        setRecentChats(data);
      }
    }).catch(console.error);
  }, [pathname, currentChatId]); // Refresh when navigating or changing chats

  const topItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "New Chat", href: "/chat", icon: MessageSquarePlus },
  ];

  const bottomItems = [
    { name: "Profile", href: "/profile", icon: UserIcon },
    { name: "Settings", href: "/settings", icon: Settings },
  ];

  return (
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
          <div className="flex-1 space-y-2">
            <AnimatePresence>
              {!isCollapsed && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="px-4 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider"
                >
                  Recent Chats
                </motion.div>
              )}
            </AnimatePresence>
            <div className="space-y-1">
              {recentChats.map((chat) => {
                const isActive = pathname === "/chat" && currentChatId === chat.id.toString();
                return (
                  <Link
                    key={chat.id}
                    href={`/chat?chatId=${chat.id}`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all group ${
                      isActive 
                        ? "bg-white/10 text-white" 
                        : "text-gray-400 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <MessageSquare className="w-4 h-4 shrink-0" />
                    <AnimatePresence>
                      {!isCollapsed && (
                        <motion.span
                          initial={{ opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: "auto" }}
                          exit={{ opacity: 0, width: 0 }}
                          className="font-medium text-sm whitespace-nowrap overflow-hidden text-ellipsis"
                        >
                          {chat.title}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </Link>
                );
              })}
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
  );
}
