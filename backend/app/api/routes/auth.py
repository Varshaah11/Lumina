import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import ValidationError
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from app.database.session import get_db
from app.schemas.user import UserCreate, UserResponse, UserProfileUpdate
from app.schemas.auth import UserLogin
from app.schemas.token import LoginResponse
from app.schemas.user import normalize_email
from app.auth.cookies import set_auth_cookie, clear_auth_cookie
from app.auth import rate_limit
from app.services.auth_service import register_user, authenticate_user
from app.api.dependencies import get_current_user
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(user_data: UserCreate, db: Session = Depends(get_db)):
    """
    Register a new user.
    """
    return register_user(db, user_data)

@router.post("/login", response_model=LoginResponse)
def login(
    request: Request,
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """
    Authenticate user and set the JWT as an HttpOnly cookie.
    Compatible with standard OAuth2 form data (e.g., Swagger UI).
    Repeated failures are rate limited (HTTP 429).
    """
    limiter = rate_limit.login_rate_limiter
    client_ip = request.client.host if request.client else "unknown"
    identifier = normalize_email(form_data.username) or ""

    retry_after = limiter.check(identifier, client_ip)
    if retry_after:
        logger.warning(f"Login rate limit hit for client {client_ip}")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Please try again later.",
            headers={"Retry-After": str(retry_after)},
        )

    try:
        # Map the OAuth2 form 'username' field to our 'email' field
        login_data = UserLogin(email=form_data.username, password=form_data.password)
        token = authenticate_user(db, login_data)
    except (ValidationError, HTTPException) as exc:
        if isinstance(exc, HTTPException) and exc.status_code != status.HTTP_401_UNAUTHORIZED:
            raise
        limiter.record_failure(identifier, client_ip)
        # Same response for malformed email, unknown email and wrong password
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    limiter.record_success(identifier, client_ip)
    set_auth_cookie(response, token.access_token)
    return LoginResponse()

@router.post("/logout")
def logout(response: Response):
    """Clears the HttpOnly auth cookie. Safe to call without a valid session."""
    clear_auth_cookie(response)
    return {"message": "Logged out"}

@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    """
    Get the currently authenticated user's details.
    """
    return current_user

@router.get("/profile", response_model=UserResponse)
def get_profile(current_user: User = Depends(get_current_user)):
    """
    Get the currently authenticated user's profile details.
    Same payload as GET /auth/me; kept as an alias for API compatibility (used by scripts/test_profile_memory.py).
    """
    return current_user

@router.patch("/profile", response_model=UserResponse)
def update_profile(
    profile_data: UserProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Update the authenticated user's profile (name, location, bio).
    Strictly scoped to the authenticated JWT user.
    """
    if profile_data.name is not None:
        cleaned_name = profile_data.name.strip()
        if not cleaned_name:
            from fastapi import HTTPException
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Name cannot be empty or whitespace-only"
            )
        current_user.name = cleaned_name

    if profile_data.location is not None:
        cleaned_location = profile_data.location.strip()
        current_user.location = cleaned_location if cleaned_location else None

    if profile_data.bio is not None:
        cleaned_bio = profile_data.bio.strip()
        current_user.bio = cleaned_bio if cleaned_bio else None

    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return current_user
