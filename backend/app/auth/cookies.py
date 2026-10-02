from datetime import timedelta
from fastapi import Response
from app.core.config import settings


def access_token_lifetime() -> timedelta:
    """Session lifetime shared by the JWT `exp` claim and the auth cookie."""
    return timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)


def set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.AUTH_COOKIE_NAME,
        value=token,
        max_age=int(access_token_lifetime().total_seconds()),
        path=settings.AUTH_COOKIE_PATH,
        httponly=True,
        secure=settings.AUTH_COOKIE_SECURE,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )


def clear_auth_cookie(response: Response) -> None:
    # Attributes must match those used when the cookie was set, or browsers keep the old cookie
    response.delete_cookie(
        key=settings.AUTH_COOKIE_NAME,
        path=settings.AUTH_COOKIE_PATH,
        httponly=True,
        secure=settings.AUTH_COOKIE_SECURE,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
