from typing import Literal
from pydantic import Field, field_validator, model_validator
from app.core.cors import DEFAULT_CORS_ORIGINS, parse_cors_origins
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    PROJECT_NAME: str = "Lumina AI"
    
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    # Single source of truth for session lifetime: used for the JWT `exp` claim AND the auth cookie Max-Age.
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080 # 7 days by default

    # Authentication cookie (HttpOnly is always on and not configurable)
    AUTH_COOKIE_NAME: str = "token"
    AUTH_COOKIE_SECURE: bool = False  # set True when served over HTTPS (production)
    AUTH_COOKIE_SAMESITE: Literal["lax", "strict", "none"] = "lax"
    AUTH_COOKIE_PATH: str = "/"

    # Login brute-force protection (in-process, per server instance)
    LOGIN_MAX_FAILED_ATTEMPTS: int = 5            # failed logins per (email, client IP) before lockout
    LOGIN_MAX_FAILED_ATTEMPTS_PER_IP: int = 20    # failed logins per client IP (any email) before lockout
    LOGIN_ATTEMPT_WINDOW_SECONDS: int = 900       # failures older than this are forgotten
    LOGIN_LOCKOUT_SECONDS: int = 900              # how long a locked key is rejected with HTTP 429
    
    # Max characters accepted by POST /tts (raw request text). Longer text is rejected, never truncated.
    # 2000 covers a typical assistant answer read aloud in one request while bounding CPU time per request:
    # measured on the dev machine, synthesis runs at roughly 0.6x real time (5000 chars took ~175s of CPU).
    KOKORO_MAX_TEXT_LENGTH: int = Field(default=2000, ge=1)
    # Kokoro TTS voice and CPU threads per ONNX worker session (worker count and pool timeout stay in KOKORO_CONCURRENCY / KOKORO_POOL_TIMEOUT)
    KOKORO_VOICE: str = "af_sarah"
    KOKORO_THREADS: int = Field(default=4, ge=1)

    # Max size of one uploaded document. 10 MB matches the frontend picker limit and comfortably fits the supported
    # formats (PDF/DOCX/TXT/MD); extracted text is capped far lower by chunking/retrieval anyway.
    MAX_UPLOAD_SIZE_MB: float = Field(default=10, gt=0)

    # Comma-separated browser origins allowed to call the API with credentials (the HttpOnly auth cookie).
    # Default = the local Next.js dev servers. Wildcards are rejected; invalid values stop startup.
    CORS_ORIGINS: str = DEFAULT_CORS_ORIGINS

    DATABASE_URL: str
    OLLAMA_HOST: str = "http://localhost:11434"
    OLLAMA_NUM_CTX: int = 8192
    # Chat models: the strong model handles coding/reasoning/document tasks, the fast model handles general chat,
    # voice and titles and is the fallback when the strong one is missing or fails.
    OLLAMA_PRIMARY_MODEL: str = "llama3.1:8b"
    OLLAMA_FALLBACK_MODEL: str = "llama3.2:3b"
    EMBEDDING_MODEL: str = "nomic-embed-text"
    
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def cors_origins(self) -> list[str]:
        return parse_cors_origins(self.CORS_ORIGINS)

    @field_validator("CORS_ORIGINS")
    @classmethod
    def _check_cors_origins(cls, v: str) -> str:
        # Field-level on purpose: a failing model-level validator prints every setting (including SECRET_KEY)
        parse_cors_origins(v)  # fail at startup on a malformed CORS_ORIGINS
        return v

    @model_validator(mode="after")
    def _check_cookie_settings(self):
        if self.AUTH_COOKIE_SAMESITE == "none" and not self.AUTH_COOKIE_SECURE:
            raise ValueError("AUTH_COOKIE_SAMESITE=none requires AUTH_COOKIE_SECURE=true")
        if self.ACCESS_TOKEN_EXPIRE_MINUTES <= 0:
            raise ValueError("ACCESS_TOKEN_EXPIRE_MINUTES must be positive")
        return self

settings = Settings()
