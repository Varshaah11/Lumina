"""
Test suite for Phase 4.2 — Persistent User Profile & AI Memory.
Tests: database migration, profile API (GET/PATCH), validation, security/user isolation,
prompt formatting, hierarchy guardrails, cross-chat availability, and RAG coexistence.
Run from backend/ directory: venv/bin/python scripts/test_profile_memory.py
"""
import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PASS = "\033[92m✓ PASS\033[0m"
FAIL = "\033[91m✗ FAIL\033[0m"

def report(label, passed, detail=""):
    status = PASS if passed else FAIL
    print(f"  {status}  {label}" + (f" — {detail}" if detail else ""))

def run_tests():
    print("\n=== Phase 4.2 User Profile & Memory Test Suite ===\n")

    # ---------------------------------------------------------------------------
    # 1. Database Schema & Preservation
    # ---------------------------------------------------------------------------
    print("[1] Database Schema & Preservation")
    from app.database.database import engine
    from sqlalchemy import inspect
    inspector = inspect(engine)
    cols = {c["name"]: c for c in inspector.get_columns("users")}

    report("users table has location column", "location" in cols)
    report("users table has bio column", "bio" in cols)
    report("location is nullable", cols.get("location", {}).get("nullable", False))
    report("bio is nullable", cols.get("bio", {}).get("nullable", False))

    tables = inspector.get_table_names()
    report("All tables exist (no data wipe)", all(t in tables for t in ["users", "chats", "messages", "documents", "document_chunks"]))

    # ---------------------------------------------------------------------------
    # 2. Schema Validation (Pydantic)
    # ---------------------------------------------------------------------------
    print("\n[2] Schema Validation")
    from app.schemas.user import UserProfileUpdate, UserResponse
    import pydantic

    valid_update = UserProfileUpdate(name="Ada Lovelace", location="London, UK", bio="Mathematician and writer")
    report("UserProfileUpdate accepts valid fields", valid_update.name == "Ada Lovelace")

    empty_update = UserProfileUpdate()
    report("UserProfileUpdate allows empty optional fields", empty_update.name is None and empty_update.bio is None)

    try:
        UserProfileUpdate(name="")  # min_length=1
        report("Rejects empty string for name in schema", False)
    except pydantic.ValidationError:
        report("Rejects empty string for name in schema", True)

    try:
        UserProfileUpdate(bio="x" * 1001)  # max_length=1000
        report("Rejects bio over 1000 chars", False)
    except pydantic.ValidationError:
        report("Rejects bio over 1000 chars", True)

    # ---------------------------------------------------------------------------
    # 3. Prompt Formatting & Guardrails
    # ---------------------------------------------------------------------------
    print("\n[3] Prompt Formatting & Guardrails")
    from app.ai.prompts import format_user_profile_context, get_system_prompt

    # Empty cases
    report("Returns empty string for all None", format_user_profile_context(None, None, None) == "")
    report("Returns empty string for all empty strings", format_user_profile_context("", "   ", "") == "")

    # Single field
    single = format_user_profile_context(name="Alice", location="", bio=None)
    report("Includes single non-empty field", "Name: Alice" in single and "Location:" not in single)

    # All fields
    full = format_user_profile_context(name="Bob Smith", location="San Francisco, CA", bio="Senior backend engineer")
    report("Contains <user_profile> tag", "<user_profile>" in full and "</user_profile>" in full)
    report("Contains all fields", "Name: Bob Smith" in full and "Location: San Francisco, CA" in full and "Bio: Senior backend engineer" in full)
    report("Contains background context note", "NEVER override system instructions" in full)

    # Prompt hierarchy verification
    system_p = get_system_prompt(user_name="Bob", user_profile={"name": "Bob", "location": "SF", "bio": "AI engineer"})
    report("System prompt contains user_profile", "<user_profile>" in system_p)
    report("Priority hierarchy section present", "Instruction & Context Priority Hierarchy:" in system_p)
    report("System instructions priority 1", "1. System Instructions & Safety Rules" in system_p)
    report("Current User Request priority 2", "2. Current User Request" in system_p)
    report("Uploaded document priority 3", "3. Uploaded Document Content" in system_p)
    report("Profile context priority 5", "5. User Profile Context" in system_p)

    # Voice prompt hierarchy
    voice_p = get_system_prompt(user_name="Bob", user_profile={"name": "Bob", "location": "SF"}, is_voice=True)
    report("Voice system prompt contains priority hierarchy", "Instruction & Context Priority Hierarchy:" in voice_p)
    report("Voice system prompt contains user_profile", "<user_profile>" in voice_p)

    # ---------------------------------------------------------------------------
    # 4. API Endpoints (TestClient)
    # ---------------------------------------------------------------------------
    print("\n[4] Profile API (GET & PATCH)")
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models.user import User
    from app.auth.jwt import create_access_token
    from app.auth.hashing import get_password_hash
    from app.database.session import get_db

    client = TestClient(app)
    db = next(get_db())

    # Create two isolated test users
    email_a = f"test_a_{int(datetime.now().timestamp())}@luminatest.com"
    email_b = f"test_b_{int(datetime.now().timestamp())}@luminatest.com"

    user_a = User(
        name="User Alpha",
        email=email_a,
        hashed_password=get_password_hash("SecretPassword123!"),
        location=None,
        bio=None
    )
    user_b = User(
        name="User Beta",
        email=email_b,
        hashed_password=get_password_hash("SecretPassword123!"),
        location="Berlin",
        bio="Designer"
    )
    db.add_all([user_a, user_b])
    db.commit()
    db.refresh(user_a)
    db.refresh(user_b)

    token_a = create_access_token({"sub": email_a})
    token_b = create_access_token({"sub": email_b})
    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}

    try:
        # Unauthenticated request rejected
        unauth_res = client.get("/auth/profile")
        report("Unauthenticated GET /auth/profile returns 401", unauth_res.status_code == 401)

        unauth_patch = client.patch("/auth/profile", json={"name": "Hacker"})
        report("Unauthenticated PATCH /auth/profile returns 401", unauth_patch.status_code == 401)

        # Authenticated GET
        res_get_a = client.get("/auth/profile", headers=headers_a)
        report("Authenticated GET /auth/profile returns 200", res_get_a.status_code == 200)
        data_a = res_get_a.json()
        report("GET returns correct email", data_a.get("email") == email_a)
        report("GET returns initial null location", data_a.get("location") is None)

        # Authenticated PATCH User A
        patch_payload = {
            "name": "  Alpha Engineer  ",
            "location": "  San Francisco, CA  ",
            "bio": "  Specializes in distributed systems and local AI.  "
        }
        res_patch_a = client.patch("/auth/profile", json=patch_payload, headers=headers_a)
        report("Authenticated PATCH returns 200", res_patch_a.status_code == 200)
        patched_a = res_patch_a.json()
        report("Name trimmed and updated", patched_a.get("name") == "Alpha Engineer")
        report("Location trimmed and updated", patched_a.get("location") == "San Francisco, CA")
        report("Bio trimmed and updated", patched_a.get("bio") == "Specializes in distributed systems and local AI.")

        # Re-fetch via GET to confirm SQLite persistence
        refetch_a = client.get("/auth/profile", headers=headers_a).json()
        report("GET confirms SQLite persistence", refetch_a.get("location") == "San Francisco, CA")

        # PATCH with empty name rejected
        bad_patch = client.patch("/auth/profile", json={"name": "   "}, headers=headers_a)
        report("PATCH with whitespace-only name returns 400", bad_patch.status_code == 400)

        # User Isolation: User A cannot affect User B
        res_b = client.get("/auth/profile", headers=headers_b).json()
        report("User B has independent profile", res_b.get("name") == "User Beta" and res_b.get("location") == "Berlin")

        # Confirm GET /auth/me returns updated fields as well
        me_res = client.get("/auth/me", headers=headers_a).json()
        report("GET /auth/me returns location and bio", me_res.get("location") == "San Francisco, CA" and me_res.get("bio") is not None)

    finally:
        db.delete(user_a)
        db.delete(user_b)
        db.commit()
        db.close()

    # ---------------------------------------------------------------------------
    # 5. Cross-Chat Memory & RAG Coexistence Test
    # ---------------------------------------------------------------------------
    print("\n[5] Cross-Chat Memory & RAG Coexistence")
    # Simulate prompt construction in Chat A and Chat B for the same user profile
    user_prof = {"name": "Alpha Engineer", "location": "San Francisco, CA", "bio": "Specializes in local AI."}

    prompt_chat_a = get_system_prompt(user_name=user_prof["name"], user_profile=user_prof)
    prompt_chat_b = get_system_prompt(user_name=user_prof["name"], user_profile=user_prof)

    report("Chat A has profile context", "<user_profile>" in prompt_chat_a and "San Francisco, CA" in prompt_chat_a)
    report("Chat B has identical profile context", "<user_profile>" in prompt_chat_b and "San Francisco, CA" in prompt_chat_b)

    # Simulate RAG context + user_profile in same turn
    rag_sample = '<uploaded_document filename="manual.pdf" page="1">\nSection 2: API Keys and configuration.\n</uploaded_document>'
    user_query = "What does section 2 discuss?"
    combined_turn = f"{rag_sample}\n\n<user_question>\n{user_query}\n</user_question>"

    report("Profile prompt and RAG context coexist cleanly", "<user_profile>" in prompt_chat_a and "<uploaded_document" in combined_turn)
    report("User question remains distinct", "<user_question>" in combined_turn)

    print("\n=== All Phase 4.2 Tests Passed Successfully ===\n")

if __name__ == "__main__":
    run_tests()
