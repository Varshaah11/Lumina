/**
 * sanitizeTextForTTS: currency must survive (the backend normalizes "$5" -> "5 dollars"),
 * while real inline LaTeX is still converted to speakable text.
 * Migrated 1:1 from the former custom harness scripts/test_speech_sanitizer.ts (20 checks).
 */
import { describe, expect, it } from "vitest";
import { sanitizeTextForTTS } from "@/lib/speechSanitizer";

type Case = { name: string; input: string; expected: string };

// Ordinary currency: dollar signs must be preserved
const currency: Case[] = [
  { name: "single amount", input: "$5", expected: "$5" },
  { name: "two digits", input: "$10", expected: "$10" },
  { name: "two amounts joined by 'and'", input: "$5 and $10", expected: "$5 and $10" },
  { name: "currency in a sentence", input: "I paid $50", expected: "I paid $50" },
  { name: "decimal price", input: "$5.99", expected: "$5.99" },
  { name: "decimal price in sentence", input: "It costs $5.99 today.", expected: "It costs $5.99 today." },
  { name: "range with 'to'", input: "Prices run from $5 to $10 per month.", expected: "Prices run from $5 to $10 per month." },
  { name: "comma separated amounts", input: "Plans are $5, $10, and $20.", expected: "Plans are $5, $10, and $20." },
  { name: "dash range", input: "Budget of $5-$10", expected: "Budget of $5-$10" },
  { name: "thousands", input: "Revenue was $1,200 and costs were $800.", expected: "Revenue was $1,200 and costs were $800." },
  { name: "currency across words", input: "He paid $50 for the book and $20 for the pen.", expected: "He paid $50 for the book and $20 for the pen." },
];

// Legitimate LaTeX: delimiters removed, content kept/converted
const latex: Case[] = [
  { name: "inline variable power", input: "The area is $x^2$ here.", expected: "The area is x 2 here." },
  { name: "inline factorial", input: "We compute $n!$ next.", expected: "We compute n factorial next." },
  { name: "inline equation", input: "Use $a + b = c$ always.", expected: "Use a + b = c always." },
  { name: "inline frac", input: "Half is $\\frac{1}{2}$ exactly.", expected: "Half is 1 over 2 exactly." },
  { name: "inline sqrt", input: "Take $\\sqrt{x}$ now.", expected: "Take square root of x now." },
  { name: "inline starting with a digit", input: "Then $2 \\times 3$ equals six.", expected: "Then 2 times 3 equals six." },
  { name: "display math", input: "Result: $$5! = 120$$ done", expected: "Result: 5 factorial = 120 done" },
  { name: "bracket math", input: "See \\(n!\\) here", expected: "See n factorial here" },
];

const mixed: Case[] = [
  { name: "currency and LaTeX together", input: "It costs $5 and $10, and the area is $x^2$.", expected: "It costs $5 and $10, and the area is x 2." },
];

describe("sanitizeTextForTTS", () => {
  describe.each([
    ["currency keeps its dollar signs", currency],
    ["LaTeX becomes speakable text", latex],
    ["currency and LaTeX mixed", mixed],
  ])("%s", (_group, cases) => {
    it.each(cases)("$name", ({ input, expected }) => {
      expect(sanitizeTextForTTS(input)).toBe(expected);
    });
  });
});
