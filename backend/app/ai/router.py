"""
Lumina Intelligence Router & Task-Aware Model Selection (Phase 4.3.4)

Provides deterministic, lightweight classification and model routing:
- Tasks: GENERAL, CODING, REASONING, DOCUMENT, VOICE, TITLE
- Fast Model (FALLBACK_MODEL, e.g. llama3.2:3b) for GENERAL, VOICE, TITLE
- Strong Model (PRIMARY_MODEL, e.g. llama3.1:8b) for CODING, REASONING, DOCUMENT
- Dynamic availability awareness: uses installed models, falling back safely to fast model if strong is unavailable.
- Centralized task-specific sampling parameters (temperature, top_p).
- Zero external dependencies: no LangChain, no LlamaIndex, no cloud APIs.
"""

from enum import Enum
import re
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

class TaskType(str, Enum):
    GENERAL = "GENERAL"
    CODING = "CODING"
    REASONING = "REASONING"
    DOCUMENT = "DOCUMENT"
    VOICE = "VOICE"
    TITLE = "TITLE"

class IntelligenceRouter:
    # Sampling parameters by task
    SAMPLING_CONFIG: Dict[TaskType, Dict[str, float]] = {
        TaskType.GENERAL: {"temperature": 0.7, "top_p": 0.9},
        TaskType.CODING: {"temperature": 0.2, "top_p": 0.9},
        TaskType.REASONING: {"temperature": 0.2, "top_p": 0.9},
        TaskType.DOCUMENT: {"temperature": 0.2, "top_p": 0.9},
        TaskType.VOICE: {"temperature": 0.5, "top_p": 0.9},
        TaskType.TITLE: {"temperature": 0.2, "top_p": 0.9},
    }

    # Signals for task classification
    CODING_PATTERNS = [
        r"```",
        r"\b(def|class|function|fn|func|var|val|let|const|import|from|return)\b",
        r"\b(python|javascript|typescript|java|c\+\+|golang|rust|ruby|php|swift|kotlin|sql|html|css)\b",
        r"\b(code|coding|implement|implementation|algorithm|debug|debugging|bug|fix bug|refactor|compile|compiler|runtime error|syntax error|stack trace)\b",
        r"\b(regex|regular expression|api endpoint|unit test|pytest|jest)\b",
    ]

    REASONING_PATTERNS = [
        r"\b(step[- ]by[- ]step|reason through|think through|logical reasoning|deduce|derive|proof|prove)\b",
        r"\b(compare and contrast|tradeoffs?|pros and cons|analyze the implications|root cause analysis)\b",
        r"\b(math problem|calculate|solve for x|equation|probability|bayes|combinatorics)\b",
    ]

    DOCUMENT_PATTERNS = [
        r"\b(document|pdf|file|uploaded|chapter|section|page|passage|textbook|article|paper)\b",
        r"\b(summarize (the|this)|key points|quiz me|study notes|make notes|extract from)\b",
        r"\b(according to (the|this)|what does the document say|in the file|from the text)\b",
    ]

    # Precompiled regexes for performance
    _CODING_RE = re.compile("|".join(CODING_PATTERNS), re.IGNORECASE)
    _REASONING_RE = re.compile("|".join(REASONING_PATTERNS), re.IGNORECASE)
    _DOCUMENT_RE = re.compile("|".join(DOCUMENT_PATTERNS), re.IGNORECASE)

    @classmethod
    def is_document_query(cls, text: str) -> bool:
        """
        Determines whether a user query in a document-enabled chat is actually asking about
        the document vs asking an unrelated general question (e.g. 'What is 2 + 2?').
        """
        clean = text.strip()
        if not clean:
            return False

        # Clear general-knowledge / math / standalone queries that shouldn't be forced into document RAG
        if re.match(r"^(\d+\s*[\+\-\*/\^]\s*\d+|\bwhat is \d+\s*[\+\-\*/\^]\s*\d+)", clean, re.IGNORECASE):
            return False

        # If user explicitly references document terms or actions
        if cls._DOCUMENT_RE.search(clean):
            return True

        # Short general queries like "Hi", "Hello", "Who are you?", "What is python?"
        if len(clean.split()) <= 4 and re.match(r"^(hi|hello|hey|what is python|tell me a joke|test)\b", clean, re.IGNORECASE):
            return False

        return True

    @classmethod
    def classify_task(
        cls,
        message: str,
        is_voice: bool = False,
        has_document: bool = False,
        is_title: bool = False
    ) -> TaskType:
        """
        Determines the task type deterministically based on request context and query content.
        Precedence:
        1. TITLE
        2. VOICE
        3. DOCUMENT (if document context exists AND query is document-related)
        4. CODING
        5. REASONING
        6. GENERAL
        """
        if is_title:
            return TaskType.TITLE

        if is_voice:
            return TaskType.VOICE

        text = (message or "").strip()

        # If document is present and query is document-relevant
        if has_document and cls.is_document_query(text):
            return TaskType.DOCUMENT

        # Multi-step reasoning / comparison / mathematical deduction
        if cls._REASONING_RE.search(text):
            return TaskType.REASONING

        # Coding / programming
        if cls._CODING_RE.search(text):
            return TaskType.CODING

        return TaskType.GENERAL

    @classmethod
    def get_preferred_tier(cls, task: TaskType) -> str:
        """
        Maps a task type to the preferred model tier:
        - "strong": requires deeper reasoning, precision, or large context (PRIMARY_MODEL)
        - "fast": requires ultra-low latency or high throughput (FALLBACK_MODEL)
        """
        if task in (TaskType.CODING, TaskType.REASONING, TaskType.DOCUMENT):
            return "strong"
        return "fast"

    @classmethod
    def get_sampling_options(cls, task: TaskType, extra_options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Returns centralized sampling options for a task type.
        """
        options = cls.SAMPLING_CONFIG.get(task, {"temperature": 0.7, "top_p": 0.9}).copy()
        if extra_options:
            options.update(extra_options)
        return options

    @classmethod
    def route_request(
        cls,
        message: str,
        is_voice: bool = False,
        has_document: bool = False,
        is_title: bool = False,
        available_models: Optional[list] = None,
        primary_model: str = "llama3.1:8b",
        fallback_model: str = "llama3.2:3b",
        extra_options: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Unified routing decision returning task, selected model, tier, and sampling options.
        """
        task = cls.classify_task(
            message=message,
            is_voice=is_voice,
            has_document=has_document,
            is_title=is_title
        )
        tier = cls.get_preferred_tier(task)
        sampling = cls.get_sampling_options(task, extra_options=extra_options)

        # Select model based on tier and availability
        models_list = available_models or []
        if tier == "strong" and primary_model in models_list:
            selected_model = primary_model
            resolved_tier = "strong"
        else:
            # Fall back safely to fast model
            selected_model = fallback_model
            resolved_tier = "fast"

        return {
            "task": task,
            "tier": resolved_tier,
            "preferred_tier": tier,
            "model": selected_model,
            "options": sampling
        }

intelligence_router = IntelligenceRouter()
