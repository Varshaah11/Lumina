import { vi } from "vitest";

/**
 * Deterministic clock for timer-driven behavior: fakes only setTimeout/clearTimeout and Date, starting from the real
 * current time (so "time since epoch 0" checks such as debounces behave as in production). performance.now, promises,
 * setImmediate and React's scheduler keep running for real. tests/setup.ts restores real timers after every test.
 */
export function installFakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
}
