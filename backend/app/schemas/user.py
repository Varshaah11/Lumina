from typing import Optional
from pydantic import BaseModel, EmailStr, ConfigDict, Field, field_validator
from datetime import datetime

MIN_PASSWORD_LENGTH = 8   # matches the frontend registerSchema
MAX_PASSWORD_BYTES = 72   # bcrypt silently/loudly cannot use more than 72 bytes

def normalize_email(value):
    """Trim and lowercase so A@x.com and a@x.com are the same account."""
    return value.strip().lower() if isinstance(value, str) else value

class UserBase(BaseModel):
    name: str
    email: EmailStr
    location: Optional[str] = None
    bio: Optional[str] = None

class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str = Field(min_length=MIN_PASSWORD_LENGTH)

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, v):
        return normalize_email(v)

    @field_validator("password")
    @classmethod
    def _password_fits_bcrypt(cls, v: str) -> str:
        if len(v.encode("utf-8")) > MAX_PASSWORD_BYTES:
            raise ValueError(f"Password must be at most {MAX_PASSWORD_BYTES} bytes long")
        return v

class UserProfileUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    location: Optional[str] = Field(None, max_length=255)
    bio: Optional[str] = Field(None, max_length=1000)

class UserResponse(UserBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
