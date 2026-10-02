// Test-only stand-in for next/navigation (see mic_test_support.ts); records router.push targets
module.exports = {
  useRouter: () => ({
    push(p) { (globalThis.__routerPushes = globalThis.__routerPushes || []).push(p); },
    replace() {}, back() {}, refresh() {}, prefetch() {},
  }),
};
