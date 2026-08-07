import logging
import json
from httpx import ConnectError
from app.ai.client import ollama_client
from app.ai.prompts import get_system_prompt

logger = logging.getLogger(__name__)

# Recommended default model
PRIMARY_MODEL = "llama3.1:8b"
FALLBACK_MODEL = "llama3.2:3b"

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
