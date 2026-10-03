"""
Authentication edge cases not covered by tests/test_auth_security.py (which already covers expired, garbage and
wrongly-signed tokens, cookie/header precedence and sequential duplicate registration):

- tokens for a user that no longer exists, tokens without (or with an unusable) `sub`
- `alg: none` and algorithm-substitution tokens, malformed token shapes over both cookie and Bearer transport
- uniform 401 responses (no oracle about why a token was rejected)
- duplicate registration racing between the existence check and the insert

Tokens are built with the app's own create_access_token or PyJWT with the app's SECRET_KEY/ALGORITHM; validation is
never relaxed.
"""
import base64
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import jwt
import pytest
from fastapi.testclient import TestClient

import app.services.auth_service as auth_service_module
from app.auth.jwt import create_access_token
from app.core.config import settings
from app.database.database import SessionLocal
from app.main import app
from app.models.user import User

PROTECTED = ["/auth/me", "/auth/profile", "/chat/"]


def b64(part: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(part).encode()).rstrip(b"=").decode()


def future() -> int:
    return int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())


def signed(payload: dict, algorithm: str = None) -> str:
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=algorithm or settings.ALGORITHM)


def assert_rejected(res):
    assert res.status_code == 401
    assert res.json() == {"detail": "Could not validate credentials"}
    assert res.headers.get("www-authenticate") == "Bearer"


@pytest.fixture
def user(make_user):
    return make_user(name="Edge Case User")


# ---------------------------------------------------------------- tokens for users that do not exist (any more)
def test_token_of_a_deleted_user_stops_working(api_client, db_session, user):
    token = create_access_token({"sub": user.email})
    headers = {"Authorization": f"Bearer {token}"}
    assert api_client.get("/auth/me", headers=headers).status_code == 200

    db_session.delete(user)
    db_session.commit()

    for path in PROTECTED:
        assert_rejected(api_client.get(path, headers=headers))


def test_validly_signed_token_for_an_unknown_email_is_rejected(api_client, db_session):
    token = create_access_token({"sub": "nobody@example.com"})
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


def test_subject_lookup_is_case_insensitive_like_login(api_client, user):
    token = create_access_token({"sub": user.email.upper()})
    res = api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert res.json()["id"] == user.id


# ---------------------------------------------------------------- missing / unusable subject
@pytest.mark.parametrize("claims", [
    {},                      # no sub at all
    {"sub": None},
    {"sub": ""},
    {"sub": "   "},
    {"email": "placeholder"},  # identity in the wrong claim
])
def test_token_without_a_usable_subject_is_rejected(api_client, user, claims):
    claims = {k: (user.email if v == "placeholder" else v) for k, v in claims.items()}
    token = signed({**claims, "exp": future()})
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


def test_non_string_subject_is_rejected_not_a_server_error(api_client, user):
    token = signed({"sub": user.id, "exp": future()})
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


def test_token_without_expiry_is_still_bound_to_a_real_user(api_client, user):
    """Current behaviour: `exp` is not required by jwt.decode; such a token is only accepted for a real user."""
    ok = signed({"sub": user.email})
    assert api_client.get("/auth/me", headers={"Authorization": f"Bearer {ok}"}).status_code == 200
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {signed({'sub': 'x@example.com'})}"}))


# ---------------------------------------------------------------- algorithm attacks
@pytest.mark.parametrize("alg", ["none", "None", "NONE"])
@pytest.mark.parametrize("signature", ["", "AAAA"])
def test_unsigned_alg_none_token_is_rejected(api_client, user, alg, signature):
    token = f"{b64({'alg': alg, 'typ': 'JWT'})}.{b64({'sub': user.email, 'exp': future()})}.{signature}"
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))
    api_client.cookies.set(settings.AUTH_COOKIE_NAME, token)
    assert_rejected(api_client.get("/auth/me"))


@pytest.mark.filterwarnings("ignore::jwt.warnings.InsecureKeyLengthWarning")  # the short test-only secret
@pytest.mark.parametrize("alg", ["HS384", "HS512"])
def test_token_signed_with_another_hmac_algorithm_and_the_real_secret_is_rejected(api_client, user, alg):
    assert alg != settings.ALGORITHM
    token = signed({"sub": user.email, "exp": future()}, algorithm=alg)
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


def test_header_algorithm_swapped_on_a_valid_token_is_rejected(api_client, user):
    _, payload, sig = create_access_token({"sub": user.email}).split(".")
    token = f"{b64({'alg': 'HS512', 'typ': 'JWT'})}.{payload}.{sig}"
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


def test_payload_tampering_invalidates_the_signature(api_client, user, make_user):
    victim = make_user(name="Victim")
    header, _, sig = create_access_token({"sub": user.email}).split(".")
    token = f"{header}.{b64({'sub': victim.email, 'exp': future()})}.{sig}"
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


# ---------------------------------------------------------------- malformed tokens over both transports
MALFORMED = [
    "a.b.c",
    "only-one-segment",
    "two.segments",
    "four.segments.are.wrong",
    "...",
    f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.not-base64-json!.sig",
    f"{b64({'alg': 'HS256', 'typ': 'JWT'})}.{base64.urlsafe_b64encode(b'[1, 2]').decode()}.sig",
    "eyJhbGciOiJIUzI1NiJ9",  # header only
    "x" * 5000,
]


@pytest.mark.parametrize("token", MALFORMED, ids=range(len(MALFORMED)))
def test_malformed_bearer_token_is_a_clean_401(api_client, user, token):
    assert_rejected(api_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}))


@pytest.mark.parametrize("token", MALFORMED, ids=range(len(MALFORMED)))
def test_malformed_cookie_token_is_a_clean_401(api_client, user, token):
    api_client.cookies.set(settings.AUTH_COOKIE_NAME, token)
    assert_rejected(api_client.get("/auth/me"))


@pytest.mark.parametrize("authorization", ["Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "bearer", "Token abc"])
def test_malformed_authorization_header_is_a_401(api_client, user, authorization):
    res = api_client.get("/auth/me", headers={"Authorization": authorization})
    assert res.status_code == 401


def test_all_rejection_reasons_produce_an_identical_response(api_client, db_session, user):
    tokens = [
        create_access_token({"sub": "ghost@example.com"}),
        signed({"exp": future()}),
        f"{b64({'alg': 'none'})}.{b64({'sub': user.email})}.",
        create_access_token({"sub": user.email}, expires_delta=timedelta(seconds=-5)),
        "garbage",
    ]
    responses = [api_client.get("/auth/me", headers={"Authorization": f"Bearer {t}"}) for t in tokens]
    assert {(r.status_code, r.text, r.headers.get("www-authenticate")) for r in responses} == {
        (401, '{"detail":"Could not validate credentials"}', "Bearer"),
    }


# ---------------------------------------------------------------- duplicate registration race
@pytest.fixture
def concurrent_registration(db_session):
    """
    Deterministically reproduces two simultaneous sign-ups for the same e-mail: register_user checks that the e-mail
    is free, then spends ~bcrypt time hashing before inserting. The patched hash function commits a competing user
    from another session inside exactly that window, as a second request would.
    """
    email = "race@example.com"

    def competing_signup_then_hash(password):
        other = SessionLocal()
        try:
            other.add(User(name="First Request", email=email, hashed_password="first-request-hash"))
            other.commit()
        finally:
            other.close()
        return "second-request-hash"

    client = TestClient(app, raise_server_exceptions=False)
    with patch.object(auth_service_module, "get_password_hash", side_effect=competing_signup_then_hash):
        res = client.post("/auth/register", json={"name": "Second Request", "email": email, "password": "password123"})
    db_session.expire_all()
    return res, db_session.query(User).filter(User.email == email).all()


def test_concurrent_duplicate_registration_never_creates_two_accounts(concurrent_registration):
    _, users = concurrent_registration
    assert [u.name for u in users] == ["First Request"]


def test_concurrent_duplicate_registration_does_not_leak_database_details(concurrent_registration):
    res, _ = concurrent_registration
    assert "UNIQUE" not in res.text and "IntegrityError" not in res.text and "INSERT" not in res.text


def test_concurrent_duplicate_registration_is_reported_as_already_registered(concurrent_registration):
    res, _ = concurrent_registration
    assert res.status_code in (400, 409)
    assert res.json() == {"detail": "Email already registered"}


def test_concurrent_registration_with_a_differently_cased_email_is_also_already_registered(db_session):
    """The unique index is on lower(email): a racing 'Race@Example.com' and 'race@example.com' are the same account."""
    def competing_signup_then_hash(password):
        other = SessionLocal()
        try:
            other.add(User(name="First Request", email="Race@Example.com", hashed_password="first-request-hash"))
            other.commit()
        finally:
            other.close()
        return "second-request-hash"

    client = TestClient(app, raise_server_exceptions=False)
    with patch.object(auth_service_module, "get_password_hash", side_effect=competing_signup_then_hash):
        res = client.post("/auth/register", json={"name": "Second", "email": "race@example.com", "password": "password123"})
    assert res.status_code == 400
    assert res.json() == {"detail": "Email already registered"}


def test_an_integrity_error_that_is_not_a_duplicate_email_is_not_disguised(db_session):
    """Only a real duplicate is reported as 'Email already registered'; anything else stays a generic 500."""
    def competing_signup_then_hash(password):
        other = SessionLocal()
        try:
            other.add(User(name="First Request", email="race@example.com", hashed_password="first-request-hash"))
            other.commit()
        finally:
            other.close()
        return "second-request-hash"

    client = TestClient(app, raise_server_exceptions=False)
    with patch.object(auth_service_module, "get_password_hash", side_effect=competing_signup_then_hash), \
         patch.object(auth_service_module, "_email_taken", return_value=False):
        res = client.post("/auth/register", json={"name": "Second", "email": "race@example.com", "password": "password123"})
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal server error"}
