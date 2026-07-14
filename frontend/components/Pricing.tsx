import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";

export function Pricing() {
  const tiers = [
    {
      name: "Free",
      price: "$0",
      description: "Perfect for getting started with AI assistance.",
      features: [
        "Basic AI Conversations",
        "Limited Memory (7 days)",
        "Standard Response Speed",
        "Community Support",
      ],
      buttonText: "Get Started",
      popular: false,
    },
    {
      name: "Pro",
      price: "$19",
      period: "/month",
      description: "For professionals who need more power and context.",
      features: [
        "Advanced LLM Access",
        "Unlimited Persistent Memory",
        "Full Document Analysis",
        "Voice Assistant Integration",
        "Priority Support",
      ],
      buttonText: "Coming Soon",
      popular: true,
      disabled: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      description: "For teams requiring custom integrations and security.",
      features: [
        "Everything in Pro",
        "Custom Model Fine-tuning",
        "SSO & Advanced Security",
        "Dedicated Account Manager",
        "On-premise Deployment Options",
      ],
      buttonText: "Coming Soon",
      popular: false,
      disabled: true,
    },
  ];

  return (
    <section id="pricing" className="py-24 bg-black relative">
      {/* Decorative background */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-500/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="max-w-7xl mx-auto px-6 relative z-10">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4">Simple, transparent pricing</h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg">
            Start for free, upgrade when you need more power. No hidden fees.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {tiers.map((tier) => (
            <Card 
              key={tier.name} 
              className={`bg-white/5 border-white/10 backdrop-blur-sm relative flex flex-col ${
                tier.popular ? 'border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.1)]' : ''
              }`}
            >
              {tier.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className="bg-indigo-500 hover:bg-indigo-600 text-white border-0 px-3 py-1 text-xs">
                    Most Popular
                  </Badge>
                </div>
              )}
              <CardHeader>
                <CardTitle className="text-2xl text-white">{tier.name}</CardTitle>
                <CardDescription className="text-gray-400 h-10">{tier.description}</CardDescription>
                <div className="mt-4 flex items-baseline text-white">
                  <span className="text-4xl font-bold tracking-tight">{tier.price}</span>
                  {tier.period && <span className="text-gray-400 ml-1">{tier.period}</span>}
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="space-y-4">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Check className="w-3 h-3 text-indigo-400" />
                      </div>
                      <span className="text-gray-300 text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Button 
                  className={`w-full rounded-full ${
                    tier.popular 
                      ? 'bg-indigo-500 hover:bg-indigo-600 text-white' 
                      : 'bg-white/10 hover:bg-white/20 text-white'
                  }`}
                  disabled={tier.disabled}
                >
                  {tier.buttonText}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
