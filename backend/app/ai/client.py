import ollama
import logging
from app.core.config import settings

logger = logging.getLogger(__name__)

class OllamaClient:
    def __init__(self, host: str | None = None):
        self.host = host or settings.OLLAMA_HOST
        # Configure client here if needed for custom host, but defaults to localhost:11434
        self.client = ollama.AsyncClient(host=self.host)

    async def generate_chat(self, model: str, messages: list[dict], stream: bool = False, options: dict | None = None):
        """
        Sends a chat completion request to the Ollama server.
        messages format: [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}]
        """
        chat_options = {"num_ctx": settings.OLLAMA_NUM_CTX}
        if options:
            chat_options.update(options)

        try:
            response = await self.client.chat(
                model=model,
                messages=messages,
                stream=stream,
                options=chat_options
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

    async def get_embedding(self, text: str, model: str | None = None) -> list[float]:
        """
        Generates an embedding vector for a single string.
        """
        embed_model = model or settings.EMBEDDING_MODEL
        try:
            res = await self.client.embeddings(model=embed_model, prompt=text)
            return res.get("embedding", [])
        except Exception as e:
            logger.error(f"Error generating embedding with model {embed_model}: {str(e)}")
            raise e

    async def get_embeddings_batch(self, texts: list[str], model: str | None = None) -> list[list[float]]:
        """
        Generates embedding vectors for a batch of strings.
        """
        if not texts:
            return []
        embed_model = model or settings.EMBEDDING_MODEL
        try:
            res = await self.client.embed(model=embed_model, input=texts)
            embeddings = getattr(res, "embeddings", None)
            if embeddings is None and isinstance(res, dict):
                embeddings = res.get("embeddings", [])
            return embeddings or []
        except Exception as e:
            logger.warning(f"Batch embed failed with {embed_model}, falling back to sequential: {str(e)}")
            # Fallback to sequential calls if batch embed endpoint is not supported
            results = []
            for t in texts:
                emb = await self.get_embedding(t, model=embed_model)
                results.append(emb)
            return results

ollama_client = OllamaClient()
