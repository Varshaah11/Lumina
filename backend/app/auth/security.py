from fastapi.security import OAuth2PasswordBearer

# auto_error=False: the primary credential is the HttpOnly auth cookie; the Authorization header is an optional
# fallback for non-browser clients (scripts, API tools), so a missing header must not fail the request by itself.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)
