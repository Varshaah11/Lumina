"""
Phase 4.3.4 — Intelligence Router & True Model Selection Automated Test Suite

Covers:
1. Task Classification (GENERAL, CODING, REASONING, DOCUMENT, VOICE, TITLE).
2. Model Selection by Tier (strong vs fast).
3. Unavailable Model Fallback (e.g. llama3.1:8b not installed -> fallback to llama3.2:3b).
4. Runtime Failure Fallback (primary fails -> retry once on fallback).
5. Voice Routing (routes to fast model, temp=0.5, top_p=0.9).
6. Document Routing (routes to strong model when available, temp=0.2, top_p=0.9).
7. General Questions with Attached Document (routes to GENERAL, skips unnecessary document injection).
8. Centralized Sampling Options verification across all tasks.
"""

import sys
import os
import asyncio
from unittest.mock import AsyncMock, patch

# Add backend directory to sys.path
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.ai.router import intelligence_router, TaskType
from app.ai.service import AIService, PRIMARY_MODEL, FALLBACK_MODEL
from app.ai.client import ollama_client

def test_task_classification():
    print("\n[1] Task Classification")

    # 1.1 Title
    assert intelligence_router.classify_task("Hello world", is_title=True) == TaskType.TITLE
    print("  ✓ PASS  is_title=True classifies as TITLE")

    # 1.2 Voice
    assert intelligence_router.classify_task("What is the capital of France?", is_voice=True) == TaskType.VOICE
    assert intelligence_router.classify_task("Write a python function", is_voice=True) == TaskType.VOICE
    print("  ✓ PASS  is_voice=True classifies as VOICE (precedence over query contents)")

    # 1.3 Document
    assert intelligence_router.classify_task("Summarize this document", has_document=True) == TaskType.DOCUMENT
    assert intelligence_router.classify_task("What does the PDF say about locks?", has_document=True) == TaskType.DOCUMENT
    print("  ✓ PASS  Document questions classify as DOCUMENT")

    # 1.4 Coding
    assert intelligence_router.classify_task("Write a python function to reverse a list") == TaskType.CODING
    assert intelligence_router.classify_task("```def foo(): pass```") == TaskType.CODING
    assert intelligence_router.classify_task("Fix the bug in this SQL query") == TaskType.CODING
    print("  ✓ PASS  Programming questions classify as CODING")

    # 1.5 Reasoning
    assert intelligence_router.classify_task("Explain the tradeoffs between SQL and NoSQL step by step") == TaskType.REASONING
    assert intelligence_router.classify_task("Solve for x in this math problem: 2x + 4 = 10") == TaskType.REASONING
    assert intelligence_router.classify_task("What is the root cause analysis for memory leaks?") == TaskType.REASONING
    print("  ✓ PASS  Multi-step reasoning/analysis questions classify as REASONING")

    # 1.6 General
    assert intelligence_router.classify_task("What is the weather like in Paris?") == TaskType.GENERAL
    assert intelligence_router.classify_task("Tell me a bedtime story about dragons") == TaskType.GENERAL
    print("  ✓ PASS  Conversational / trivia queries classify as GENERAL")

def test_general_query_in_document_chat():
    print("\n[2] General Questions in Document Chats")

    # 2.1 General question with document present should NOT be forced to DOCUMENT task
    assert intelligence_router.is_document_query("What is 2 + 2?") is False
    assert intelligence_router.is_document_query("2 + 2") is False
    assert intelligence_router.is_document_query("Hi") is False
    assert intelligence_router.is_document_query("What is python?") is False

    task = intelligence_router.classify_task("What is 2 + 2?", has_document=True)
    assert task == TaskType.GENERAL
    print("  ✓ PASS  'What is 2 + 2?' in document chat routes to GENERAL")

    # 2.2 Genuine document queries are recognized
    assert intelligence_router.is_document_query("What is the main topic of chapter 2?") is True
    assert intelligence_router.is_document_query("Summarize page 4") is True
    assert intelligence_router.is_document_query("According to the text, what is the conclusion?") is True
    print("  ✓ PASS  Genuine document questions recognized and kept as DOCUMENT")

def test_model_tier_selection():
    print("\n[3] Model Selection by Tier & Availability")

    # When both primary and fallback are available:
    installed = [PRIMARY_MODEL, FALLBACK_MODEL]

    # Strong tasks -> PRIMARY_MODEL
    coding_route = intelligence_router.route_request("Write code in Rust", available_models=installed)
    assert coding_route["task"] == TaskType.CODING
    assert coding_route["preferred_tier"] == "strong"
    assert coding_route["model"] == PRIMARY_MODEL
    print(f"  ✓ PASS  CODING routes to strong model ({PRIMARY_MODEL}) when available")

    reasoning_route = intelligence_router.route_request("Compare and contrast React and Vue tradeoffs", available_models=installed)
    assert reasoning_route["task"] == TaskType.REASONING
    assert reasoning_route["preferred_tier"] == "strong"
    assert reasoning_route["model"] == PRIMARY_MODEL
    print(f"  ✓ PASS  REASONING routes to strong model ({PRIMARY_MODEL}) when available")

    doc_route = intelligence_router.route_request("Summarize the attached file", has_document=True, available_models=installed)
    assert doc_route["task"] == TaskType.DOCUMENT
    assert doc_route["preferred_tier"] == "strong"
    assert doc_route["model"] == PRIMARY_MODEL
    print(f"  ✓ PASS  DOCUMENT routes to strong model ({PRIMARY_MODEL}) when available")

    # Fast tasks -> FALLBACK_MODEL
    general_route = intelligence_router.route_request("What is the capital of Italy?", available_models=installed)
    assert general_route["task"] == TaskType.GENERAL
    assert general_route["preferred_tier"] == "fast"
    assert general_route["model"] == FALLBACK_MODEL
    print(f"  ✓ PASS  GENERAL routes to fast model ({FALLBACK_MODEL})")

    voice_route = intelligence_router.route_request("How are you today?", is_voice=True, available_models=installed)
    assert voice_route["task"] == TaskType.VOICE
    assert voice_route["preferred_tier"] == "fast"
    assert voice_route["model"] == FALLBACK_MODEL
    print(f"  ✓ PASS  VOICE routes to fast model ({FALLBACK_MODEL})")

    title_route = intelligence_router.route_request("A short title message", is_title=True, available_models=installed)
    assert title_route["task"] == TaskType.TITLE
    assert title_route["preferred_tier"] == "fast"
    assert title_route["model"] == FALLBACK_MODEL
    print(f"  ✓ PASS  TITLE routes to fast model ({FALLBACK_MODEL})")

def test_unavailable_model_fallback():
    print("\n[4] Unavailable Model Fallback")

    # When PRIMARY_MODEL is NOT installed (e.g. only llama3.2:3b is installed)
    installed_only_fast = [FALLBACK_MODEL]

    coding_route = intelligence_router.route_request("Write code in C++", available_models=installed_only_fast)
    assert coding_route["task"] == TaskType.CODING
    assert coding_route["preferred_tier"] == "strong"
    assert coding_route["model"] == FALLBACK_MODEL
    assert coding_route["tier"] == "fast"
    print(f"  ✓ PASS  CODING falls back safely to {FALLBACK_MODEL} when {PRIMARY_MODEL} is uninstalled")

    doc_route = intelligence_router.route_request("Summarize page 1", has_document=True, available_models=installed_only_fast)
    assert doc_route["model"] == FALLBACK_MODEL
    print(f"  ✓ PASS  DOCUMENT falls back safely to {FALLBACK_MODEL} when {PRIMARY_MODEL} is uninstalled")

def test_sampling_options_centralization():
    print("\n[5] Centralized Sampling Options")

    # General: 0.7
    gen_opts = intelligence_router.get_sampling_options(TaskType.GENERAL)
    assert gen_opts["temperature"] == 0.7 and gen_opts["top_p"] == 0.9
    print("  ✓ PASS  GENERAL uses temp=0.7, top_p=0.9")

    # Coding: 0.2
    code_opts = intelligence_router.get_sampling_options(TaskType.CODING)
    assert code_opts["temperature"] == 0.2 and code_opts["top_p"] == 0.9
    print("  ✓ PASS  CODING uses temp=0.2, top_p=0.9")

    # Reasoning: 0.2
    reas_opts = intelligence_router.get_sampling_options(TaskType.REASONING)
    assert reas_opts["temperature"] == 0.2 and reas_opts["top_p"] == 0.9
    print("  ✓ PASS  REASONING uses temp=0.2, top_p=0.9")

    # Document: 0.2
    doc_opts = intelligence_router.get_sampling_options(TaskType.DOCUMENT)
    assert doc_opts["temperature"] == 0.2 and doc_opts["top_p"] == 0.9
    print("  ✓ PASS  DOCUMENT uses temp=0.2, top_p=0.9")

    # Voice: 0.5
    voice_opts = intelligence_router.get_sampling_options(TaskType.VOICE)
    assert voice_opts["temperature"] == 0.5 and voice_opts["top_p"] == 0.9
    print("  ✓ PASS  VOICE uses temp=0.5, top_p=0.9")

    # Title: 0.2
    title_opts = intelligence_router.get_sampling_options(TaskType.TITLE)
    assert title_opts["temperature"] == 0.2 and title_opts["top_p"] == 0.9
    print("  ✓ PASS  TITLE uses temp=0.2, top_p=0.9")

def test_runtime_failure_recovery():
    print("\n[6] Runtime Model Failure Recovery (Single Retry)")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Mock get_available_models to pretend both models are installed
    with patch.object(AIService, "get_available_models", new_callable=AsyncMock) as mock_models:
        mock_models.return_value = [PRIMARY_MODEL, FALLBACK_MODEL]

        call_records = []

        async def mock_generate_chat(model, messages, stream=True, options=None):
            call_records.append(model)
            if model == PRIMARY_MODEL:
                raise RuntimeError("Primary model crashed during initialization")
            # Fallback model succeeds
            async def token_gen():
                yield {"message": {"content": "Fallback successful"}}
            return token_gen()

        with patch.object(ollama_client, "generate_chat", side_effect=mock_generate_chat):
            async def run_failing_stream():
                tokens = []
                gen = AIService.stream_chat_response(
                    user_message="Write a complex python algorithm",
                    has_document=False
                )
                async for chunk in gen:
                    tokens.append(chunk)
                return tokens

            result_tokens = loop.run_until_complete(run_failing_stream())

            # Verification:
            # 1. First attempt called PRIMARY_MODEL
            assert call_records[0] == PRIMARY_MODEL
            # 2. On failure, retried EXACTLY ONCE on FALLBACK_MODEL
            assert len(call_records) == 2
            assert call_records[1] == FALLBACK_MODEL
            # 3. Successful token from fallback was yielded
            assert any("Fallback successful" in t for t in result_tokens)
            print(f"  ✓ PASS  Primary model failure caught; successfully retried exactly once on {FALLBACK_MODEL}")

def run_all():
    print("==================================================")
    print("  Lumina Phase 4.3.4 Intelligence Router Tests")
    print("==================================================")
    test_task_classification()
    test_general_query_in_document_chat()
    test_model_tier_selection()
    test_unavailable_model_fallback()
    test_sampling_options_centralization()
    test_runtime_failure_recovery()
    print("\n==================================================")
    print("  ALL PHASE 4.3.4 TESTS PASSED SUCCESSFULLY (100%)")
    print("==================================================")

if __name__ == "__main__":
    run_all()
