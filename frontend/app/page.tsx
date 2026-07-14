import { Navbar } from "@/components/Navbar";
import { Hero } from "@/components/Hero";
import { Metrics } from "@/components/Metrics";
import { HowItWorks } from "@/components/HowItWorks";
import { Features } from "@/components/Features";
import { About } from "@/components/About";
import { Testimonials } from "@/components/Testimonials";
import { Pricing } from "@/components/Pricing";
import { FAQ } from "@/components/FAQ";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white selection:bg-indigo-500/30">
      <Navbar />
      <main>
        <Hero />
        <Metrics />
        <HowItWorks />
        <Features />
        <About />
        <Testimonials />
        <Pricing />
        <FAQ />
      </main>
      <Footer />
    </div>
  );
}
