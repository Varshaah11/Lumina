import ollama
import logging
from app.core.config import settings

logger = logging.getLogger(__name__)

class OllamaClient:
    def __init__(self, host: str | None = None):
        self.host = host or settings.OLLAMA_HOST
        # Configure client here if needed for custom host, but defaults to localhost:11434
        self.client = ollama.AsyncClient(host=self.host)

    async def generate_chat(self, model: str, messages: list[dict], stream: bool = False):
        """
        Sends a chat completion request to the Ollama server.
        messages format: [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}]
        """
        try:
            response = await self.client.chat(
                model=model,
                messages=messages,
                stream=stream
            )
            return response
        except Exception as e:
            logger.error(f"Error communicating with Ollama: {str(e)}")
            raise e

    async def list_models(self):
        """
        Retrieves the list of locally available models from Ollama.
        """
        try:
            return await self.client.list()
        except Exception as e:
            logger.error(f"Error listing models from Ollama: {str(e)}")
            raise e

ollama_client = OllamaClient()
