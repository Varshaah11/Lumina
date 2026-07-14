import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function Testimonials() {
  const testimonials = [
    {
      name: "Alex Rivera",
      role: "Senior Data Analyst",
      content: "Lumina helped me summarize over 120 pages of documentation before my interview. What used to take a full weekend took exactly 15 minutes.",
      initials: "AR",
    },
    {
      name: "Sarah Jenkins",
      role: "Frontend Developer",
      content: "The voice assistant made learning new APIs much faster. I can literally walk around my room and talk through complex system architectures.",
      initials: "SJ",
    },
    {
      name: "Michael Chen",
      role: "Product Manager",
      content: "The memory feature remembers my coding preferences, saving me from repeating context. It just knows how I like my SQL queries formatted.",
      initials: "MC",
    },
    {
      name: "Elena Rostova",
      role: "Legal Consultant",
      content: "The document analysis feature reduced hours of manual reading into minutes. It accurately pulled specific clauses from 50-page contracts.",
      initials: "ER",
    },
  ];

  return (
    <section className="py-24 bg-black relative">
      <div className="max-w-7xl mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4">Loved by early adopters</h2>
          <p className="text-gray-400 max-w-2xl mx-auto text-lg">
            See what professionals are saying about their experience with Lumina AI.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {testimonials.map((testimonial, index) => (
            <Card key={index} className="bg-white/5 border-white/10 backdrop-blur-sm flex flex-col">
              <CardHeader className="flex flex-row items-center gap-4 pb-4">
                <Avatar>
                  <AvatarImage src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${testimonial.name}`} alt={testimonial.name} />
                  <AvatarFallback className="bg-indigo-500 text-white">{testimonial.initials}</AvatarFallback>
                </Avatar>
                <div>
                  <h4 className="text-white font-medium text-sm">{testimonial.name}</h4>
                  <p className="text-xs text-gray-400">{testimonial.role}</p>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-gray-300 text-sm leading-relaxed italic">
                  "{testimonial.content}"
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
