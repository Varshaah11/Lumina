"""
Intelligence router: task classification, document-query detection, tier/model selection, unavailable-model fallback,
centralized sampling options and runtime failure recovery.
Migrated from scripts/test_intelligence_router.py (24 checks). Ollama is mocked; no server is needed.
"""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.ai.client import ollama_client
from app.ai.router import TaskType, intelligence_router
from app.ai.service import FALLBACK_MODEL, PRIMARY_MODEL, AIService

BOTH = [PRIMARY_MODEL, FALLBACK_MODEL]


@pytest.fixture(autouse=True)
def _fresh_model_cache():
    AIService.invalidate_model_cache()
    yield
    AIService.invalidate_model_cache()


# ---------------------------------------------------------------- [1] task classification
def test_title_flag_classifies_as_title():
    assert intelligence_router.classify_task("Hello world", is_title=True) == TaskType.TITLE


@pytest.mark.parametrize("text", ["What is the capital of France?", "Write a python function"])
def test_voice_flag_takes_precedence_over_content(text):
    assert intelligence_router.classify_task(text, is_voice=True) == TaskType.VOICE


@pytest.mark.parametrize("text", ["Summarize this document", "What does the PDF say about locks?"])
def test_document_questions_classify_as_document(text):
    assert intelligence_router.classify_task(text, has_document=True) == TaskType.DOCUMENT


@pytest.mark.parametrize("text", ["Write a python function to reverse a list", "```def foo(): pass```", "Fix the bug in this SQL query"])
def test_programming_questions_classify_as_coding(text):
    assert intelligence_router.classify_task(text) == TaskType.CODING


@pytest.mark.parametrize("text", [
    "Explain the tradeoffs between SQL and NoSQL step by step",
    "Solve for x in this math problem: 2x + 4 = 10",
    "What is the root cause analysis for memory leaks?",
])
def test_reasoning_questions_classify_as_reasoning(text):
    assert intelligence_router.classify_task(text) == TaskType.REASONING


@pytest.mark.parametrize("text", ["What is the weather like in Paris?", "Tell me a bedtime story about dragons"])
def test_conversational_questions_classify_as_general(text):
    assert intelligence_router.classify_task(text) == TaskType.GENERAL


# ---------------------------------------------------------------- [2] general questions inside document chats
@pytest.mark.parametrize("text", ["What is 2 + 2?", "2 + 2", "Hi", "What is python?"])
def test_general_questions_are_not_document_queries(text):
    assert intelligence_router.is_document_query(text) is False


def test_general_question_in_document_chat_routes_to_general():
    assert intelligence_router.classify_task("What is 2 + 2?", has_document=True) == TaskType.GENERAL


@pytest.mark.parametrize("text", [
    "What is the main topic of chapter 2?",
    "Summarize page 4",
    "According to the text, what is the conclusion?",
])
def test_genuine_document_questions_are_recognized(text):
    assert intelligence_router.is_document_query(text) is True


# ---------------------------------------------------------------- [3] model selection by tier
@pytest.mark.parametrize("message, kwargs, task, tier, model", [
    ("Write code in Rust", {}, TaskType.CODING, "strong", PRIMARY_MODEL),
    ("Compare and contrast React and Vue tradeoffs", {}, TaskType.REASONING, "strong", PRIMARY_MODEL),
    ("Summarize the attached file", {"has_document": True}, TaskType.DOCUMENT, "strong", PRIMARY_MODEL),
    ("What is the capital of Italy?", {}, TaskType.GENERAL, "fast", FALLBACK_MODEL),
    ("How are you today?", {"is_voice": True}, TaskType.VOICE, "fast", FALLBACK_MODEL),
    ("A short title message", {"is_title": True}, TaskType.TITLE, "fast", FALLBACK_MODEL),
])
def test_route_selects_model_by_tier_when_both_installed(message, kwargs, task, tier, model):
    route = intelligence_router.route_request(message, available_models=BOTH, **kwargs)
    assert route["task"] == task
    assert route["preferred_tier"] == tier
    assert route["model"] == model


# ---------------------------------------------------------------- [4] unavailable model fallback
def test_strong_task_falls_back_to_fast_model_when_primary_missing():
    route = intelligence_router.route_request("Write code in C++", available_models=[FALLBACK_MODEL])
    assert route["task"] == TaskType.CODING
    assert route["preferred_tier"] == "strong"
    assert route["model"] == FALLBACK_MODEL
    assert route["tier"] == "fast"


def test_document_task_falls_back_to_fast_model_when_primary_missing():
    route = intelligence_router.route_request("Summarize page 1", has_document=True, available_models=[FALLBACK_MODEL])
    assert route["model"] == FALLBACK_MODEL


# ---------------------------------------------------------------- [5] centralized sampling options
@pytest.mark.parametrize("task, temperature", [
    (TaskType.GENERAL, 0.7),
    (TaskType.CODING, 0.2),
    (TaskType.REASONING, 0.2),
    (TaskType.DOCUMENT, 0.2),
    (TaskType.VOICE, 0.5),
    (TaskType.TITLE, 0.2),
])
def test_sampling_options_per_task(task, temperature):
    options = intelligence_router.get_sampling_options(task)
    assert options["temperature"] == temperature
    assert options["top_p"] == 0.9


# ---------------------------------------------------------------- [6] runtime failure recovery
def test_primary_failure_is_retried_exactly_once_on_fallback():
    calls = []

    async def fake_generate_chat(model, messages, stream=True, options=None):
        calls.append(model)
        if model == PRIMARY_MODEL:
            raise RuntimeError("Primary model crashed during initialization")

        async def tokens():
            yield {"message": {"content": "Fallback successful"}}

        return tokens()

    async def run():
        return [chunk async for chunk in AIService.stream_chat_response(user_message="Write a complex python algorithm", has_document=False)]

    with patch.object(AIService, "get_available_models", new_callable=AsyncMock, return_value=BOTH), \
         patch.object(ollama_client, "generate_chat", side_effect=fake_generate_chat):
        chunks = asyncio.run(run())

    assert calls == [PRIMARY_MODEL, FALLBACK_MODEL]
    assert any("Fallback successful" in c for c in chunks)
