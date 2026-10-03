"""
System prompt composition: normal, document, quiz and voice modes.
Migrated from scripts/test_intelligence_pipeline.py section 2 (prompt intelligence & modulation). Pure functions.
"""
from app.ai.prompts import get_system_prompt


def test_normal_chat_omits_document_and_quiz_sections():
    prompt = get_system_prompt(user_name="Alice", has_document=False, is_quiz=False, is_voice=False)
    assert "Document Intelligence & Grounding Guidelines:" not in prompt
    assert "Interactive Quiz Protocol:" not in prompt
    assert "Priority Hierarchy:" in prompt
    assert "Alice" in prompt


def test_document_chat_includes_grounding_with_general_knowledge_distinction():
    prompt = get_system_prompt(user_name="Alice", has_document=True, is_quiz=False, is_voice=False)
    assert "Document Intelligence & Grounding Guidelines:" in prompt
    assert "General Knowledge Questions in Document Chats" in prompt
    assert "What is 2 + 2?" in prompt
    assert "Interactive Quiz Protocol:" not in prompt


def test_quiz_mode_includes_grounding_and_quiz_protocol():
    prompt = get_system_prompt(user_name="Alice", has_document=True, is_quiz=True, is_voice=False)
    assert "Document Intelligence & Grounding Guidelines:" in prompt
    assert "Interactive Quiz Protocol:" in prompt
    assert "Single Question Delivery" in prompt


def test_voice_mode_uses_the_concise_voice_prompt():
    prompt = get_system_prompt(user_name="Alice", is_voice=True)
    assert "VOICE RESPONSE STYLE:" in prompt
    assert "prefer approximately 5–20 words" in prompt
    assert "Interactive Quiz Protocol:" not in prompt
