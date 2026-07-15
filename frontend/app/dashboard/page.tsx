"use client";

import { useAuth } from "@/hooks/useAuth";
import { Navbar } from "@/components/Navbar";
import { motion } from "framer-motion";
import { MessageSquarePlus, FileUp, Mic, History, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  const { user, isLoading } = useAuth();

  const actions = [
    { name: "New Chat", icon: MessageSquarePlus, color: "from-blue-500 to-cyan-500" },
    { name: "Upload PDF", icon: FileUp, color: "from-purple-500 to-pink-500" },
    { name: "Voice Assistant", icon: Mic, color: "from-orange-500 to-red-500" },
    { name: "Recent Conversations", icon: History, color: "from-emerald-500 to-teal-500" },
  ];

  return (
    <div className="min-h-screen bg-black">
      <Navbar />
      
      <main className="pt-32 pb-16 px-6 max-w-7xl mx-auto">
        <div className="mb-12">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-64 bg-white/10" />
              <Skeleton className="h-6 w-96 bg-white/10" />
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h1 className="text-4xl font-bold text-white mb-4">
                Welcome back, {user?.name || "Explorer"} <Sparkles className="inline-block w-8 h-8 text-indigo-400 ml-2" />
              </h1>
              <p className="text-gray-400 text-lg">What would you like to explore today?</p>
            </motion.div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {actions.map((action, index) => (
            <motion.div
              key={action.name}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="group relative cursor-pointer"
            >
              <div className="absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl blur-xl -z-10"
                   style={{ backgroundImage: `var(--tw-gradient-stops)` }} />
              <div className={`h-full p-6 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm hover:border-white/20 transition-colors flex flex-col items-center justify-center gap-4 group-hover:bg-white/10`}>
                <div className={`w-16 h-16 rounded-full bg-gradient-to-br ${action.color} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform duration-300`}>
                  <action.icon className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-white font-medium text-lg">{action.name}</h3>
              </div>
            </motion.div>
          ))}
        </div>
      </main>
    </div>
  );
}
