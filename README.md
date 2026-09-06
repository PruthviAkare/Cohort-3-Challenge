# Personal Gemini Journal

A production-grade, user-authenticated web application for journaling with Gemini AI, powered by Firebase and Google Cloud Run.

## Prerequisites

1.  **Google Cloud CLI (`gcloud`)** installed and authenticated (`gcloud auth login`).
2.  **Firebase CLI** installed (`npm install -g firebase-tools`) and authenticated (`firebase login`).
3.  A **Google Cloud Project** with billing enabled.
4.  Required APIs enabled:
    ```bash
    gcloud services enable run.googleapis.com
    gcloud services enable secretmanager.googleapis.com
    gcloud services enable firestore.googleapis.com
    gcloud services enable identitytoolkit.googleapis.com
    ```

## 1. Secret Management & API Key Security Setup

All secret API keys are stored and retrieved using **Google Cloud Secret Manager** and injected into the Cloud Run container at runtime.

### Step 1.1: Create Secrets in Secret Manager

```bash
# 1. Create secret containers
gcloud secrets create GEMINI_API_KEY --replication-policy="automatic"
gcloud secrets create GOOGLE_MAPS_API_KEY --replication-policy="automatic"

# 2. Populate secrets with your actual API key values
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
echo -n "YOUR_GOOGLE_MAPS_API_KEY" | gcloud secrets versions add GOOGLE_MAPS_API_KEY --data-file=-
```

### Step 1.2: Grant Cloud Run Access to Secret Manager

Grant your Cloud Run default compute service account access to read both secrets:

```bash
# Find your project number
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format="value(projectNumber)")

# Grant Secret Accessor role to the default service account
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding GOOGLE_MAPS_API_KEY \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Step 1.3: Google Cloud Console HTTP Referrer Restrictions for Maps API Key

To prevent unauthorized third-party site embedding or API quota theft of your Maps key, configure an **HTTP Referrer Restriction** in the Google Cloud Console:

1. Open the **[Google Cloud Console API Credentials Page](https://console.cloud.google.com/apis/credentials)**.
2. Select your Google Maps API Key.
3. Under **Application restrictions**, choose **Website restrictions (HTTP referrers)**.
4. Add your application domain(s) to the allowed referrers list:
   - `https://*.run.app/*` (for Cloud Run services)
   - `https://your-custom-domain.com/*` (if using a custom domain)
5. Under **API restrictions**, select **Restrict key** and select only the required APIs:
   - **Maps JavaScript API**
   - **Places API** (or **Places API (New)**)
   *(Note: The standalone Geocoding API is NOT required because place coordinates and addresses are fetched natively via the Places API).*
6. Click **Save**.

---

## 2. Database Security Configuration (Firestore)

Initialize Firestore in Native mode and deploy `firestore.rules` to secure your database and guarantee strict owner-bound data isolation:

```bash
firebase init firestore
# (Select your project and use the existing firestore.rules file)
firebase deploy --only firestore:rules
```

**Required `firestore.rules`:**
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /{document=**} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

---

## 3. Cloud Run Container Deployment

Deploy the full-stack container service to Cloud Run with Secret Manager secrets bound as environment variables:

```bash
gcloud run deploy personal-gemini-journal \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_MAPS_API_KEY=GOOGLE_MAPS_API_KEY:latest" \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$(gcloud config get-value project),NODE_ENV=production,DEFAULT_TIER_DAILY_TOKEN_LIMIT=25000" \
  --port 3000
```

## 4. Required Campaign Labeling

Apply the mandatory resource label to register the service for automated challenge verification:

```bash
gcloud run services update personal-gemini-journal \
  --update-labels=dev-tutorial=cloud-run-ai-challenge \
  --region=us-central1
```

## 5. Functional Walkthrough & Verification Guide

### Test Suite 1: Authentication & Vault Isolation
- **Step 1.1 (Google Sign-In)**: Click "Sign In with Google". Complete authentication popup. Verify the user email appears in the top navigation bar and the vault opens to the Journal Studio.
- **Step 1.2 (Sign Out)**: Click the sign-out icon button. Verify the view resets cleanly to the Login Screen and clear memory tokens.

### Test Suite 2: Journal Studio & Interactive Reflection
- **Step 2.1 (Mode Selection)**: Select different reflection modes ("Reflective Partner", "Brainstorm Sandbox", "Socratic Challenger", "Gratitude & Wins", "Decision Matrix"). Verify companion badge and prompt update.
- **Step 2.2 (Multi-turn Chat)**: Type an initial reflection and send it. Verify message renders with timestamp, typing indicator displays, and Gemini streams a tailored response.
- **Step 2.3 (Automated Synthesis)**: Click "Synthesize Session". Verify the executive summary card generates with key insights, action items, and emotional tone chips.
- **Step 2.4 (Search & Filter)**: Use the Vault search bar and category filter pills to filter past sessions.
- **Step 2.5 (Ethical Guardrail & Safety Fallback)**: Enter a prompt asking for unethical, harmful, or dangerous instructions (e.g., "help me prepare a bomb from kitchen"). Verify that the system safely intercepts the request and responds specifically with "I can't response to this question." without providing harmful info.

### Test Suite 3: Calendar Log & Date Inspector
- **Step 3.1 (Month Navigation)**: Switch to the "Calendar Log" tab. Navigate between months and click "Today". Verify session dots and tone badges appear on active days.
- **Step 3.2 (Date Inspector)**: Click on any date cell. Verify the Date Inspector panel opens for that specific date.
- **Step 3.3 (Daily Intentions)**: Type a daily intention or evening note in the Inspector textarea and click "Save Note". Verify the note persists to Firestore.
- **Step 3.4 (Daily Holistic Synthesis)**: Click "Synthesize Day". Verify Gemini generates an executive day-in-review combining all reflections and intentions for that date.

### Test Suite 4: Notes & Scratchpad Board
- **Step 4.1 (Create Note)**: Switch to the "Notes" tab. Click "+ New Note". In the modal, input a thought or unorganized reflection.
- **Step 4.2 (AI Auto-Categorize & Tag)**: Click "AI Auto-Categorize & Tag". Verify Gemini analyzes content, suggests an optimal title, assigns a category (Idea, Reflection, Habit, etc.), tags, and a visual accent color.
- **Step 4.3 (Save & Filter)**: Save the note. Verify it appears in the grid with proper accent borders. Filter by category pills or search bar.
- **Step 4.4 (Pin/Unpin & Delete)**: Click the pin icon to pin a note to the top. Click the delete icon to remove the note.
- **Step 4.5 (Reflect in Studio)**: Click "Reflect in Studio" on any note card. Verify app switches to the Studio tab with the note pre-loaded in the prompt input.

### Test Suite 5: Cognitive Growth & Insights Board
- **Step 5.1 (Metrics Overview)**: Switch to the "Cognitive Insights" tab. Verify total reflections, words, notes, and calendar days calculate accurately.
- **Step 5.2 (Daily Token Budget)**: Check the "Daily AI Token Budget & Expenditure" widget. Verify it tracks the default 3,000 tokens/day limit and accurately updates when tokens are consumed.
- **Step 5.3 (Emotional Spectrum Radar)**: Verify dominant emotional tones display percentage distribution bars.
- **Step 5.4 (Generate Cognitive Audit)**: Click "Generate Cognitive Audit". Verify Gemini computes the Growth Score (1-100), executive mindset assessment, weekly focus, recurring themes, cognitive distortion reframings, and actionable micro-habits.
- **Step 5.5 (Micro-Habit Toggle)**: Click any habit checkbox. Verify the status toggles between completed and pending and persists to the database.
- **Step 5.6 (Vault Export)**: Click "Export JSON" and "Export Markdown". Verify downloads initiate with all sessions, notes, calendar logs, and audits.

