"use client";

import { Card, CardContent } from "@/components/ui/card";

export function Metrics() {
  const metrics = [
    { value: "10,000+", label: "Questions Answered" },
    { value: "99.9%", label: "Uptime" },
    { value: "50+", label: "AI Capabilities" },
    { value: "100%", label: "Free & Local" },
  ];

  return (
    <section className="py-12 border-y border-white/10 bg-black/50 backdrop-blur-md relative z-10">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {metrics.map((metric, index) => (
            <div key={index} className="flex flex-col items-center justify-center text-center p-4">
              <div className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-br from-indigo-400 to-purple-400 mb-2">
                {metric.value}
              </div>
              <div className="text-sm md:text-base text-gray-400 font-medium">
                {metric.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
