"use client";

import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { PageHeader } from "@/components/ui/PageHeader";
import { DashboardCard } from "@/components/dashboard/DashboardCard";
import { Palette, Bell, User as UserIcon, Shield, Laptop, HelpCircle } from "lucide-react";

export default function SettingsPage() {
  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto pb-12">
        <PageHeader 
          title="Settings" 
          description="Manage your application preferences and configurations."
        />

        <div className="space-y-6">
          {/* Appearance Section */}
          <DashboardCard title="Appearance" icon={Palette} delay={0.1}>
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex items-center justify-between p-4 rounded-xl border border-white/5 bg-white/5">
                <div>
                  <h4 className="text-white font-medium">Theme</h4>
                  <p className="text-sm text-gray-400">Customize the look and feel of Lumina.</p>
                </div>
                <div className="flex bg-black/50 rounded-lg border border-white/10 p-1">
                  <button className="px-4 py-1.5 rounded-md bg-white/10 text-white text-sm font-medium transition-colors shadow-sm">Dark</button>
                  <button className="px-4 py-1.5 rounded-md text-gray-400 hover:text-white text-sm font-medium transition-colors">Light</button>
                  <button className="px-4 py-1.5 rounded-md text-gray-400 hover:text-white text-sm font-medium transition-colors">System</button>
                </div>
              </div>
            </div>
          </DashboardCard>

          {/* Notifications Section */}
          <DashboardCard title="Notifications" icon={Bell} delay={0.2}>
            <div className="mt-4 flex flex-col gap-4">
              {[
                { title: "Email Notifications", desc: "Receive summary reports and updates." },
                { title: "Product Updates", desc: "Hear about new features and announcements." },
                { title: "Security Alerts", desc: "Get notified about suspicious activity." }
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between p-4 rounded-xl border border-white/5 bg-white/5">
                  <div>
                    <h4 className="text-white font-medium">{item.title}</h4>
                    <p className="text-sm text-gray-400">{item.desc}</p>
                  </div>
                  <div className={`w-11 h-6 rounded-full transition-colors cursor-pointer relative ${i !== 1 ? 'bg-indigo-500' : 'bg-gray-600'}`}>
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${i !== 1 ? 'left-6' : 'left-1'}`} />
                  </div>
                </div>
              ))}
            </div>
          </DashboardCard>

          {/* System Section */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <DashboardCard title="Account Settings" icon={UserIcon} delay={0.3} className="cursor-pointer hover:bg-white/10 transition-colors">
              <p className="text-sm text-gray-400 mt-2">Manage your email, password, and active sessions.</p>
            </DashboardCard>
            
            <DashboardCard title="Data Privacy" icon={Shield} delay={0.4} className="cursor-pointer hover:bg-white/10 transition-colors">
              <p className="text-sm text-gray-400 mt-2">Control how your data is used to train AI models.</p>
            </DashboardCard>
          </div>

          <DashboardCard title="About Lumina" icon={HelpCircle} delay={0.5}>
            <div className="mt-4 p-4 rounded-xl border border-white/5 bg-white/5 flex items-center justify-between">
              <div>
                <h4 className="text-white font-medium flex items-center gap-2">
                  <Laptop className="w-4 h-4 text-indigo-400" />
                  Version 1.0.0 (Beta)
                </h4>
                <p className="text-sm text-gray-400 mt-1">Lumina is an advanced AI workspace designed for professionals.</p>
              </div>
              <button className="px-4 py-2 text-sm font-medium text-white bg-white/10 hover:bg-white/20 rounded-lg transition-colors">
                View Changelog
              </button>
            </div>
          </DashboardCard>
        </div>
      </div>
    </DashboardLayout>
  );
}
