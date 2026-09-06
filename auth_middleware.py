from fastapi import Request, HTTPException
from firebase_admin import auth
import logging

logger = logging.getLogger(__name__)

async def verify_firebase_token(request: Request):
    """
    Dependency for FastAPI to verify Firebase Auth JWT
    """
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    
    token = auth_header.split(" ")[1]
    try:
        decoded_token = auth.verify_id_token(token)
        return decoded_token
    except Exception as e:
        logger.error(f"Token verification failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")
