from fastapi import FastAPI, Depends, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Optional
import os

from auth_middleware import verify_firebase_token
from gemini_helper import generateContentWithFallback
from firestore_client import save_turn, get_session_turns, save_summary, get_sessions, get_session_summary

app = FastAPI()

# Mount body-parser (handled implicitly by Pydantic + FastAPI, but we ensure CORS is set before routes)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Null-safe payload schemas
class ChatRequest(BaseModel):
    sessionId: str
    message: str = Field(default="")

class SummarizeRequest(BaseModel):
    sessionId: str

# TODO: Phase 3 feature enhancement - Implement real-time streaming for Gemini replies
@app.post("/api/chat")
async def chat(request: ChatRequest, token: dict = Depends(verify_firebase_token)):
    uid = token.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    session_id = request.sessionId
    user_msg = request.message
    
    if not user_msg:
         raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Store user turn
    save_turn(uid, session_id, "user", user_msg)
    
    # Call Gemini
    try:
        prompt = f"User journal entry: {user_msg}\n\nRespond thoughtfully as a journaling assistant."
        reply = generateContentWithFallback(prompt)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI generation failed: {str(e)}")
        
    # Store Gemini reply
    save_turn(uid, session_id, "model", reply)
    
    return {"reply": reply}

@app.post("/api/summarize")
async def summarize(request: SummarizeRequest, token: dict = Depends(verify_firebase_token)):
    uid = token.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="User ID not found in token")
        
    session_id = request.sessionId
    
    # Fetch turns
    turns = get_session_turns(uid, session_id)
    if not turns:
        raise HTTPException(status_code=404, detail="No turns found for session")
        
    # Build transcript
    transcript = "\n".join([f"{t.get('role')}: {t.get('content')}" for t in turns])
    
    # Summarize via Gemini
    try:
        prompt = f"Summarize the following journal session:\n\n{transcript}"
        summary_text = generateContentWithFallback(prompt)
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"AI generation failed: {str(e)}")
         
    # Save summary doc
    save_summary(uid, session_id, summary_text)
    
    return {"summary": summary_text}

@app.get("/api/sessions")
async def list_sessions(token: dict = Depends(verify_firebase_token)):
    uid = token.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    sessions = get_sessions(uid)
    return {"sessions": sessions}

@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str, token: dict = Depends(verify_firebase_token)):
    uid = token.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="User ID not found in token")
    
    turns = get_session_turns(uid, session_id)
    summary = get_session_summary(uid, session_id)
    
    return {
        "turns": turns,
        "summary": summary
    }

# Serve the static HTML frontend
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
