from fastapi import APIRouter, Depends, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from app.database.session import get_db
from app.schemas.user import UserCreate, UserResponse
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
