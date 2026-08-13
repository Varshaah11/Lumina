import logging
import json
import re
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

class AIService:
    @staticmethod
    async def get_active_model() -> str:
        """Checks if the primary model is available, otherwise returns the fallback."""
        try:
            response = await ollama_client.list_models()
            models = [m.get("name", "") for m in response.get("models", [])]
            
            # Ollama model names might include tags (e.g., 'llama3.1:8b-instruct-q4_0')
            # Exact match is safest for standard pulls
            if PRIMARY_MODEL in models:
                return PRIMARY_MODEL
            return FALLBACK_MODEL
        except Exception:
            # If listing fails but we can connect, assume fallback
            return FALLBACK_MODEL

    @staticmethod
    async def generate_title(user_message: str) -> str:
        """
        Generates a concise 3-6 word title summarizing the user message using LLM.
        Falls back to truncated user_message on error or for short greetings.
        """
        msg_clean = user_message.strip()
        fallback_title = msg_clean[:50] + "..." if len(msg_clean) > 50 else msg_clean

        if msg_clean.lower() in SHORT_GREETINGS or len(msg_clean) <= 10:
            return fallback_title

        model = await AIService.get_active_model()
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
            response = await ollama_client.generate_chat(model=model, messages=messages, stream=False)
            if 'message' in response and 'content' in response['message']:
                raw_title = response['message']['content']
                return sanitize_title(raw_title, fallback_title)
        except Exception as e:
            logger.warning(f"AI Title generation failed: {e}")

        return fallback_title

    @staticmethod
    async def get_chat_response(user_message: str = None, messages_history: list = None, user_name: str = "User") -> str:
        """
        Builds the conversation history and queries the LLM.
        """
        system_prompt = get_system_prompt(user_name)
        model = await AIService.get_active_model()
        
        messages = [{"role": "system", "content": system_prompt}]
        if messages_history:
            messages.extend(messages_history)
        elif user_message:
            messages.append({"role": "user", "content": user_message})
        
        try:
            # We are using stream=False for Phase 6.1, preparing for True in later phases.
            response = await ollama_client.generate_chat(model=model, messages=messages, stream=False)
            
            if 'message' in response and 'content' in response['message']:
                return response['message']['content']
            else:
                logger.error(f"Unexpected response format from Ollama: {response}")
                raise Exception("Invalid response format from AI model.")
                
        except ConnectError:
            logger.error("Could not connect to Ollama. Is it running?")
            raise Exception("AI backend is currently offline. Please try again later.")
        except Exception as e:
            logger.error(f"AI Service Error: {str(e)}")
            error_msg = str(e)
            if "not found" in error_msg.lower():
                raise Exception(f"Model {model} not found in local Ollama instance.")
            raise Exception(f"An error occurred while generating the response: {error_msg}")

    @staticmethod
    async def stream_chat_response(user_message: str = None, messages_history: list = None, user_name: str = "User"):
        """
        Builds the conversation history and streams the query to the LLM.
        """
        system_prompt = get_system_prompt(user_name)
        model = await AIService.get_active_model()
        
        messages = [{"role": "system", "content": system_prompt}]
        if messages_history:
            messages.extend(messages_history)
        elif user_message:
            messages.append({"role": "user", "content": user_message})
        
        try:
            response_stream = await ollama_client.generate_chat(model=model, messages=messages, stream=True)
            
            async for chunk in response_stream:
                if 'message' in chunk and 'content' in chunk['message']:
                    token = chunk['message']['content']
                    yield f"data: {json.dumps({'token': token})}\n\n"
                    
        except ConnectError:
            logger.error("Could not connect to Ollama. Is it running?")
            payload = {"error": "Lumina couldn't connect. Please try again later."}
            yield f"data: {json.dumps(payload)}\n\n"
        except Exception as e:
            logger.error(f"AI Service Error: {str(e)}")
            payload = {"error": "Lumina couldn't connect. Please try again later."}
            yield f"data: {json.dumps(payload)}\n\n"

ai_service = AIService()
