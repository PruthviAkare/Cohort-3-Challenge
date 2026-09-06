import os
from google.cloud import secretmanager
from typing import Optional

_gemini_api_key: Optional[str] = None

def access_secret() -> str:
    global _gemini_api_key
    if _gemini_api_key:
        return _gemini_api_key

    # For local development, allow env var fallback
    env_key = os.environ.get("GEMINI_API_KEY")
    if env_key:
        _gemini_api_key = env_key
        return _gemini_api_key

    try:
        client = secretmanager.SecretManagerServiceClient()
        project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
        if not project_id:
            raise ValueError("GOOGLE_CLOUD_PROJECT env var is required")
        
        name = f"projects/{project_id}/secrets/GEMINI_API_KEY/versions/latest"
        response = client.access_secret_version(request={"name": name})
        _gemini_api_key = response.payload.data.decode("UTF-8")
        return _gemini_api_key
    except Exception as e:
        print(f"Error loading secret: {e}")
        # Default empty string to prevent crashing at startup, but calls will fail
        return ""
