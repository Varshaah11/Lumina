/**
 * Tests for sanitizeTextForTTS: currency must survive (the backend normalizes "$5" -> "5 dollars"),
 * while real inline LaTeX is still converted to speakable text.
 *
 * Run (no test runner is installed, so compile with tsc, then run with node):
 *   npx tsc scripts/test_speech_sanitizer.ts --outDir /tmp/lumina-sanitizer-test --module commonjs --target es2020 --skipLibCheck --esModuleInterop
 *   node /tmp/lumina-sanitizer-test/scripts/test_speech_sanitizer.js
 */
import assert from "node:assert/strict";
import { sanitizeTextForTTS } from "../lib/speechSanitizer";

const cases: { name: string; input: string; expected: string }[] = [
  // --- Ordinary currency: dollar signs must be preserved ---
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

  // --- Legitimate LaTeX: delimiters removed, content kept/converted ---
  { name: "inline variable power", input: "The area is $x^2$ here.", expected: "The area is x 2 here." },
  { name: "inline factorial", input: "We compute $n!$ next.", expected: "We compute n factorial next." },
  { name: "inline equation", input: "Use $a + b = c$ always.", expected: "Use a + b = c always." },
  { name: "inline frac", input: "Half is $\\frac{1}{2}$ exactly.", expected: "Half is 1 over 2 exactly." },
  { name: "inline sqrt", input: "Take $\\sqrt{x}$ now.", expected: "Take square root of x now." },
  { name: "inline starting with a digit", input: "Then $2 \\times 3$ equals six.", expected: "Then 2 times 3 equals six." },
  { name: "display math", input: "Result: $$5! = 120$$ done", expected: "Result: 5 factorial = 120 done" },
  { name: "bracket math", input: "See \\(n!\\) here", expected: "See n factorial here" },

  // --- Mixed ---
  { name: "currency and LaTeX together", input: "It costs $5 and $10, and the area is $x^2$.", expected: "It costs $5 and $10, and the area is x 2." },
];

let failed = 0;
for (const c of cases) {
  const actual = sanitizeTextForTTS(c.input);
  try {
    assert.equal(actual, c.expected);
    console.log(`  [PASS] ${c.name}: ${JSON.stringify(c.input)} -> ${JSON.stringify(actual)}`);
  } catch {
    failed++;
    console.log(`  [FAIL] ${c.name}: ${JSON.stringify(c.input)}\n         expected ${JSON.stringify(c.expected)}\n         actual   ${JSON.stringify(actual)}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
