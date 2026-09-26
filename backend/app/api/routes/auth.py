from fastapi import APIRouter, Depends, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from app.database.session import get_db
from app.schemas.user import UserCreate, UserResponse, UserProfileUpdate
from app.schemas.auth import UserLogin
from app.schemas.token import Token
from app.services.auth_service import register_user, authenticate_user
from app.api.dependencies import get_current_user
from app.models.user import User

router = APIRouter()

@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(user_data: UserCreate, db: Session = Depends(get_db)):
    """
    Register a new user.
    """
    return register_user(db, user_data)

@router.post("/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """
    Authenticate user and return JWT access token.
    Compatible with standard OAuth2 form data (e.g., Swagger UI).
    """
    # Map the OAuth2 form 'username' field to our 'email' field
    login_data = UserLogin(email=form_data.username, password=form_data.password)
    return authenticate_user(db, login_data)

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
