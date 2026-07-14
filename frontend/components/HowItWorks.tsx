import { Card, CardContent } from "@/components/ui/card";
import { UploadCloud, MessageSquareText, Zap, ArrowRight } from "lucide-react";

export function HowItWorks() {
  const steps = [
    {
      icon: UploadCloud,
      title: "Upload Documents",
      description: "Securely upload your PDFs, images, or text files to your private workspace.",
      color: "text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      icon: MessageSquareText,
      title: "Ask Anything",
      description: "Use text or voice to ask questions about your documents or any general topic.",
      color: "text-purple-400",
      bg: "bg-purple-500/10",
    },
    {
      icon: Zap,
      title: "Receive Answers",
      description: "Get instant, personalized, and context-aware responses powered by local AI.",
      color: "text-indigo-400",
      bg: "bg-indigo-500/10",
    },
  ];

  return (
    <section className="py-24 bg-black relative">
      <div className="max-w-7xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4">How It Works</h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg">
            Experience a seamless workflow designed to boost your productivity.
          </p>
        </div>

        <div className="flex flex-col md:flex-row items-center justify-center gap-8 relative">
          {/* Connecting lines for desktop */}
          <div className="hidden md:block absolute top-1/2 left-[15%] right-[15%] h-0.5 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-y-1/2" />

          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <div key={index} className="flex flex-col items-center relative z-10 w-full md:w-1/3 group">
                <div className={`w-20 h-20 rounded-2xl flex items-center justify-center mb-6 border border-white/5 backdrop-blur-md transition-all duration-300 group-hover:scale-110 group-hover:-translate-y-2 ${step.bg}`}>
                  <Icon className={`w-10 h-10 ${step.color}`} />
                </div>
                <h3 className="text-xl font-bold text-white mb-3 text-center">{step.title}</h3>
                <p className="text-gray-400 text-center px-4 leading-relaxed">
                  {step.description}
                </p>
                {index < steps.length - 1 && (
                  <ArrowRight className="w-6 h-6 text-white/20 absolute -bottom-10 md:hidden" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
