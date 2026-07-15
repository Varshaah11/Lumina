"use client";

import { useAuth } from "@/hooks/useAuth";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { DashboardCard } from "@/components/dashboard/DashboardCard";
import { motion } from "framer-motion";
import { MessageSquarePlus, FileUp, Mic, History, Sparkles, Activity, Clock, Zap } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  const { user, isLoading } = useAuth();

  const actions = [
    { name: "New Chat", icon: MessageSquarePlus, color: "from-blue-500 to-cyan-500" },
    { name: "Upload PDF", icon: FileUp, color: "from-purple-500 to-pink-500" },
    { name: "Voice Assistant", icon: Mic, color: "from-orange-500 to-red-500" },
    { name: "Recent History", icon: History, color: "from-emerald-500 to-teal-500" },
  ];

  return (
    <DashboardLayout>
      <div className="pb-12">
        {/* Welcome Section */}
        <div className="mb-12 mt-4">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-12 w-64 bg-white/10" />
              <Skeleton className="h-6 w-96 bg-white/10" />
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h1 className="text-4xl font-bold text-white mb-2">
                Welcome back, {user?.name || "Explorer"} <Sparkles className="inline-block w-8 h-8 text-indigo-400 ml-2" />
              </h1>
              <p className="text-gray-400 text-lg">Your AI workspace is ready. What are we building today?</p>
            </motion.div>
          )}
        </div>

        {/* Quick Actions Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
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
                <div className={`w-14 h-14 rounded-full bg-gradient-to-br ${action.color} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform duration-300`}>
                  <action.icon className="w-7 h-7 text-white" />
                </div>
                <h3 className="text-white font-medium text-lg">{action.name}</h3>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Usage Stats */}
          <div className="lg:col-span-1 space-y-4">
            <h2 className="text-xl font-bold text-white mb-4">Usage Statistics</h2>
            <DashboardCard title="Tokens Generated" value="45,231" icon={Zap} delay={0.2} />
            <DashboardCard title="Active Sessions" value="12" icon={Activity} delay={0.3} />
            <DashboardCard title="Time Saved" value="14.5 hrs" icon={Clock} delay={0.4} />
          </div>

          {/* Recent Activity */}
          <div className="lg:col-span-2">
            <h2 className="text-xl font-bold text-white mb-4">Recent Conversations</h2>
            <div className="space-y-3">
              {[
                { title: "React Performance Optimization", time: "2 hours ago" },
                { title: "Python Data Processing Script", time: "Yesterday" },
                { title: "Marketing Copy for Q3 Launch", time: "3 days ago" },
                { title: "Database Schema Design", time: "Last week" }
              ].map((chat, i) => (
                <motion.div 
                  key={i}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + (i * 0.1) }}
                  className="p-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors cursor-pointer flex items-center justify-between group"
                >
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-400 group-hover:bg-indigo-500 group-hover:text-white transition-colors">
                      <MessageSquarePlus className="w-5 h-5" />
                    </div>
                    <span className="text-gray-300 group-hover:text-white font-medium">{chat.title}</span>
                  </div>
                  <span className="text-sm text-gray-500">{chat.time}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
