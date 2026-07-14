import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export function FAQ() {
  const faqs = [
    {
      question: "What makes Lumina different from other AI assistants?",
      answer: "Lumina is designed with a focus on persistent memory and seamless document integration. Unlike standard chatbots that forget context between sessions, Lumina builds a personalized understanding of your workflow over time while maintaining strict privacy standards."
    },
    {
      question: "Is my data private and secure?",
      answer: "Yes. We take privacy seriously. Your conversations and uploaded documents are encrypted, and we do not use your personal data to train our foundational models without explicit consent."
    },
    {
      question: "What types of documents can I upload?",
      answer: "Currently, Lumina supports PDF, TXT, DOCX, and common image formats (PNG, JPEG). We are constantly working on adding support for more file types."
    },
    {
      question: "Can I use Lumina on my phone?",
      answer: "Absolutely! Lumina's web interface is fully responsive and optimized for mobile devices, so you can access your personalized assistant from anywhere."
    }
  ];

  return (
    <section id="faq" className="py-24 bg-black">
      <div className="max-w-3xl mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-5xl font-bold text-white mb-4">Frequently Asked Questions</h2>
          <p className="text-gray-400 text-lg">
            Got questions? We've got answers.
          </p>
        </div>

        <Accordion className="w-full space-y-4">
          {faqs.map((faq, index) => (
            <AccordionItem key={index} value={`item-${index}`} className="border-white/10 bg-white/5 px-6 rounded-lg data-[state=open]:bg-white/10 transition-colors border-b-0">
              <AccordionTrigger className="text-white hover:text-indigo-400 hover:no-underline text-left text-lg py-6">
                {faq.question}
              </AccordionTrigger>
              <AccordionContent className="text-gray-400 text-base pb-6 leading-relaxed">
                {faq.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
