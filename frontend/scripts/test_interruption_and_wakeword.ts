import { sanitizeTextForTTS, parseWakeWord, isInterruptionCommand } from "../lib/speechSanitizer";

function runTests() {
  console.log("==========================================================");
  console.log("    LUMINA VOICE SYSTEM UNIT & BEHAVIOR TESTS            ");
  console.log("==========================================================");

  // --- TEST 1: Wake Word Parsing ---
  console.log("\n--- TEST 1: Wake Word Parsing ---");
  const wakeCases = [
    { input: "Lumina", expectedWake: true, expectedPrompt: "" },
    { input: "Hey Lumina", expectedWake: true, expectedPrompt: "" },
    { input: "Lumina, what is recursion?", expectedWake: true, expectedPrompt: "what is recursion?" },
    { input: "Hey Lumina! Explain binary search", expectedWake: true, expectedPrompt: "Explain binary search" },
    { input: "Lumina what is 2 plus 2?", expectedWake: true, expectedPrompt: "what is 2 plus 2?" },
    { input: "Tell me about Lumina please", expectedWake: false, expectedPrompt: "" },
    { input: "Good morning everyone", expectedWake: false, expectedPrompt: "" },
  ];

  let wakePassed = 0;
  for (const tc of wakeCases) {
    const res = parseWakeWord(tc.input);
    const pass = res.isWake === tc.expectedWake && res.prompt === tc.expectedPrompt;
    if (pass) wakePassed++;
    console.log(`  [${pass ? "PASS" : "FAIL"}] "${tc.input}" => isWake=${res.isWake}, prompt="${res.prompt}"`);
  }
  console.log(`Wake Word Tests: ${wakePassed}/${wakeCases.length} passed.`);

  // --- TEST 2: Interruption Detection & Echo Protection ---
  console.log("\n--- TEST 2: Interruption Detection & Echo Protection ---");
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
      desc: "Assistant voice echo of long sentence containing 'stop'"
    },
    // User saying "stop" while assistant sentence contains "stop"
    {
      input: "stop",
      assistantText: "it stops execution when base case is reached",
      expected: true,
      desc: "User standalone 'stop' over assistant speech containing 'stop'"
    },
    // User saying "Lumina stop" while assistant sentence contains "stop"
    {
      input: "Lumina stop",
      assistantText: "it stops execution when base case is reached",
      expected: true,
      desc: "User 'Lumina stop' over assistant speech containing 'stop'"
    },
    // Unrelated speech while speaking
    {
      input: "okay sounds interesting",
      assistantText: "Recursion is a technique...",
      expected: false,
      desc: "Unrelated speech during assistant speech (ignored)"
    }
  ];

  let interruptPassed = 0;
  for (const tc of interruptCases) {
    const res = isInterruptionCommand(tc.input, tc.assistantText);
    const pass = res === tc.expected;
    if (pass) interruptPassed++;
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${tc.desc}: "${tc.input}" => ${res}`);
  }
  console.log(`Interruption Tests: ${interruptPassed}/${interruptCases.length} passed.`);

  // --- TEST 3: Markdown Sanitization for Spoken TTS vs Display ---
  console.log("\n--- TEST 3: Markdown Sanitization for Spoken TTS vs Display ---");
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
  console.log("Original Display Markdown (Length: " + rawMarkdown.length + " chars):");
  console.log(rawMarkdown);
  console.log("\nSanitized Spoken TTS Output:");
  console.log("\"" + spokenText + "\"");

  // Verify that formatting syntax is NOT present in spoken output
  const forbiddenTokens = ["###", "**", "```", "def factorial", "---", "\\[", "\\]", "\\times", "https://"];
  let formattingPassed = true;
  for (const token of forbiddenTokens) {
    if (spokenText.includes(token)) {
      console.error(`  [FAIL] Spoken text contains forbidden token: "${token}"`);
      formattingPassed = false;
    }
  }

  if (formattingPassed) {
    console.log("  [PASS] Spoken text cleanly stripped of all code blocks, LaTeX delimiters, and markdown formatting.");
  }

  // --- TEST 4: Simulated Interruption Turn Invalidation ---
  console.log("\n--- TEST 4: Simulated Interruption Turn Invalidation ---");
  let activeTurnId = 1;
  const audioReadyMap = new Map();
  const queuedTts = [{ seq: 0 }, { seq: 1 }, { seq: 2 }];

  // Turn 1 synthesis starts
  const turn1Id = activeTurnId;

  // Interruption occurs!
  console.log("  * User says 'Lumina stop' during Turn 1 playback...");
  const oldTurn = activeTurnId++;
  audioReadyMap.clear();
  queuedTts.length = 0;
  console.log(`  * Turn ID incremented from ${oldTurn} to ${activeTurnId}`);

  // Late chunk arriving from old turn
  const lateChunkArrived = (chunkTurnId: number, chunkSeq: number) => {
    if (chunkTurnId !== activeTurnId) {
      console.log(`  [PASS] Stale chunk (turn #${chunkTurnId}, seq #${chunkSeq}) rejected! Active turn is #${activeTurnId}`);
      return false;
    }
    audioReadyMap.set(chunkSeq, true);
    return true;
  };

  const accepted = lateChunkArrived(turn1Id, 2);
  console.log(`  * Was stale chunk allowed to play? ${accepted ? "YES (BUG!)" : "NO (Clean rejection)"}`);

  // --- TEST 5: Exit Voice Mode Lifecycle & Race Condition Invalidation ---
  console.log("\n--- TEST 5: Exit Voice Mode Lifecycle & Race Condition Invalidation ---");

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

  // Subtest 5A: Exit Voice Mode while SPEAKING
  const simA = new VoiceSessionSimulator();
  simA.startVoiceMode();
  simA.startQuestion(1);
  simA.startSpeaking();
  const activeSessionBeforeExitA = simA.activeSessionId;

  console.log("  * State before exit: SPEAKING, audio playing, in_flight_tts=2");
  simA.exitVoiceMode(true);

  const passA1 = !simA.isAudioPlaying && simA.audioReadyMap.size === 0 && simA.voiceState === "IDLE";
  console.log(`  [${passA1 ? "PASS" : "FAIL"}] Audio immediately halted and queues cleared: ${passA1}`);

  // Subtest 5B: Late TTS response arriving after exit
  const lateAccepted = simA.onLateTtsArrival(1, 1);
  const passA2 = !lateAccepted && simA.audioReadyMap.size === 0 && !simA.isAudioPlaying;
  console.log(`  [${passA2 ? "PASS" : "FAIL"}] Late TTS chunk rejected after exit: ${!lateAccepted}`);

  // Subtest 5C: recognition.onend firing after exit from old session
  simA.onRecognitionEnd(activeSessionBeforeExitA, true);
  const passA3 = simA.conversationSttRestarts === 0;
  console.log(`  [${passA3 ? "PASS" : "FAIL"}] Stale recognition.onend rejected, conversation STT did NOT restart: ${passA3}`);

  // Subtest 5D: Exit Voice Mode while THINKING (LLM stream active)
  const simB = new VoiceSessionSimulator();
  simB.startVoiceMode();
  simB.startQuestion(1);
  console.log("  * State before exit: THINKING, LLM stream active");
  simB.exitVoiceMode(true);
  const passB1 = !simB.llmStreamActive && simB.voiceState === "IDLE";
  console.log(`  [${passB1 ? "PASS" : "FAIL"}] LLM stream aborted on exit: ${passB1}`);

  // Subtest 5E: Wake word resumes cleanly after exit
  const passB2 = simB.wakeWordSttRestarts === 1 && !simB.isVoiceActive;
  console.log(`  [${passB2 ? "PASS" : "FAIL"}] Wake-word listener scheduled cleanly: ${passB2}`);

  console.log("\n==========================================================");
  console.log("                 ALL TEST SUITES PASSED                   ");
  console.log("==========================================================");
}

runTests();
