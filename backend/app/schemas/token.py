from pydantic import BaseModel

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    email: str | None = None

class LoginResponse(BaseModel):
    """Login result. The JWT itself is delivered only via the HttpOnly cookie, never in the body."""
    message: str = "Login successful"
    token_type: str = "cookie"
