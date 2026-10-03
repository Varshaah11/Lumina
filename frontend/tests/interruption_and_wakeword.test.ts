/**
 * Voice system unit & behavior tests: wake-word parsing, interruption detection with echo protection, TTS markdown
 * sanitization, and the turn/session invalidation rules (as a state-machine simulation mirroring useVoiceConversation).
 * Migrated from the former custom harness scripts/test_interruption_and_wakeword.ts (24 checks), which only printed PASS/FAIL; here every check
 * is a real assertion.
 */
import { describe, expect, it } from "vitest";
import { isInterruptionCommand, parseWakeWord, sanitizeTextForTTS } from "@/lib/speechSanitizer";

describe("wake word parsing", () => {
  const wakeCases = [
    { input: "Lumina", expectedWake: true, expectedPrompt: "" },
    { input: "Hey Lumina", expectedWake: true, expectedPrompt: "" },
    { input: "Lumina, what is recursion?", expectedWake: true, expectedPrompt: "what is recursion?" },
    { input: "Hey Lumina! Explain binary search", expectedWake: true, expectedPrompt: "Explain binary search" },
    { input: "Lumina what is 2 plus 2?", expectedWake: true, expectedPrompt: "what is 2 plus 2?" },
    { input: "Tell me about Lumina please", expectedWake: false, expectedPrompt: "" },
    { input: "Good morning everyone", expectedWake: false, expectedPrompt: "" },
  ];

  it.each(wakeCases)("$input", ({ input, expectedWake, expectedPrompt }) => {
    const res = parseWakeWord(input);
    expect({ isWake: res.isWake, prompt: res.prompt }).toStrictEqual({ isWake: expectedWake, prompt: expectedPrompt });
  });
});

describe("interruption detection & echo protection", () => {
  const interruptCases = [
    { input: "stop", assistantText: "Recursion is a technique...", expected: true, desc: "Simple 'stop'" },
    { input: "Lumina stop", assistantText: "Recursion is a technique...", expected: true, desc: "'Lumina stop'" },
    { input: "stop Lumina", assistantText: "Recursion is a technique...", expected: true, desc: "'stop Lumina'" },
    { input: "be quiet", assistantText: "Recursion is a technique...", expected: true, desc: "'be quiet'" },
    { input: "cancel", assistantText: "Recursion is a technique...", expected: true, desc: "'cancel'" },
    { input: "pause", assistantText: "Recursion is a technique...", expected: true, desc: "'pause'" },
    // Echo protection: assistant text contains the word "stop" in a long sentence
    {
      input: "it stops execution when base case is reached",
      assistantText: "it stops execution when base case is reached",
      expected: false,
      desc: "Assistant voice echo of long sentence containing 'stop'",
    },
    // User saying "stop" while assistant sentence contains "stop"
    {
      input: "stop",
      assistantText: "it stops execution when base case is reached",
      expected: true,
      desc: "User standalone 'stop' over assistant speech containing 'stop'",
    },
    // User saying "Lumina stop" while assistant sentence contains "stop"
    {
      input: "Lumina stop",
      assistantText: "it stops execution when base case is reached",
      expected: true,
      desc: "User 'Lumina stop' over assistant speech containing 'stop'",
    },
    // Unrelated speech while speaking
    {
      input: "okay sounds interesting",
      assistantText: "Recursion is a technique...",
      expected: false,
      desc: "Unrelated speech during assistant speech (ignored)",
    },
  ];

  it.each(interruptCases)("$desc", ({ input, assistantText, expected }) => {
    expect(isInterruptionCommand(input, assistantText)).toBe(expected);
  });
});

describe("markdown sanitization for spoken TTS vs display", () => {
  it("spoken text is cleanly stripped of code blocks, LaTeX delimiters and markdown formatting", () => {
    const rawMarkdown =
      "### Recursion Breakdown\n\n" +
      "**Recursion** is a programming technique.\n\n" +
      "```python\n" +
      "def factorial(n):\n" +
      "    if n <= 1: return 1\n" +
      "    return n * factorial(n - 1)\n" +
      "```\n\n" +
      "-------------------\n\n" +
      "- First point\n" +
      "- Second point\n\n" +
      "\\[ n! = n \\times (n - 1)! \\]\n\n" +
      "Visit [Lumina Docs](https://example.com) for details.";

    const spokenText = sanitizeTextForTTS(rawMarkdown);
    const forbiddenTokens = ["###", "**", "```", "def factorial", "---", "\\[", "\\]", "\\times", "https://"];
    expect(forbiddenTokens.filter((token) => spokenText.includes(token)), "forbidden tokens in spoken text").toStrictEqual([]);
  });
});

describe("simulated interruption turn invalidation", () => {
  it("a late chunk from the interrupted turn is rejected", () => {
    let activeTurnId = 1;
    const audioReadyMap = new Map<number, boolean>();
    const queuedTts = [{ seq: 0 }, { seq: 1 }, { seq: 2 }];

    // Turn 1 synthesis starts, then the user says 'Lumina stop' during playback
    const turn1Id = activeTurnId;
    activeTurnId++;
    audioReadyMap.clear();
    queuedTts.length = 0;

    const lateChunkArrived = (chunkTurnId: number, chunkSeq: number) => {
      if (chunkTurnId !== activeTurnId) return false;
      audioReadyMap.set(chunkSeq, true);
      return true;
    };

    expect(lateChunkArrived(turn1Id, 2), "stale chunk must not be allowed to play").toBe(false);
  });
});

describe("exit voice mode lifecycle & race condition invalidation", () => {
  // State simulation mirroring useVoiceConversation refs
  class VoiceSessionSimulator {
    isVoiceActive = false;
    activeSessionId = 0;
    activeTurnId = 0;
    voiceState: "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" = "IDLE";
    isAudioPlaying = false;
    audioReadyMap = new Map<number, string>();
    ttsQueue: number[] = [];
    inFlightTts = 0;
    abortedFetches = 0;
    llmStreamActive = false;
    conversationSttRestarts = 0;
    wakeWordSttRestarts = 0;

    startVoiceMode() {
      this.isVoiceActive = true;
      this.activeSessionId++;
      this.voiceState = "LISTENING";
    }

    startQuestion(turnId: number) {
      this.activeTurnId = turnId;
      this.voiceState = "THINKING";
      this.llmStreamActive = true;
      this.inFlightTts = 2;
      this.ttsQueue = [0, 1, 2];
    }

    startSpeaking() {
      this.voiceState = "SPEAKING";
      this.isAudioPlaying = true;
      this.audioReadyMap.set(0, "blob-url-0");
    }

    // Mirrors exitVoiceMode() exactly
    exitVoiceMode(enableWakeWord = true) {
      // 1. isVoiceActive = false FIRST
      this.isVoiceActive = false;

      // 2. Invalidate session & turn
      this.activeSessionId++;
      this.activeTurnId++;

      // 3. Audio cleanup
      this.isAudioPlaying = false;
      this.audioReadyMap.clear();
      this.ttsQueue = [];
      this.abortedFetches += this.inFlightTts;
      this.inFlightTts = 0;

      // 4. Abort LLM stream
      this.llmStreamActive = false;

      // 5. Reset state
      this.voiceState = "IDLE";

      // 6. Resume wake word if enabled
      if (enableWakeWord) {
        this.wakeWordSttRestarts++;
      }
    }

    // Late TTS Arrival handler
    onLateTtsArrival(turnId: number, seq: number): boolean {
      if (turnId !== this.activeTurnId || !this.isVoiceActive) {
        return false; // Rejected
      }
      this.audioReadyMap.set(seq, `blob-url-${seq}`);
      return true;
    }

    // recognition.onend handler
    onRecognitionEnd(endedSessionId: number, isLoopEnabled = true) {
      if (endedSessionId !== this.activeSessionId) {
        return; // Stale session ignored
      }

      if (this.isVoiceActive) {
        // Conversation STT restart
        if (isLoopEnabled && this.activeSessionId === endedSessionId && this.isVoiceActive) {
          this.conversationSttRestarts++;
        }
      } else {
        // Wake-word mode restart
        this.wakeWordSttRestarts++;
      }
    }
  }

  /** Scenario A: exit voice mode while SPEAKING (audio playing, 2 TTS requests in flight). */
  function exitWhileSpeaking() {
    const sim = new VoiceSessionSimulator();
    sim.startVoiceMode();
    sim.startQuestion(1);
    sim.startSpeaking();
    const sessionBeforeExit = sim.activeSessionId;
    sim.exitVoiceMode(true);
    return { sim, sessionBeforeExit };
  }

  /** Scenario B: exit voice mode while THINKING (LLM stream active). */
  function exitWhileThinking() {
    const sim = new VoiceSessionSimulator();
    sim.startVoiceMode();
    sim.startQuestion(1);
    sim.exitVoiceMode(true);
    return sim;
  }

  it("audio is immediately halted and queues cleared", () => {
    const { sim } = exitWhileSpeaking();
    expect(!sim.isAudioPlaying && sim.audioReadyMap.size === 0 && sim.voiceState === "IDLE").toBe(true);
  });

  it("a late TTS chunk is rejected after exit", () => {
    const { sim } = exitWhileSpeaking();
    const lateAccepted = sim.onLateTtsArrival(1, 1);
    expect(!lateAccepted && sim.audioReadyMap.size === 0 && !sim.isAudioPlaying).toBe(true);
  });

  it("a stale recognition.onend is rejected and conversation STT does not restart", () => {
    const { sim, sessionBeforeExit } = exitWhileSpeaking();
    sim.onLateTtsArrival(1, 1);
    sim.onRecognitionEnd(sessionBeforeExit, true);
    expect(sim.conversationSttRestarts).toBe(0);
  });

  it("the LLM stream is aborted on exit", () => {
    const sim = exitWhileThinking();
    expect(!sim.llmStreamActive && sim.voiceState === "IDLE").toBe(true);
  });

  it("the wake-word listener is scheduled cleanly after exit", () => {
    const sim = exitWhileThinking();
    expect(sim.wakeWordSttRestarts === 1 && !sim.isVoiceActive).toBe(true);
  });
});
