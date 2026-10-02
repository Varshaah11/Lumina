from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.models.user import User
from app.schemas.user import UserCreate
from app.schemas.auth import UserLogin
from app.schemas.token import Token
from app.auth.hashing import get_password_hash, verify_password
from app.auth.jwt import create_access_token

_DUMMY_HASH: str | None = None

def _dummy_hash() -> str:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = get_password_hash("lumina-dummy-password")
    return _DUMMY_HASH

def register_user(db: Session, user_data: UserCreate) -> User:
    # Check if user exists
    existing_user = db.query(User).filter(func.lower(User.email) == user_data.email).first()
    if existing_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )
    
    # Create new user
    hashed_password = get_password_hash(user_data.password)
    new_user = User(
        name=user_data.name,
        email=user_data.email,
        hashed_password=hashed_password
    )
    
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

def authenticate_user(db: Session, login_data: UserLogin) -> Token:
    user = db.query(User).filter(func.lower(User.email) == login_data.email).first()
    if not user:
        # Spend the same bcrypt time as a real check so response timing does not reveal whether the account exists
        verify_password(login_data.password, _dummy_hash())
    if not user or not verify_password(login_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(data={"sub": user.email})
    return Token(access_token=access_token, token_type="bearer")
