import { useSyncExternalStore } from "react";

/** The neutral greeting rendered on the server (and during hydration), where the visitor's local time is unknown. */
export const SERVER_GREETING = "Good day";

export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const subscribe = () => () => {};

/**
 * "Good morning/afternoon/evening" for the browser's local time. Prerendered pages get SERVER_GREETING first, so
 * hydration never mismatches; the local greeting replaces it right after hydration (and immediately on client renders).
 */
export function useTimeOfDayGreeting(): string {
  return useSyncExternalStore(subscribe, () => greetingForHour(new Date().getHours()), () => SERVER_GREETING);
}
