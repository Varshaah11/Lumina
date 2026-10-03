/**
 * Stand-in for "next/navigation". Use from a test file with:
 *   vi.mock("next/navigation", () => import("./support/nextNavigation"));
 * router.push targets are recorded in `routerPushes`; useSearchParams serves the live jsdom URL, so components re-render
 * with the new params when a test emulates a URL change.
 */
export const routerPushes: string[] = [];

export const useRouter = () => ({
  push(path: string) { routerPushes.push(path); },
  replace() {}, back() {}, refresh() {}, prefetch() {},
});

export const useSearchParams = () => ({ get: (key: string) => new URLSearchParams(window.location.search).get(key) });
