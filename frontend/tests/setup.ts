/**
 * Shared Vitest setup: only hygiene every test file needs.
 * Browser API fakes (Audio, SpeechRecognition, fetch, ...) belong in the tests that use them, or in tests/support/.
 */
import { afterEach, vi } from "vitest";

// Tells React the tests drive updates through act(), as a test environment should
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  // A test that switched to fake timers must not leave them on for the next one (no config option covers this)
  vi.useRealTimers();
});
