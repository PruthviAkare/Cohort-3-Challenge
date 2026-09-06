import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime
import uuid

# Initialize Firebase Admin if not already initialized
if not firebase_admin._apps:
    # Use application default credentials
    firebase_admin.initialize_app(options={"projectId": "gen-lang-client-0619523054"})

# Use the specific database provisioned for this applet
try:
    db = firestore.client(database="ai-studio-cf5010ae-a79c-44e9-8e35-cade43a51977")
except TypeError:
    # Fallback if the firebase-admin version doesn't support 'database' arg
    from google.cloud import firestore as google_firestore
    db = google_firestore.Client(project="gen-lang-client-0619523054", database="ai-studio-cf5010ae-a79c-44e9-8e35-cade43a51977")

def strip_none(data: dict) -> dict:
    """Recursively strip None values to satisfy undefined-stripping requirement."""
    if not isinstance(data, dict):
        return data
    return {k: v for k, v in data.items() if v is not None}

def save_turn(uid: str, session_id: str, role: str, content: str):
    doc_ref = db.collection('users').document(uid).collection('sessions').document(session_id)
    
    # Ensure session metadata exists
    doc = doc_ref.get()
    now = firestore.SERVER_TIMESTAMP
    if not doc.exists:
        doc_ref.set(strip_none({
            "createdAt": now,
            "updatedAt": now,
            "title": f"Session {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        }))
    else:
        doc_ref.update({"updatedAt": now})
        
    turn_id = str(uuid.uuid4())
    turn_ref = doc_ref.collection('turns').document(turn_id)
    turn_ref.set(strip_none({
        "role": role,
        "content": content,
        "timestamp": now
    }))

def get_session_turns(uid: str, session_id: str) -> list:
    turns_ref = db.collection('users').document(uid).collection('sessions').document(session_id).collection('turns')
    turns = turns_ref.order_by('timestamp').stream()
    return [t.to_dict() for t in turns]

def save_summary(uid: str, session_id: str, summary_text: str):
    summary_ref = db.collection('users').document(uid).collection('sessions').document(session_id).collection('summary').document('main')
    summary_ref.set(strip_none({
        "text": summary_text,
        "generatedAt": firestore.SERVER_TIMESTAMP
    }))

def get_sessions(uid: str) -> list:
    sessions_ref = db.collection('users').document(uid).collection('sessions')
    sessions = sessions_ref.order_by('updatedAt', direction=firestore.Query.DESCENDING).stream()
    result = []
    for s in sessions:
        data = s.to_dict()
        data['id'] = s.id
        result.append(data)
    return result

def get_session_summary(uid: str, session_id: str):
    summary_ref = db.collection('users').document(uid).collection('sessions').document(session_id).collection('summary').document('main')
    doc = summary_ref.get()
    return doc.to_dict() if doc.exists else None
