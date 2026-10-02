from pydantic import BaseModel, EmailStr, field_validator
from app.schemas.user import normalize_email

class UserLogin(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, v):
        return normalize_email(v)
