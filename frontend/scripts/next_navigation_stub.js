// Test-only stand-in for next/navigation (see mic_test_support.ts)
module.exports = { useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }) };
