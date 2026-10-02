/**
 * Diagnostic logging switch. Voice traces are noisy and can include what the user said, so they are on in development
 * and off in production builds unless NEXT_PUBLIC_DEBUG_VOICE=true is set. Warnings and errors always use console.warn/error.
 */
export const DEBUG_ENABLED =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEBUG_VOICE === "true";

export function debugLog(...args: unknown[]): void {
  if (DEBUG_ENABLED) console.log(...args);
}
