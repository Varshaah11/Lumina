import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

export function About() {
  return (
    <section id="about" className="py-24 bg-black relative overflow-hidden">
      {/* Decorative background */}
      <div className="absolute top-1/2 left-0 -translate-y-1/2 w-96 h-96 bg-purple-500/10 blur-[100px] rounded-full pointer-events-none" />
      
      <div className="max-w-7xl mx-auto px-6 relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl md:text-5xl font-bold text-white mb-6">
              Designed for the modern professional
            </h2>
            <p className="text-gray-400 text-lg mb-6 leading-relaxed">
              Lumina AI was built with a single goal: to provide a powerful, privacy-first virtual assistant that feels like a natural extension of your workflow. 
            </p>
            <p className="text-gray-400 text-lg mb-8 leading-relaxed">
              Whether you are analyzing complex documents, drafting emails, or organizing your thoughts, Lumina provides the tools you need in an interface you will love to use.
            </p>
            <Link href="/register">
              <Button className="rounded-full px-8 bg-indigo-500 hover:bg-indigo-600 text-white border-0">
                Get Started Today
                <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </Link>
          </div>
          <div className="relative">
            <div className="aspect-square rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md p-8 flex flex-col relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 to-purple-500/10" />
              
              {/* Mock UI Elements */}
              <div className="w-full flex items-center gap-4 mb-8">
                <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center">
                  <div className="w-6 h-6 rounded-full bg-indigo-400" />
                </div>
                <div className="flex-1 bg-white/10 h-12 rounded-2xl" />
              </div>
              <div className="w-3/4 flex items-center gap-4 mb-4 self-end flex-row-reverse">
                <div className="w-8 h-8 rounded-full bg-white/20" />
                <div className="flex-1 bg-indigo-500/20 h-16 rounded-2xl" />
              </div>
              <div className="w-4/5 flex items-center gap-4 mb-4">
                <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center">
                  <div className="w-6 h-6 rounded-full bg-indigo-400" />
                </div>
                <div className="flex-1 bg-white/10 h-24 rounded-2xl" />
              </div>
              
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
