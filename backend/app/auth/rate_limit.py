"""
In-process login brute-force protection (no external services).

Two independent counters, both using a sliding failure window and a temporary lockout:
  * per (normalized email, client IP): stops password guessing against one account from one place,
    without letting an attacker lock a victim out from everywhere else.
  * per client IP: stops one client spraying guesses across many emails.
A successful login clears only the (email, IP) counter, so an attacker cannot reset the per-IP counter by logging
into their own account. State lives in memory and resets on restart; entries expire so memory stays bounded.
"""
import threading
import time
from collections import deque
from typing import Callable, Deque, Dict, Optional, Tuple

from app.core.config import settings


class LoginRateLimiter:
    def __init__(
        self,
        max_failed_attempts: int,
        max_failed_attempts_per_ip: int,
        window_seconds: float,
        lockout_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        sweep_interval_seconds: float = 60.0,
    ):
        self.max_failed_attempts = max_failed_attempts
        self.max_failed_attempts_per_ip = max_failed_attempts_per_ip
        self.window_seconds = window_seconds
        self.lockout_seconds = lockout_seconds
        self._clock = clock
        self._sweep_interval = sweep_interval_seconds
        self._last_sweep = clock()
        self._lock = threading.Lock()
        # key -> [failure timestamps, locked_until]
        self._pair: Dict[Tuple[str, str], list] = {}
        self._ip: Dict[str, list] = {}

    @classmethod
    def from_settings(cls) -> "LoginRateLimiter":
        return cls(
            max_failed_attempts=settings.LOGIN_MAX_FAILED_ATTEMPTS,
            max_failed_attempts_per_ip=settings.LOGIN_MAX_FAILED_ATTEMPTS_PER_IP,
            window_seconds=settings.LOGIN_ATTEMPT_WINDOW_SECONDS,
            lockout_seconds=settings.LOGIN_LOCKOUT_SECONDS,
        )

    # -- internals (call with lock held) --
    def _entry(self, table: dict, key) -> list:
        entry = table.get(key)
        if entry is None:
            entry = [deque(), 0.0]
            table[key] = entry
        return entry

    def _prune(self, entry: list, now: float) -> None:
        failures: Deque[float] = entry[0]
        while failures and now - failures[0] > self.window_seconds:
            failures.popleft()

    def _retry_after(self, table: dict, key, now: float) -> int:
        entry = table.get(key)
        if not entry:
            return 0
        remaining = entry[1] - now
        return int(remaining) + 1 if remaining > 0 else 0

    def _record(self, table: dict, key, limit: int, now: float) -> None:
        entry = self._entry(table, key)
        self._prune(entry, now)
        entry[0].append(now)
        if len(entry[0]) >= limit:
            entry[1] = now + self.lockout_seconds
            entry[0].clear()

    def _sweep(self, now: float) -> None:
        if now - self._last_sweep < self._sweep_interval:
            return
        self._last_sweep = now
        for table in (self._pair, self._ip):
            for key in list(table):
                entry = table[key]
                self._prune(entry, now)
                if not entry[0] and entry[1] <= now:
                    del table[key]

    # -- public API --
    def check(self, identifier: str, client_ip: str) -> int:
        """Returns 0 if the attempt may proceed, else the number of seconds to wait (HTTP Retry-After)."""
        with self._lock:
            now = self._clock()
            self._sweep(now)
            return max(
                self._retry_after(self._pair, (identifier, client_ip), now),
                self._retry_after(self._ip, client_ip, now),
            )

    def record_failure(self, identifier: str, client_ip: str) -> None:
        with self._lock:
            now = self._clock()
            self._record(self._pair, (identifier, client_ip), self.max_failed_attempts, now)
            self._record(self._ip, client_ip, self.max_failed_attempts_per_ip, now)

    def record_success(self, identifier: str, client_ip: str) -> None:
        with self._lock:
            self._pair.pop((identifier, client_ip), None)

    def failure_count(self, identifier: str, client_ip: str) -> int:
        with self._lock:
            entry = self._pair.get((identifier, client_ip))
            if not entry:
                return 0
            self._prune(entry, self._clock())
            return len(entry[0])

    def tracked_keys(self) -> int:
        with self._lock:
            return len(self._pair) + len(self._ip)

    def reset(self) -> None:
        with self._lock:
            self._pair.clear()
            self._ip.clear()


login_rate_limiter = LoginRateLimiter.from_settings()
