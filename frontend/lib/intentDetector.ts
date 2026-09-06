export type IntentType =
  | "CHAT"
  | "DOCUMENT"
  | "SUMMARIZE"
  | "NOTES"
  | "EXPLAIN"
  | "QUIZ"
  | "NAVIGATION"
  | "SEARCH"
  | "REMINDER"
  | "SETTINGS";

export interface IntentResult {
  intent: IntentType;
  feedbackText?: string;
  navTarget?: string;
  formattedPrompt?: string;
  requiresDocument?: boolean;
}

export function detectIntent(rawText: string, hasDocument: boolean = false): IntentResult {
  const text = rawText.trim().toLowerCase();

  if (!text) {
    return { intent: "CHAT" };
  }

  // 1. Navigation Intents
  if (/(open|show|go to|view) (my )?history|view history|chat history|^history$/i.test(text)) {
    return {
      intent: "NAVIGATION",
      navTarget: "/history",
      feedbackText: "✓ Opening History",
    };
  }

  if (/(start|open|create) (a )?new chat|new conversation|^new chat$/i.test(text)) {
    return {
      intent: "NAVIGATION",
      navTarget: "/chat",
      feedbackText: "✓ Starting New Chat",
    };
  }

  if (/(open|show|go to) (my )?settings|^settings$/i.test(text)) {
    return {
      intent: "NAVIGATION",
      navTarget: "/settings",
      feedbackText: "✓ Opening Settings",
    };
  }

  if (/(open|show|go to) (my )?profile|^profile$/i.test(text)) {
    return {
      intent: "NAVIGATION",
      navTarget: "/profile",
      feedbackText: "✓ Opening Profile",
    };
  }

  if (/(open|show|go to) (my )?dashboard|command center|^dashboard$/i.test(text)) {
    return {
      intent: "NAVIGATION",
      navTarget: "/dashboard",
      feedbackText: "✓ Opening Dashboard",
    };
  }

  // 2. Document-Specific Action Intents
  if (/quiz me|start quiz|test me|ask me questions|create a quiz/i.test(text)) {
    return {
      intent: "QUIZ",
      feedbackText: "🎯 Starting Quiz",
      formattedPrompt: "Quiz me on this document with 5 questions. Ask one question at a time.",
      requiresDocument: true,
    };
  }

  if (/study notes|make notes|create notes|exam notes/i.test(text)) {
    return {
      intent: "NOTES",
      feedbackText: "📝 Creating Study Notes",
      formattedPrompt: "Create exam-ready study notes from this document.",
      requiresDocument: true,
    };
  }

  if (/summarize|key points|give me a summary|summary of this/i.test(text)) {
    return {
      intent: "SUMMARIZE",
      feedbackText: "📄 Summarizing Document",
      formattedPrompt: "Summarize this document in 5 key points.",
      requiresDocument: true,
    };
  }

  if (/explain this document|explain the file|explain the contents/i.test(text)) {
    return {
      intent: "EXPLAIN",
      feedbackText: "💡 Explaining Content",
      formattedPrompt: "Explain the contents of this document like I am a beginner.",
      requiresDocument: true,
    };
  }

  // General Explain (e.g. "Explain recursion")
  if (/^explain /i.test(text)) {
    return {
      intent: "EXPLAIN",
      feedbackText: "💡 Explaining Concept",
    };
  }

  // 3. Settings Intent
  if (/change theme|toggle dark mode|notifications/i.test(text)) {
    return {
      intent: "SETTINGS",
      navTarget: "/settings",
      feedbackText: "⚙️ Adjusting Settings",
    };
  }

  // Default to standard LLM Chat pipeline
  return {
    intent: "CHAT",
  };
}
