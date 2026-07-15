"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Menu, Sparkles, User as UserIcon, LogOut, Settings, LayoutDashboard, MessageSquare } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const { isAuthenticated, user, logout, isLoading } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const publicLinks = [
    { name: "Home", href: "/" },
    { name: "Features", href: "/#features" },
    { name: "About", href: "/#about" },
  ];

  const privateLinks = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Chats", href: "/chat", icon: MessageSquare },
  ];

  const getInitials = (name?: string) => {
    if (!name) return "U";
    return name.charAt(0).toUpperCase();
  };

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? "bg-black/80 backdrop-blur-md border-b border-white/10 py-4" : "bg-transparent py-6"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
        <Link href={isAuthenticated ? "/dashboard" : "/"} className="flex items-center gap-2 group">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center group-hover:shadow-[0_0_15px_rgba(99,102,241,0.5)] transition-shadow">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">LUMINA</span>
        </Link>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-8">
          <div className="flex items-center gap-6">
            {!isLoading && !isAuthenticated && publicLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className="text-sm font-medium text-gray-300 hover:text-white transition-colors"
              >
                {link.name}
              </Link>
            ))}
            
            {!isLoading && isAuthenticated && privateLinks.map((link) => {
              const isActive = pathname.startsWith(link.href);
              return (
                <Link
                  key={link.name}
                  href={link.href}
                  className={`text-sm font-medium transition-colors flex items-center gap-2 ${
                    isActive ? "text-white" : "text-gray-400 hover:text-white"
                  }`}
                >
                  <link.icon className="w-4 h-4" />
                  {link.name}
                </Link>
              );
            })}
          </div>
          
          <div className="flex items-center gap-4">
            {!isLoading && !isAuthenticated && (
              <>
                <Link href="/login">
                  <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/10">
                    Login
                  </Button>
                </Link>
                <Link href="/register">
                  <Button className="bg-white text-black hover:bg-gray-200 rounded-full font-medium px-6">
                    Get Started
                  </Button>
                </Link>
              </>
            )}

            {!isLoading && isAuthenticated && (
              <DropdownMenu>
                <DropdownMenuTrigger className="relative h-10 w-10 flex items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 p-0 hover:ring-2 hover:ring-white/20 transition-all outline-none border-none">
                  <span className="text-white font-medium">{getInitials(user?.name)}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 bg-black/90 border-white/10 text-white backdrop-blur-xl">
                  <div className="flex items-center justify-start gap-2 p-2">
                    <div className="flex flex-col space-y-1 leading-none">
                      <p className="font-medium">{user?.name || "User"}</p>
                      <p className="w-[200px] truncate text-sm text-gray-400">
                        {user?.email}
                      </p>
                    </div>
                  </div>
                  <DropdownMenuSeparator className="bg-white/10" />
                  <DropdownMenuItem className="hover:bg-white/10 focus:bg-white/10 cursor-pointer p-0">
                    <Link href="/profile" className="flex items-center w-full px-2 py-1.5">
                      <UserIcon className="mr-2 h-4 w-4" />
                      <span>Profile</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="hover:bg-white/10 focus:bg-white/10 cursor-pointer p-0">
                    <Link href="/settings" className="flex items-center w-full px-2 py-1.5">
                      <Settings className="mr-2 h-4 w-4" />
                      <span>Settings</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="bg-white/10" />
                  <DropdownMenuItem onClick={logout} className="text-red-400 hover:bg-white/10 focus:bg-white/10 hover:text-red-300 cursor-pointer">
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Log out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* Mobile Nav */}
        <div className="md:hidden">
          <Sheet>
            <SheetTrigger render={<Button variant="ghost" size="icon" className="text-white hover:bg-white/10" />}>
                <Menu className="w-6 h-6" />
                <span className="sr-only">Toggle menu</span>
            </SheetTrigger>
            <SheetContent side="right" className="bg-black/95 border-l border-white/10 text-white p-6">
              <SheetTitle className="text-left text-xl font-bold mb-8 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                LUMINA
              </SheetTitle>
              <SheetDescription className="sr-only">Mobile navigation menu</SheetDescription>
              
              <div className="flex flex-col gap-6">
                {!isLoading && !isAuthenticated && publicLinks.map((link) => (
                  <Link
                    key={link.name}
                    href={link.href}
                    className="text-lg font-medium text-gray-300 hover:text-white transition-colors"
                  >
                    {link.name}
                  </Link>
                ))}

                {!isLoading && isAuthenticated && privateLinks.map((link) => (
                  <Link
                    key={link.name}
                    href={link.href}
                    className="text-lg font-medium text-gray-300 hover:text-white transition-colors flex items-center gap-3"
                  >
                    <link.icon className="w-5 h-5" />
                    {link.name}
                  </Link>
                ))}

                <div className="h-px bg-white/10 w-full my-2" />
                
                {!isLoading && !isAuthenticated && (
                  <>
                    <Link href="/login" className="w-full">
                      <Button variant="ghost" className="w-full justify-start text-gray-300 hover:text-white hover:bg-white/10 text-lg">
                        Login
                      </Button>
                    </Link>
                    <Link href="/register" className="w-full">
                      <Button className="w-full justify-start bg-white text-black hover:bg-gray-200 text-lg">
                        Get Started
                      </Button>
                    </Link>
                  </>
                )}

                {!isLoading && isAuthenticated && (
                  <>
                    <Link href="/profile" className="w-full">
                      <Button variant="ghost" className="w-full justify-start text-gray-300 hover:text-white hover:bg-white/10 text-lg">
                        <UserIcon className="mr-3 h-5 w-5" />
                        Profile
                      </Button>
                    </Link>
                    <Link href="/settings" className="w-full">
                      <Button variant="ghost" className="w-full justify-start text-gray-300 hover:text-white hover:bg-white/10 text-lg">
                        <Settings className="mr-3 h-5 w-5" />
                        Settings
                      </Button>
                    </Link>
                    <Button onClick={logout} variant="ghost" className="w-full justify-start text-red-400 hover:text-red-300 hover:bg-white/10 text-lg">
                      <LogOut className="mr-3 h-5 w-5" />
                      Logout
                    </Button>
                  </>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  );
}
