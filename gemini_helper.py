import logging
from google import genai
from google.genai import errors
from secret_manager import access_secret

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Fallback ladder as requested
MODELS = [
    "gemini-2.0-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash"
]

RETRYABLE_ERRORS = [429, 500, 503, 404]

client = None

def get_client():
    global client
    if client is None:
        api_key = access_secret()
        client = genai.Client(api_key=api_key)
    return client

def generateContentWithFallback(prompt: str) -> str:
    genai_client = get_client()
    
    for i, model in enumerate(MODELS):
        try:
            logger.info(f"Attempting generation with model: {model}")
            response = genai_client.models.generate_content(
                model=model,
                contents=prompt
            )
            return response.text
        except errors.APIError as e:
            logger.warning(f"Model {model} failed with error: {e}")
            # Check if it's a retryable error code
            if e.code in RETRYABLE_ERRORS and i < len(MODELS) - 1:
                logger.info(f"Falling back to next model...")
                continue
            raise e
        except Exception as e:
            logger.warning(f"Model {model} failed with unexpected error: {e}")
            if i < len(MODELS) - 1:
                continue
            raise e
            
    raise Exception("All fallback models failed.")
