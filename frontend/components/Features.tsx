import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Mic, Brain, FileText, Image as ImageIcon, Code, History, Settings, Download } from "lucide-react";

export function Features() {
  const categories = [
    {
      title: "AI Assistant",
      description: "Core intelligence features that power your virtual assistant.",
      features: [
        { name: "Contextual Chat", icon: MessageSquare, desc: "Natural conversations with advanced reasoning." },
        { name: "Persistent Memory", icon: Brain, desc: "Remembers past interactions and preferences." },
        { name: "Voice Assistant", icon: Mic, desc: "High-quality speech-to-text and text-to-speech." }
      ]
    },
    {
      title: "Productivity",
      description: "Tools to accelerate your workflow and analyze data.",
      features: [
        { name: "PDF Analysis", icon: FileText, desc: "Extract insights and summarize complex documents." },
        { name: "Image Understanding", icon: ImageIcon, desc: "Analyze visual data and extract text from images." },
        { name: "Code Generation", icon: Code, desc: "Write, review, and debug code in multiple languages." }
      ]
    },
    {
      title: "Personalization",
      description: "Customize Lumina to fit exactly how you work.",
      features: [
        { name: "Chat History", icon: History, desc: "Seamlessly search and resume previous conversations." },
        { name: "User Preferences", icon: Settings, desc: "Tailor the AI's tone, verbosity, and format." },
        { name: "Export Data", icon: Download, desc: "Export your chats and insights to markdown or PDF." }
      ]
    }
  ];

  return (
    <section id="features" className="py-24 bg-black relative">
      <div className="max-w-7xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4">Powerful Features</h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg">
            Organized to help you work faster, smarter, and with complete context.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {categories.map((category, idx) => (
            <Card key={idx} className="bg-white/5 border-white/10 backdrop-blur-sm overflow-hidden flex flex-col">
              <CardHeader className="border-b border-white/5 bg-white/[0.02]">
                <CardTitle className="text-xl text-white">{category.title}</CardTitle>
                <p className="text-sm text-gray-400">{category.description}</p>
              </CardHeader>
              <CardContent className="p-6 flex-1 flex flex-col gap-6">
                {category.features.map((feature, fIdx) => {
                  const Icon = feature.icon;
                  return (
                    <div key={fIdx} className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Icon className="w-5 h-5 text-indigo-400" />
                      </div>
                      <div>
                        <h4 className="text-white font-medium mb-1">{feature.name}</h4>
                        <p className="text-sm text-gray-400 leading-relaxed">{feature.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
