import { Sparkles, Globe, Mail, MessageCircle } from "lucide-react";
import Link from "next/link";
import { Separator } from "@/components/ui/separator";

export function Footer() {
  return (
    <footer className="bg-black pt-16 pb-8 border-t border-white/10">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
          <div className="md:col-span-1">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-bold tracking-tight text-white">LUMINA</span>
            </Link>
            <p className="text-gray-400 text-sm mb-6">
              Your intelligent virtual assistant designed for the modern professional.
            </p>
            <div className="flex gap-4">
              <Link href="#" className="text-gray-400 hover:text-white transition-colors">
                <Globe className="w-5 h-5" />
                <span className="sr-only">Website</span>
              </Link>
              <Link href="#" className="text-gray-400 hover:text-white transition-colors">
                <Mail className="w-5 h-5" />
                <span className="sr-only">Contact</span>
              </Link>
              <Link href="#" className="text-gray-400 hover:text-white transition-colors">
                <MessageCircle className="w-5 h-5" />
                <span className="sr-only">Community</span>
              </Link>
            </div>
          </div>
          
          <div>
            <h4 className="text-white font-medium mb-4">Product</h4>
            <ul className="space-y-3">
              <li><Link href="#features" className="text-gray-400 hover:text-white text-sm transition-colors">Features</Link></li>
              <li><Link href="#pricing" className="text-gray-400 hover:text-white text-sm transition-colors">Pricing</Link></li>
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Changelog</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="text-white font-medium mb-4">Resources</h4>
            <ul className="space-y-3">
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Documentation</Link></li>
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Help Center</Link></li>
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Blog</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="text-white font-medium mb-4">Legal</h4>
            <ul className="space-y-3">
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Privacy Policy</Link></li>
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Terms of Service</Link></li>
              <li><Link href="#" className="text-gray-400 hover:text-white text-sm transition-colors">Cookie Policy</Link></li>
            </ul>
          </div>
        </div>
        
        <Separator className="bg-white/10 mb-8" />
        
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-gray-500 text-sm">
            © 2026 Lumina AI. All rights reserved.
          </p>
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <span>Designed with</span>
            <span className="text-red-500">♥</span>
            <span>for professionals</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
