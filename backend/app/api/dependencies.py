import jwt
from jwt.exceptions import InvalidTokenError
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database.session import get_db
from app.auth.security import oauth2_scheme
from app.core.config import settings
from app.models.user import User
from app.schemas.token import TokenData

def get_current_user(
    request: Request,
    bearer_token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    # HttpOnly cookie first; Authorization header only as a fallback for non-browser clients
    token = request.cookies.get(settings.AUTH_COOKIE_NAME) or bearer_token
    if not token:
        raise credentials_exception
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
        token_data = TokenData(email=email)
    except InvalidTokenError:
        raise credentials_exception
        
    user = db.query(User).filter(func.lower(User.email) == token_data.email.strip().lower()).first()
    if user is None:
        raise credentials_exception
    return user
