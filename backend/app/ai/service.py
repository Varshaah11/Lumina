import logging
import json
import re
from typing import Optional
from httpx import ConnectError
from app.ai.client import ollama_client
from app.ai.prompts import get_system_prompt

logger = logging.getLogger(__name__)

# Recommended default model
PRIMARY_MODEL = "llama3.1:8b"
FALLBACK_MODEL = "llama3.2:3b"

SHORT_GREETINGS = {"hi", "hello", "hey", "greetings", "sup", "yo", "test", "help", "hola"}

def sanitize_title(title_text: str, fallback: str) -> str:
    if not title_text:
        return fallback

    # Strip prefixes like "Title:", "Topic:", "Chat Title:"
    cleaned = re.sub(r'^(title|topic|chat title|heading|summary):\s*', '', title_text, flags=re.IGNORECASE).strip()

    # Strip quotes, markdown, and take first line
    cleaned = cleaned.strip('"\'`#*_').split('\n')[0].strip()
    cleaned = re.sub(r'^["\'](.*)["\']$', r'\1', cleaned).strip()

    # Restrict to max 8 words / 60 chars
    words = cleaned.split()
    if len(words) > 8:
        cleaned = " ".join(words[:8])
    if len(cleaned) > 60:
        cleaned = cleaned[:57].rstrip() + "..."

    return cleaned if len(cleaned) >= 2 else fallback

import time
from app.ai.router import intelligence_router, TaskType

_cached_available_models: Optional[list] = None
_cached_active_model: Optional[str] = None
_last_model_check_time: float = 0.0
MODEL_CACHE_TTL_SECONDS: float = 60.0

class AIService:
    @staticmethod
    def invalidate_model_cache():
        """Invalidates the model availability cache to force a fresh Ollama poll."""
        global _cached_available_models, _cached_active_model, _last_model_check_time
        _cached_available_models = None
        _cached_active_model = None
        _last_model_check_time = 0.0

    @staticmethod
    async def get_available_models(force_refresh: bool = False) -> list[str]:
        """
        Retrieves installed Ollama models with a 60-second TTL cache.
        """
        global _cached_available_models, _last_model_check_time
        now = time.time()
        if not force_refresh and _cached_available_models is not None and (now - _last_model_check_time) < MODEL_CACHE_TTL_SECONDS:
            return _cached_available_models

        try:
            response = await ollama_client.list_models()
            raw_models = getattr(response, "models", None)
            if raw_models is None:
                raw_models = response.get("models", []) if isinstance(response, dict) else []

            models = [
                getattr(m, "model", None) or (m.get("model") or m.get("name", "") if isinstance(m, dict) else "")
                for m in raw_models
            ]
            _cached_available_models = models
        except Exception as e:
            logger.warning(f"Error checking available Ollama models: {e}. Defaulting to empty list.")
            if _cached_available_models is None:
                _cached_available_models = []

        _last_model_check_time = now
        return _cached_available_models

    @staticmethod
    async def get_active_model(preferred_tier: str = "strong") -> str:
        """
        Returns the appropriate model based on tier preference and availability.
        - 'strong' (default) -> PRIMARY_MODEL if installed, else FALLBACK_MODEL
        - 'fast' -> FALLBACK_MODEL if installed, else first available model, else FALLBACK_MODEL
        """
        global _cached_active_model
        installed = await AIService.get_available_models()
        if preferred_tier == "strong" and PRIMARY_MODEL in installed:
            _cached_active_model = PRIMARY_MODEL
        elif FALLBACK_MODEL in installed:
            _cached_active_model = FALLBACK_MODEL
        elif installed:
            _cached_active_model = installed[0]
        else:
            _cached_active_model = FALLBACK_MODEL
        return _cached_active_model

    @staticmethod
    async def generate_title(user_message: str) -> str:
        """
        Generates a concise 3-6 word title summarizing the user message.
        Uses lightweight deterministic extraction when suitable, or the fast model with low tokens.
        Falls back to sanitized user_message on error or for short greetings.
        """
        msg_clean = user_message.strip()
        fallback_title = msg_clean[:50] + "..." if len(msg_clean) > 50 else msg_clean

        if msg_clean.lower() in SHORT_GREETINGS or len(msg_clean) <= 10:
            return fallback_title

        # Deterministic extraction for short queries (under 40 chars and <= 6 words)
        words = msg_clean.split()
        if 2 <= len(words) <= 6 and len(msg_clean) <= 40:
            candidate = sanitize_title(msg_clean, fallback_title)
            if candidate and len(candidate.split()) >= 2:
                return candidate

        installed = await AIService.get_available_models()
        route = intelligence_router.route_request(
            message=user_message,
            is_title=True,
            available_models=installed,
            primary_model=PRIMARY_MODEL,
            fallback_model=FALLBACK_MODEL,
            extra_options={"num_predict": 24}
        )
        model = route["model"]
        options = route["options"]

        system_prompt = (
            "You are a title generation assistant. "
            "Generate a concise, 3 to 6 word title summarizing the user's message. "
            "Return ONLY the plain title text without quotes, prefixes, markdown, or punctuation."
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Message: {user_message}"}
        ]

        try:
            response = await ollama_client.generate_chat(
                model=model,
                messages=messages,
                stream=False,
                options=options
            )
            if 'message' in response and 'content' in response['message']:
                raw_title = response['message']['content']
                return sanitize_title(raw_title, fallback_title)
        except Exception as e:
            logger.warning(f"AI Title generation failed with model {model}: {e}. Retrying with fallback.")
            AIService.invalidate_model_cache()
            if model != FALLBACK_MODEL:
                try:
                    retry_response = await ollama_client.generate_chat(
                        model=FALLBACK_MODEL,
                        messages=messages,
                        stream=False,
                        options=options
                    )
                    if 'message' in retry_response and 'content' in retry_response['message']:
                        return sanitize_title(retry_response['message']['content'], fallback_title)
                except Exception as retry_e:
                    logger.warning(f"Title fallback retry failed: {retry_e}")

        return fallback_title

    @staticmethod
    async def stream_chat_response(
        user_message: str = None,
        messages_history: list = None,
        user_name: str = "User",
        user_profile: Optional[dict] = None,
        has_document: bool = False,
        is_quiz: bool = False,
        is_voice: bool = False
    ):
        """
        Builds conversation history, routes task via IntelligenceRouter, and streams response.
        Includes single-attempt runtime failure recovery (falls back to FALLBACK_MODEL).
        """
        system_prompt = get_system_prompt(
            user_name=user_name,
            user_profile=user_profile,
            has_document=has_document,
            is_quiz=is_quiz,
            is_voice=is_voice
        )

        messages = [{"role": "system", "content": system_prompt}]
        if messages_history:
            messages.extend(messages_history)
        elif user_message:
            messages.append({"role": "user", "content": user_message})

        # Get latest query text for routing
        target_text = user_message or ""
        if not target_text and messages_history:
            for m in reversed(messages_history):
                if m.get("role") == "user":
                    target_text = m.get("content", "")
                    break

        installed = await AIService.get_available_models()
        route = intelligence_router.route_request(
            message=target_text,
            is_voice=is_voice,
            has_document=has_document,
            is_title=False,
            available_models=installed,
            primary_model=PRIMARY_MODEL,
            fallback_model=FALLBACK_MODEL
        )

        selected_model = route["model"]
        sampling_options = route["options"]
        logger.info(f"[IntelligenceRouter] Task: {route['task']} | Preferred: {route['preferred_tier']} | Model: {selected_model} | Options: {sampling_options}")

        # Attempt generation with runtime failure recovery (max 1 retry)
        response_stream = None
        used_model = selected_model
        try:
            response_stream = await ollama_client.generate_chat(
                model=used_model,
                messages=messages,
                stream=True,
                options=sampling_options
            )
        except (ConnectError, Exception) as initial_err:
            logger.warning(f"Generation failed on model '{used_model}': {initial_err}. Invalidate cache & retry on fallback.")
            AIService.invalidate_model_cache()
            if used_model != FALLBACK_MODEL:
                try:
                    used_model = FALLBACK_MODEL
                    response_stream = await ollama_client.generate_chat(
                        model=used_model,
                        messages=messages,
                        stream=True,
                        options=sampling_options
                    )
                except Exception as retry_err:
                    logger.error(f"Fallback retry failed on '{used_model}': {retry_err}")
                    payload = {"error": "Lumina couldn't connect. Please try again later."}
                    yield f"data: {json.dumps(payload)}\n\n"
                    return
            else:
                payload = {"error": "Lumina couldn't connect. Please try again later."}
                yield f"data: {json.dumps(payload)}\n\n"
                return

        # Stream chunks with token-level failure handling
        stream_yielded_tokens = False
        try:
            async for chunk in response_stream:
                if 'message' in chunk and 'content' in chunk['message']:
                    token = chunk['message']['content']
                    stream_yielded_tokens = True
                    yield f"data: {json.dumps({'token': token})}\n\n"
        except Exception as stream_err:
            logger.error(f"Streaming error on '{used_model}': {stream_err}")
            # If failed mid-stream before any tokens were sent and model was primary, try fallback once
            if not stream_yielded_tokens and used_model != FALLBACK_MODEL:
                try:
                    logger.info(f"Retrying stream on fallback model '{FALLBACK_MODEL}'")
                    AIService.invalidate_model_cache()
                    fallback_stream = await ollama_client.generate_chat(
                        model=FALLBACK_MODEL,
                        messages=messages,
                        stream=True,
                        options=sampling_options
                    )
                    async for chunk in fallback_stream:
                        if 'message' in chunk and 'content' in chunk['message']:
                            token = chunk['message']['content']
                            yield f"data: {json.dumps({'token': token})}\n\n"
                    return
                except Exception as fb_err:
                    logger.error(f"Stream fallback failed: {fb_err}")
            payload = {"error": "Lumina couldn't connect. Please try again later."}
            yield f"data: {json.dumps(payload)}\n\n"

ai_service = AIService()
