"use client";

import { useAuth } from "@/hooks/useAuth";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PageHeader } from "@/components/ui/PageHeader";
import { DashboardCard } from "@/components/dashboard/DashboardCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { User as UserIcon, Mail, Calendar, Shield, Edit2 } from "lucide-react";

export default function ProfilePage() {
  const { user, isLoading } = useAuth();

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto pb-12">
        <PageHeader 
          title="Profile" 
          description="Manage your personal information and account settings."
          action={
            <Button variant="outline" className="border-white/20 text-white hover:bg-white/10">
              <Edit2 className="w-4 h-4 mr-2" />
              Edit Profile
            </Button>
          }
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            <DashboardCard title="Avatar" className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-24 h-24 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center mb-4 shadow-xl border-4 border-black">
                <UserIcon className="w-10 h-10 text-white" />
              </div>
              <h3 className="text-lg font-bold text-white">{user?.name || "User"}</h3>
              <p className="text-sm text-gray-400">{user?.email}</p>
            </DashboardCard>
          </div>

          <div className="md:col-span-2 space-y-6">
            <DashboardCard title="Personal Information" icon={UserIcon}>
              <div className="space-y-4 mt-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Full Name</label>
                  {isLoading ? (
                    <Skeleton className="h-6 w-48 bg-white/10 mt-1" />
                  ) : (
                    <div className="text-white font-medium text-lg mt-1">{user?.name || "Not set"}</div>
                  )}
                </div>
                
                <div className="h-px w-full bg-white/5" />

                <div>
                  <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Email Address</label>
                  {isLoading ? (
                    <Skeleton className="h-6 w-64 bg-white/10 mt-1" />
                  ) : (
                    <div className="text-white font-medium text-lg mt-1">{user?.email}</div>
                  )}
                </div>
              </div>
            </DashboardCard>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <DashboardCard title="Account Created" icon={Calendar} delay={0.1}>
                {isLoading ? (
                  <Skeleton className="h-6 w-32 bg-white/10 mt-2" />
                ) : (
                  <div className="text-white font-medium text-lg mt-2">
                    {user?.created_at ? new Date(user.created_at).toLocaleDateString(undefined, { 
                      year: 'numeric', month: 'long', day: 'numeric' 
                    }) : "Unknown"}
                  </div>
                )}
              </DashboardCard>

              <DashboardCard title="Security Level" icon={Shield} delay={0.2}>
                <div className="flex items-center gap-2 mt-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                  <span className="text-white font-medium text-lg">Standard</span>
                </div>
              </DashboardCard>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
