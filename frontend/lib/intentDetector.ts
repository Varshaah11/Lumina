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

  if (/(open|show|go to) (my )?(settings|profile)|^settings$|^profile$/i.test(text)) {
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
    // Preserve natural user parameters (e.g., "Quiz me on chapter 3 with 10 questions")
    // If the user's prompt already contains specific instructions/parameters, preserve it.
    // Otherwise fallback to standard single-question prompt.
    const hasCustomParameters =
      /\d+\s*(questions|qs)|chapter|topic|level|hard|easy|medium|multiple choice|mcq/i.test(rawText);
    const formattedPrompt = hasCustomParameters
      ? `${rawText.trim()} Ask one question at a time and wait for my answer.`
      : "Quiz me on this document with 5 questions. Ask one question at a time.";

    return {
      intent: "QUIZ",
      feedbackText: "🎯 Starting Quiz",
      formattedPrompt,
      requiresDocument: true,
    };
  }

  if (/study notes|make notes|create notes|exam notes/i.test(text)) {
    const hasCustomParameters =
      /chapter|section|topic|bullet|concise|detailed|in-depth|summary/i.test(rawText);
    const formattedPrompt = hasCustomParameters
      ? `${rawText.trim()}`
      : "Create exam-ready study notes from this document.";

    return {
      intent: "NOTES",
      feedbackText: "📝 Creating Study Notes",
      formattedPrompt,
      requiresDocument: true,
    };
  }

  if (/summarize|key points|give me a summary|summary of this/i.test(text)) {
    const hasCustomParameters =
      /\d+\s*(points|bullets|paragraphs|words|sentences)|chapter|short|detailed/i.test(rawText);
    const formattedPrompt = hasCustomParameters
      ? `${rawText.trim()}`
      : "Summarize this document in 5 key points.";

    return {
      intent: "SUMMARIZE",
      feedbackText: "📄 Summarizing Document",
      formattedPrompt,
      requiresDocument: true,
    };
  }

  if (/explain this document|explain the file|explain the contents/i.test(text)) {
    const hasCustomParameters =
      /beginner|expert|simple|child|detail|briefly|section|chapter/i.test(rawText);
    const formattedPrompt = hasCustomParameters
      ? `${rawText.trim()}`
      : "Explain the contents of this document like I am a beginner.";

    return {
      intent: "EXPLAIN",
      feedbackText: "💡 Explaining Content",
      formattedPrompt,
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

  // 3. Settings Intent (Route to /profile as Lumina settings reside under Profile)
  if (/change theme|toggle dark mode|notifications|settings/i.test(text)) {
    return {
      intent: "SETTINGS",
      navTarget: "/profile",
      feedbackText: "⚙️ Opening Profile & Settings",
    };
  }

  // Default to standard LLM Chat pipeline
  return {
    intent: "CHAT",
  };
}
