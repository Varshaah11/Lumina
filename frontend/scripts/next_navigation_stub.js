// Test-only stand-in for next/navigation (see mic_test_support.ts); records router.push targets and serves the live
// search params of the jsdom URL (components re-render on URL changes in tests that emulate the router)
module.exports = {
  useRouter: () => ({
    push(p) { (globalThis.__routerPushes = globalThis.__routerPushes || []).push(p); },
    replace() {}, back() {}, refresh() {}, prefetch() {},
  }),
  useSearchParams: () => ({ get: (k) => new URLSearchParams(globalThis.window ? globalThis.window.location.search : "").get(k) }),
};
