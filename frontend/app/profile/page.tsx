"use client";

import { useAuth } from "@/hooks/useAuth";
import { Navbar } from "@/components/Navbar";
import { motion } from "framer-motion";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { LogOut, User as UserIcon, Mail, Calendar } from "lucide-react";

export default function ProfilePage() {
  const { user, isLoading, logout } = useAuth();

  return (
    <div className="min-h-screen bg-black">
      <Navbar />
      
      <main className="pt-32 pb-16 px-6 max-w-3xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 md:p-12"
        >
          <div className="flex items-center gap-4 mb-10">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
              <UserIcon className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-white">Profile Settings</h1>
              <p className="text-gray-400">Manage your account preferences</p>
            </div>
          </div>

          <div className="space-y-8">
            <div className="space-y-6">
              <div>
                <label className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-2">
                  <UserIcon className="w-4 h-4" /> Name
                </label>
                {isLoading ? (
                  <Skeleton className="h-12 w-full bg-white/10 rounded-xl" />
                ) : (
                  <div className="w-full bg-black/40 border border-white/10 rounded-xl p-4 text-white">
                    {user?.name || "Not set"}
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-2">
                  <Mail className="w-4 h-4" /> Email
                </label>
                {isLoading ? (
                  <Skeleton className="h-12 w-full bg-white/10 rounded-xl" />
                ) : (
                  <div className="w-full bg-black/40 border border-white/10 rounded-xl p-4 text-gray-300">
                    {user?.email}
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-2">
                  <Calendar className="w-4 h-4" /> Account Created
                </label>
                {isLoading ? (
                  <Skeleton className="h-12 w-full bg-white/10 rounded-xl" />
                ) : (
                  <div className="w-full bg-black/40 border border-white/10 rounded-xl p-4 text-gray-400">
                    {user?.created_at ? new Date(user.created_at).toLocaleDateString() : "Unknown"}
                  </div>
                )}
              </div>
            </div>

            <div className="pt-8 border-t border-white/10">
              <Button 
                onClick={logout}
                variant="destructive" 
                className="w-full md:w-auto flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </Button>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
