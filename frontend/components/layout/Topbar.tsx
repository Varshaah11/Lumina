"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Menu, Sparkles, LogOut, User as UserIcon, LayoutDashboard, MessageSquarePlus, History, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export function Topbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  const getInitials = (name?: string) => {
    if (!name) return "U";
    return name.charAt(0).toUpperCase();
  };

  const navItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "New Chat", href: "/chat", icon: MessageSquarePlus },
    { name: "Chat History", href: "/history", icon: History },
    { name: "Profile", href: "/profile", icon: UserIcon },
    { name: "Settings", href: "/settings", icon: Settings },
  ];

  return (
    <header className="h-20 w-full border-b border-white/5 bg-black/50 backdrop-blur-xl flex items-center justify-between px-4 sm:px-6 z-10 sticky top-0 md:static">
      <div className="flex items-center gap-4">
        {/* Mobile menu trigger */}
        <div className="md:hidden">
          <Sheet open={isOpen} onOpenChange={setIsOpen}>
            <SheetTrigger className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50 h-9 w-9 text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer">
              <Menu className="w-6 h-6" />
              <span className="sr-only">Toggle menu</span>
            </SheetTrigger>
            <SheetContent side="left" className="bg-black border-r border-white/10 p-0 w-72">
              <div className="h-20 flex items-center px-6 border-b border-white/5">
                <Link
                  href="/dashboard"
                  onClick={() => setIsOpen(false)}
                  className="flex items-center gap-3"
                >
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-xl font-bold tracking-tight text-white">LUMINA</span>
                </Link>
              </div>
              <SheetTitle className="sr-only">Mobile Menu</SheetTitle>
              <SheetDescription className="sr-only">Navigation for mobile</SheetDescription>
              
              <div className="p-4 space-y-2 flex flex-col h-[calc(100vh-80px)] overflow-y-auto">
                <div className="flex-1 space-y-2">
                  {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.name}
                        href={item.href}
                        onClick={(e) => {
                          setIsOpen(false);
                          if (item.name === "New Chat") {
                            e.preventDefault();
                            router.push("/chat");
                            window.dispatchEvent(new Event("new-chat"));
                          }
                        }}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                          isActive
                            ? "bg-gradient-to-r from-indigo-500/20 to-purple-500/20 text-indigo-400 font-medium"
                            : "text-gray-400 hover:bg-white/5 hover:text-white"
                        }`}
                      >
                        <item.icon className={`w-5 h-5 ${isActive ? "text-indigo-400" : ""}`} />
                        <span className="font-medium">{item.name}</span>
                      </Link>
                    );
                  })}
                </div>
                <div className="pt-4 border-t border-white/5">
                  <button
                    type="button"
                    onClick={() => {
                      setIsOpen(false);
                      logout();
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-red-400 hover:bg-red-500/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer"
                  >
                    <LogOut className="w-5 h-5" />
                    <span className="font-medium">Logout</span>
                  </button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* Dynamic page title based on route could go here */}
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden md:flex flex-col items-end max-w-[200px] lg:max-w-[280px]">
          <span className="text-sm font-medium text-white truncate w-full text-right">{user?.name || "User"}</span>
          <span className="text-xs text-gray-500 truncate w-full text-right">{user?.email}</span>
        </div>
        <Link
          href="/profile"
          aria-label={`View profile for ${user?.name || "User"}`}
          title="View Profile"
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center hover:ring-2 hover:ring-white/20 active:scale-95 transition-all cursor-pointer shadow-lg">
            <span className="text-white font-medium">{getInitials(user?.name)}</span>
          </div>
        </Link>
      </div>
    </header>
  );
}
