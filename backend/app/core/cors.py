import re
from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

DEFAULT_CORS_ORIGINS = "http://localhost:3000,http://localhost:3001"

_ORIGIN_RE = re.compile(r"(https?)://([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?")


def parse_cors_origins(raw: str) -> List[str]:
    """
    Parses a comma-separated origin list (scheme://host[:port]) into normalized origins.
    Surrounding whitespace, empty items (e.g. a trailing comma) and trailing slashes are tolerated; scheme and host are
    lowercased; duplicates are dropped. Anything else (wildcards, paths, missing scheme, empty list) raises ValueError:
    a malformed value must fail loudly and never degrade into "allow everything".
    """
    items = [part.strip() for part in (raw or "").split(",")]
    items = [part for part in items if part]
    if not items:
        raise ValueError("CORS_ORIGINS must list at least one origin, e.g. http://localhost:3000")

    origins: List[str] = []
    for item in items:
        if "*" in item:
            raise ValueError(f"CORS_ORIGINS must not contain wildcards ({item!r}): credentialed requests need explicit origins")
        candidate = item.rstrip("/").lower()
        match = _ORIGIN_RE.fullmatch(candidate)
        if not match or (match.group(3) is not None and not 0 < int(match.group(3)) <= 65535):
            raise ValueError(f"Invalid CORS origin {item!r}: expected scheme://host[:port] with no path, e.g. https://app.example.com")
        if candidate not in origins:
            origins.append(candidate)
    return origins


def add_cors(app: FastAPI, origins: List[str]) -> None:
    """Credentialed CORS for exactly the given origins (the HttpOnly auth cookie must be sent cross-origin)."""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
