"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Menu, Sparkles } from "lucide-react";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const navLinks = [
    { name: "Home", href: "/" },
    { name: "Features", href: "#features" },
    { name: "About", href: "#about" },
    { name: "Docs", href: "#docs" },
  ];

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? "bg-black/50 backdrop-blur-md border-b border-white/10 py-4" : "bg-transparent py-6"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center group-hover:shadow-[0_0_15px_rgba(99,102,241,0.5)] transition-shadow">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">LUMINA</span>
        </Link>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-8">
          <div className="flex items-center gap-6">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className="text-sm font-medium text-gray-300 hover:text-white transition-colors"
              >
                {link.name}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login">
              <Button variant="ghost" className="text-gray-300 hover:text-white hover:bg-white/10">
                Sign In
              </Button>
            </Link>
            <Link href="/register">
              <Button className="bg-white text-black hover:bg-gray-200 rounded-full font-medium px-6">
                Get Started
              </Button>
            </Link>
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
                {navLinks.map((link) => (
                  <Link
                    key={link.name}
                    href={link.href}
                    className="text-lg font-medium text-gray-300 hover:text-white transition-colors"
                  >
                    {link.name}
                  </Link>
                ))}
                <div className="h-px bg-white/10 w-full my-2" />
                <Link href="/login" className="w-full">
                  <Button variant="ghost" className="w-full justify-start text-gray-300 hover:text-white hover:bg-white/10 text-lg">
                    Sign In
                  </Button>
                </Link>
                <Link href="/register" className="w-full">
                  <Button className="w-full justify-start bg-white text-black hover:bg-gray-200 text-lg">
                    Get Started
                  </Button>
                </Link>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  );
}
