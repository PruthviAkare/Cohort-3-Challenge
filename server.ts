import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// Initialize Firebase Admin SDK
if (!getApps().length) {
  try {
    initializeApp({
      projectId: "gen-lang-client-0619523054",
    });
  } catch (err) {
    console.warn("Firebase admin initialization warning:", err);
  }
}

// Target database: ai-studio-cf5010ae-a79c-44e9-8e35-cade43a51977
let db: Firestore | null = null;
let firestoreDisabled = false;
let firestoreNoticeLogged = false;

try {
  // @ts-ignore
  db = getFirestore("ai-studio-cf5010ae-a79c-44e9-8e35-cade43a51977");
} catch (err) {
  try {
    db = getFirestore();
  } catch (e) {
    db = null;
  }
}

// Safe Firestore execution helper that handles permission boundaries gracefully
async function safeFirestore<T>(op: (client: Firestore) => Promise<T>): Promise<T | null> {
  if (!db || firestoreDisabled) return null;
  try {
    return await op(db);
  } catch (err: any) {
    const isPermissionError = err?.code === 7 || err?.message?.includes("PERMISSION_DENIED");
    if (isPermissionError) {
      firestoreDisabled = true;
      if (!firestoreNoticeLogged) {
        console.log("Firestore using durable local storage store fallback (server-side sandbox environment).");
        firestoreNoticeLogged = true;
      }
    }
    return null;
  }
}

// Zero-crash payload hygiene: strip undefined values
function sanitizePayload<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_, v) => (v === undefined ? null : v)));
}

// Durable local storage path for session persistence
import fs from "fs";
const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "journal_store.json");

interface SessionRecord {
  id: string;
  mode: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  moodEmoji?: string;
  moodLabel?: string;
  location?: { lat: number; lng: number; address: string; name?: string };
  hasSummary?: boolean;
  summary?: {
    text: string;
    summary?: string;
    emotionalTone: string[];
    actionItems: string[];
    moodEmoji?: string;
    moodLabel?: string;
  location?: { lat: number; lng: number; address: string; name?: string };
    generatedAt: string;
  } | null;
  turns: Array<{ role: "user" | "model"; content: string; timestamp: string }>;
}

interface CalendarDayRecord {
  date: string;
  note: string;
  moodEmoji?: string;
  moodLabel?: string;
  location?: { lat: number; lng: number; address: string; name?: string };
  daySummary?: string | null;
  updatedAt: string;
}

interface NoteRecord {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  color: string;
  isPinned: boolean;
  moodEmoji?: string;
  moodLabel?: string;
  location?: { lat: number; lng: number; address: string; name?: string };
  createdAt: string;
  updatedAt: string;
}

interface CognitiveAuditRecord {
  id: string;
  generatedAt: string;
  growthScore: number;
  mindsetAssessment: string;
  topThemes: string[];
  cognitiveDistortions: Array<{ distortion: string; quote: string; reframingSuggestion: string }>;
  habits: Array<{ id: string; action: string; frequency: string; completed: boolean }>;
  weeklyFocus: string;
}

interface DailyUsageRecord {
  date: string; // YYYY-MM-DD (UTC)
  tokensUsed: number;
  tokenLimit: number; // 25000 for default tier
  tier: "default" | "pro" | "custom_key";
  requestCount: number;
  lastUpdated: string;
}

interface UserDataStore {
  sessions: Record<string, SessionRecord>;
  calendarNotes: Record<string, CalendarDayRecord>;
  notes: Record<string, NoteRecord>;
  latestAudit?: CognitiveAuditRecord | null;
  dailyUsage?: DailyUsageRecord;
}

interface LocalDatabase {
  users: Record<string, UserDataStore>;
}

// Daily token limit for default tier (reads from env var or defaults to 25,000 tokens per day per user)
const DEFAULT_TIER_DAILY_TOKEN_LIMIT = parseInt(process.env.DEFAULT_TIER_DAILY_TOKEN_LIMIT || "25000", 10);
const userRateLimitMap: Record<string, number[]> = {};

function getCustomApiKey(req: Request): string | undefined {
  const headerKey = req.headers["x-gemini-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }
  const bodyKey = (req.body && typeof req.body === "object" ? (req.body as any).customApiKey : undefined);
  if (typeof bodyKey === "string" && bodyKey.trim()) {
    return bodyKey.trim();
  }
  return undefined;
}

function getTodayUTCDateString(): string {
  return new Date().toISOString().split("T")[0];
}

function estimateTokens(contents: string | any[]): number {
  if (typeof contents === "string") {
    return Math.max(1, Math.ceil(contents.length / 3.8));
  }
  if (Array.isArray(contents)) {
    let str = "";
    for (const item of contents) {
      if (typeof item === "string") str += item;
      else if (item && typeof item === "object") {
        if (item.parts) {
          for (const p of item.parts) str += (p.text || "") + " ";
        } else if (item.text) {
          str += item.text + " ";
        } else {
          str += JSON.stringify(item);
        }
      }
    }
    return Math.max(1, Math.ceil(str.length / 3.8));
  }
  return 100;
}

// =========================================================
// ETHICAL & LEGAL COMPLIANCE GUARDRAILS ENGINE
// =========================================================
const PROHIBITED_PATTERNS = [
  // 1. Cybercrime, Hacking & Malware
  { pattern: /\b(ddos|botnet|keylogger|ransomware|trojan|sql injection|xss payload|zero-day exploit|bypass firewall|crack password|steal credentials|hack into|unauthorized access)\b/i, category: "Cybersecurity & Unauthorized Access", reason: "Planning or executing cyberattacks, unauthorized system infiltration, or malware deployment is strictly prohibited." },
  // 2. Physical Violence, Weapons & Terrorism
  { pattern: /\b(build a bomb|make an explosive|manufacture weapons|assassinate|physical assault|homemade firearm|poison someone|commit terrorism|mass shooting|inflict physical harm)\b/i, category: "Physical Violence & Weapons", reason: "Generating instructions, plans, or assistance for physical violence, weapons creation, or bodily harm is strictly prohibited." },
  // 3. Fraud, Money Laundering & Financial Crimes
  { pattern: /\b(money laundering|credit card fraud|forge checks|counterfeit currency|identity theft|tax evasion scheme|ponzi scheme|phishing scam|wire fraud|insider trading plan)\b/i, category: "Fraud & Financial Crimes", reason: "Developing financial scams, identity theft schemes, money laundering, or illegal deceptive practices is strictly prohibited." },
  // 4. Illicit Substances & Black Market
  { pattern: /\b(synthesize fentanyl|manufacture methamphetamine|darknet drug marketplace|smuggle contraband|unregulated narcotic synthesis|buy illegal firearms)\b/i, category: "Illicit Substances & Contraband", reason: "Facilitating illicit drug synthesis, black market commerce, or distribution of prohibited substances is strictly prohibited." },
  // 5. Psychological Manipulation & Coercion
  { pattern: /\b(how to gaslight|psychologically break someone|blackmail someone|extort money from|coercive control tactics|manipulate partner into submission|non-consensual surveillance|stalking tactics|covertly track location)\b/i, category: "Psychological Harm & Harassment", reason: "Planning psychological manipulation, gaslighting, extortion, stalking, or non-consensual surveillance violates fundamental ethical safety standards." },
  // 6. Academic Dishonesty & Forgery
  { pattern: /\b(forge doctor's note|fake legal affidavit|cheat on proctored exam|forge official government document)\b/i, category: "Document Forgery & Fraud", reason: "Creating forged credentials, fraudulent legal documents, or counterfeit official records is prohibited." },
];

function checkEthicalAndLegalGuardrails(text: string): { isViolating: boolean; reason?: string; category?: string } {
  if (!text || typeof text !== "string") return { isViolating: false };
  const cleaned = text.trim();

  for (const rule of PROHIBITED_PATTERNS) {
    if (rule.pattern.test(cleaned)) {
      return {
        isViolating: true,
        category: rule.category,
        reason: rule.reason,
      };
    }
  }

  return { isViolating: false };
}

let dbStore: LocalDatabase = { users: {} };

function loadLocalStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(STORE_PATH)) {
      const content = fs.readFileSync(STORE_PATH, "utf-8");
      dbStore = JSON.parse(content);
      if (!dbStore.users) dbStore.users = {};
    }
  } catch (err) {
    console.warn("Could not load local journal store:", err);
    dbStore = { users: {} };
  }
}

function saveLocalStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(dbStore, null, 2), "utf-8");
  } catch (err) {
    console.warn("Could not write local journal store:", err);
  }
}

loadLocalStore();

function getUserStore(uid: string): UserDataStore {
  if (!dbStore.users[uid]) {
    loadLocalStore();
  }
  if (!dbStore.users[uid]) {
    dbStore.users[uid] = { sessions: {}, calendarNotes: {}, notes: {}, latestAudit: null };
  }
  if (!dbStore.users[uid].calendarNotes) {
    dbStore.users[uid].calendarNotes = {};
  }
  if (!dbStore.users[uid].notes) {
    dbStore.users[uid].notes = {};
  }
  return dbStore.users[uid];
}

function getUserUsageRecord(uid: string): DailyUsageRecord {
  const store = getUserStore(uid);
  const today = getTodayUTCDateString();
  if (!store.dailyUsage || store.dailyUsage.date !== today) {
    store.dailyUsage = {
      date: today,
      tokensUsed: 0,
      tokenLimit: DEFAULT_TIER_DAILY_TOKEN_LIMIT,
      tier: "default",
      requestCount: 0,
      lastUpdated: new Date().toISOString(),
    };
    saveLocalStore();
  } else if (store.dailyUsage.tier === "default" && store.dailyUsage.tokenLimit !== DEFAULT_TIER_DAILY_TOKEN_LIMIT) {
    store.dailyUsage.tokenLimit = DEFAULT_TIER_DAILY_TOKEN_LIMIT;
    saveLocalStore();
  }
  return store.dailyUsage;
}

function checkTokenBudget(
  uid: string,
  estimatedInputTokens: number = 0,
  customApiKey?: string
): { allowed: boolean; usage: DailyUsageRecord; error?: string } {
  const usage = getUserUsageRecord(uid);

  // If user provides a custom Gemini API Key, bypass shared quota checks entirely
  if (customApiKey) {
    return {
      allowed: true,
      usage: {
        ...usage,
        tier: "custom_key",
        tokenLimit: Infinity,
      },
    };
  }

  // Sliding window rate limiter (max 10 requests per minute per user on shared key)
  const nowMs = Date.now();
  if (!userRateLimitMap[uid]) {
    userRateLimitMap[uid] = [];
  }
  userRateLimitMap[uid] = userRateLimitMap[uid].filter((t) => nowMs - t < 60000);
  if (userRateLimitMap[uid].length >= 10) {
    return {
      allowed: false,
      usage,
      error: "Rate limit reached (max 10 requests/min per user on shared key). Please wait a few seconds or add a custom API key in Settings.",
    };
  }

  if (usage.tier === "default" && (usage.tokensUsed + estimatedInputTokens) > usage.tokenLimit) {
    const remaining = Math.max(0, usage.tokenLimit - usage.tokensUsed);
    return {
      allowed: false,
      usage,
      error: `Daily token limit reached for Default Shared Tier (${usage.tokensUsed.toLocaleString()} / ${usage.tokenLimit.toLocaleString()} tokens used today). Quota resets at 00:00 UTC. Available: ${remaining} tokens. Provide your own Gemini API key in Settings for unlimited requests.`,
    };
  }

  userRateLimitMap[uid].push(nowMs);
  return { allowed: true, usage };
}

function consumeTokens(uid: string, actualTokens: number) {
  const usage = getUserUsageRecord(uid);
  usage.tokensUsed += Math.max(1, actualTokens);
  usage.requestCount += 1;
  usage.lastUpdated = new Date().toISOString();
  saveLocalStore();
}

// Initialize Gemini API with Fallback Protocol
// Order: Primary (gemini-3.6-flash), HA Fallback (gemini-3.1-flash-lite), Dynamic Alias (gemini-flash-latest), Deep Reasoning (gemini-3.7-flash)
const FALLBACK_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemini-3.7-flash",
];

function formatGeminiError(err: any): string {
  if (!err) return "Unknown Gemini error";
  let msg = typeof err === "object" ? (err.message || String(err)) : String(err);
  if (typeof msg === "string" && msg.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(msg.trim());
      if (parsed?.error?.message) {
        msg = parsed.error.message;
      }
    } catch (_) {}
  }
  if (
    msg.includes("prepayment credits are depleted") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("429")
  ) {
    return "Shared Gemini API key quota or prepayment credits are depleted. Please click Settings (Gear Icon) in the top header to enter your custom Gemini API Key, or manage billing at https://ai.studio/projects.";
  }
  return msg;
}

async function generateWithFallback(
  contents: string | any[],
  systemInstruction?: string,
  customApiKey?: string
) {
  const apiKey = customApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured. Click Settings (Gear Icon) to enter your custom Gemini API Key.");
  }
  const ai = new GoogleGenAI({ apiKey });
  let lastError: any = null;
  let isCreditDepleted = false;

  for (const model of FALLBACK_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: systemInstruction ? { systemInstruction } : undefined,
      });
      if (response && response.text) {
        return response.text;
      }
    } catch (err: any) {
      const rawMsg = err?.message || String(err || "");
      console.warn(`Model ${model} in fallback ladder failed:`, rawMsg);
      if (
        rawMsg.includes("prepayment credits are depleted") ||
        rawMsg.includes("RESOURCE_EXHAUSTED") ||
        rawMsg.includes("429")
      ) {
        isCreditDepleted = true;
      }
      lastError = err;
    }
  }

  if (isCreditDepleted) {
    throw new Error("Shared Gemini API key quota or prepayment credits are depleted. Please click Settings (Gear Icon) in the top header to enter your custom Gemini API Key, or manage billing at https://ai.studio/projects.");
  }

  throw new Error(formatGeminiError(lastError));
}

async function hydrateUserStoreFromFirestore(uid: string) {
  const store = getUserStore(uid);
  if ((store as any).hydrated) return;

  await safeFirestore(async (client) => {
    // Fetch Sessions
    const sessionsSnap = await client.collection("users").doc(uid).collection("sessions").get();
    sessionsSnap.docs.forEach((doc) => {
      store.sessions[doc.id] = { id: doc.id, ...doc.data() } as SessionRecord;
    });

    // Fetch Calendar Notes
    const calSnap = await client.collection("users").doc(uid).collection("calendar").get();
    calSnap.docs.forEach((doc) => {
      store.calendarNotes[doc.id] = { date: doc.id, ...doc.data() } as CalendarDayRecord;
    });

    // Fetch Notes
    const notesSnap = await client.collection("users").doc(uid).collection("notes").get();
    notesSnap.docs.forEach((doc) => {
      store.notes[doc.id] = { id: doc.id, ...doc.data() } as NoteRecord;
    });

    // Fetch Insights
    const insightsDoc = await client.collection("users").doc(uid).collection("insights").doc("latest").get();
    if (insightsDoc.exists) {
      store.latestAudit = insightsDoc.data() as CognitiveAuditRecord;
    }

    (store as any).hydrated = true;
    return true;
  });
}

// Auth Middleware
async function authenticate(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const token = authHeader.split("Bearer ")[1].trim();
  if (!token) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
    (req as any).user = decoded;
    await hydrateUserStoreFromFirestore(decoded.uid);
    return next();
  } catch (err: any) {
    // If running in development without Cloud Run service credentials, safely parse unverified token payload
    try {
      const base64Payload = token.split(".")[1];
      if (base64Payload) {
        const decodedPayload = JSON.parse(Buffer.from(base64Payload, "base64").toString("utf-8"));
        if (decodedPayload.sub || decodedPayload.user_id) {
          const uid = decodedPayload.user_id || decodedPayload.sub;
          (req as any).user = {
            uid,
            email: decodedPayload.email,
            name: decodedPayload.name,
          };
          await hydrateUserStoreFromFirestore(uid);
          return next();
        }
      }
    } catch (parseErr) {
      // Ignore
    }
    return res.status(401).json({ error: "Unauthorized token: " + (err?.message || "Invalid token") });
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // 1. Top-Level Request Deserialization
  app.use(express.json());

  // 2. Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // 2b. GET /api/user/usage - Real-time daily token limit and tier usage
  app.get("/api/user/usage", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const customApiKey = getCustomApiKey(req);
    const usage = getUserUsageRecord(uid);
    const now = new Date();
    const endOfDayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const secondsToReset = Math.max(0, Math.floor((endOfDayUTC.getTime() - now.getTime()) / 1000));
    const hoursToReset = (secondsToReset / 3600).toFixed(1);

    const activeTier = customApiKey ? "custom_key" : usage.tier;
    const activeLimit = customApiKey ? Infinity : usage.tokenLimit;

    return res.json({
      tier: activeTier,
      date: usage.date,
      tokensUsed: usage.tokensUsed,
      tokenLimit: activeLimit,
      hasCustomApiKey: Boolean(customApiKey),
      remainingTokens: customApiKey ? "Unlimited" : Math.max(0, usage.tokenLimit - usage.tokensUsed),
      percentUsed: customApiKey ? 0 : Math.min(100, Math.round((usage.tokensUsed / usage.tokenLimit) * 100)),
      requestCount: usage.requestCount,
      resetsIn: `${hoursToReset} hrs (00:00 UTC)`,
      lastUpdated: usage.lastUpdated,
    });
  });

  // 2c. GET /api/guardrails/status - Ethical, Legal and Safety Guardrails Status
  app.get("/api/guardrails/status", (_req: Request, res: Response) => {
    return res.json({
      status: "active",
      enforcementMode: "strict_constitutional_filtering",
      dailyTokenLimitDefaultTier: DEFAULT_TIER_DAILY_TOKEN_LIMIT,
      activeGuardrails: [
        {
          id: "zero_illegal_harm",
          name: "Zero Illegal Activities & Harm",
          status: "ENFORCED",
          description: "Strict filter prohibiting weapons, violence, terrorism, cyberattacks, darknet trafficking, and theft.",
        },
        {
          id: "zero_unethical_manipulation",
          name: "Moral & Ethical Integrity",
          status: "ENFORCED",
          description: "Prohibits psychological coercion, gaslighting, extortion, non-consensual tracking, harassment, and document forgery.",
        },
        {
          id: "crisis_lifeline_redirection",
          name: "Crisis & Self-Harm Compassionate Support",
          status: "ENFORCED",
          description: "Immediate compassionate redirection and 988 Lifeline support resources.",
        },
        {
          id: "domain_boundary_enforcement",
          name: "Reflective Journaling Domain Scope",
          status: "ENFORCED",
          description: "Ensures AI acts as an introspective thinking partner rather than an unconstrained utility.",
        },
        {
          id: "daily_token_quota",
          name: "Daily Token Quota (Default Tier)",
          status: "ACTIVE",
          description: `${DEFAULT_TIER_DAILY_TOKEN_LIMIT.toLocaleString()} tokens per day for default tier, resetting at 00:00 UTC.`,
        },
      ],
    });
  });

  // 3. GET /api/sessions
  app.get("/api/sessions", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const firestoreSessions = await safeFirestore(async (client) => {
      const snapshot = await client
        .collection("users")
        .doc(uid)
        .collection("sessions")
        .orderBy("updatedAt", "desc")
        .get();

      if (!snapshot.empty) {
        return snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
      }
      return null;
    });

    if (firestoreSessions) {
      return res.json({ sessions: firestoreSessions });
    }

    // Local durable store
    const userStore = getUserStore(uid);
    const sessions = Object.values(userStore.sessions).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return res.json({ sessions });
  });

  // 4. GET /api/sessions/:id
  app.get("/api/sessions/:id", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const sessionId = req.params.id;

    const firestoreData = await safeFirestore(async (client) => {
      const sessionDoc = await client
        .collection("users")
        .doc(uid)
        .collection("sessions")
        .doc(sessionId)
        .get();

      if (sessionDoc.exists) {
        const turnsSnap = await sessionDoc.ref.collection("turns").orderBy("timestamp", "asc").get();
        const turns = turnsSnap.docs.map((d) => d.data());
        const summaryDoc = await sessionDoc.ref.collection("summary").doc("main").get();
        return {
          session: sessionDoc.data(),
          turns,
          summary: summaryDoc.exists ? summaryDoc.data() : null,
        };
      }
      return null;
    });

    if (firestoreData) {
      return res.json(firestoreData);
    }

    const userStore = getUserStore(uid);
    const session = userStore.sessions[sessionId];
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    return res.json({
      session,
      turns: session.turns || [],
      summary: session.summary || null,
    });
  });

  // 5. DELETE /api/sessions/:id
  app.delete("/api/sessions/:id", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const sessionId = req.params.id;

    await safeFirestore(async (client) => {
      await client.collection("users").doc(uid).collection("sessions").doc(sessionId).delete();
    });

    const userStore = getUserStore(uid);
    if (userStore.sessions[sessionId]) {
      delete userStore.sessions[sessionId];
      saveLocalStore();
    }
    return res.json({ success: true });
  });

  // 6. POST /api/chat (Multi-turn conversation memory with resilient Gemini fallback)
  app.post("/api/chat", authenticate, async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      sessionId?: string;
      message?: string;
      mode?: string;
    };

    const uid = (req as any).user.uid;
    const sessionId = body.sessionId || `session_${Date.now()}`;
    const userMessage = (body.message || "").trim();
    const mode = body.mode || "Reflective Journaling";

    if (!userMessage) {
      return res.status(400).json({ error: "Message content cannot be empty." });
    }

    // Step 1: Pre-flight Ethical & Legality Guardrails Fast Screening
    const guardrailCheck = checkEthicalAndLegalGuardrails(userMessage);
    if (guardrailCheck.isViolating) {
      const reply = "I can't response to this question.";
      const now = new Date().toISOString();
      const turnUser = { role: "user" as const, content: userMessage, timestamp: now };
      const turnModel = { role: "model" as const, content: reply, timestamp: new Date().toISOString() };

      const userStore = getUserStore(uid);
      let session = userStore.sessions[sessionId];
      
      if (!session) {
        session = {
          id: sessionId,
          mode,
          title: userMessage.slice(0, 48) + (userMessage.length > 48 ? "..." : ""),
          createdAt: now,
          updatedAt: now,
          turns: [],
        };
        userStore.sessions[sessionId] = session;
      }
      session.mode = mode;
      session.updatedAt = now;
      session.turns.push(turnUser, turnModel);
      saveLocalStore();

      try {
        if (db) {
          const sessionRef = db.collection("users").doc(uid).collection("sessions").doc(sessionId);
          await sessionRef.set(
            sanitizePayload({
              id: sessionId,
              mode,
              title: session.title,
              updatedAt: now,
              createdAt: session.createdAt || now,
            }),
            { merge: true }
          );

          await sessionRef.collection("turns").add(sanitizePayload(turnUser));
          await sessionRef.collection("turns").add(sanitizePayload(turnModel));
        }
      } catch (dbErr) {
        console.warn("Firestore save turn error:", dbErr);
      }

      return res.json({
        reply,
        sessionId,
        turns: session.turns,
        tokenUsage: getUserUsageRecord(uid),
      });
    }

    // Mode-specific Guardrails & Persona Instructions
    let systemInstruction = `You are an insightful, empathetic, and secure personal journaling companion.`;
    
    // Strict Safety & Boundary Protocols
    const baseGuardrails = `
CRITICAL SAFETY & ETHICAL SCOPE GUARDRAILS:
1. Crisis & Safety: If the user communicates immediate intent for self-harm, suicide, or severe crisis, respond with unconditional warmth and provide immediate support resources: "I hear that you're going through a deeply challenging moment. Please know you are not alone and support is available right now. You can call or text 988 (Suicide & Crisis Lifeline) anytime 24/7 for free, confidential support, or reach out to your local emergency services."
2. Zero Illegal Acts & Ethical Integrity: You are STRICTLY FORBIDDEN from assisting, planning, validating, or optimizing illegal acts (cyberattacks, weapons, fraud, violence, hacking, theft, drug trafficking, document forgery) or morally unethical conduct (psychological manipulation, gaslighting, extortion, non-consensual tracking, harassment). If the user attempts to formulate, test, or execute an illegal or unethical plan (even as a hypothetical scenario), firmly refuse to assist with the prohibited aspect, explain the ethical/legal boundary calmly, and redirect towards constructive, legal, and ethical personal reflection.
3. Journal Domain Integrity: You are a reflective journaling companion and cognitive thinking partner. You are NOT an arbitrary utility bot for writing bulk code, homework cheat answers, generic web scraping, legal litigation advice, or financial trading calls. If a user asks a query completely detached from personal reflection, gently acknowledge the query and redirect to how it impacts their personal goals, feelings, decisions, or self-growth.
4. Constructive & Non-Judgmental: Maintain a compassionate, grounding, and psychologically safe presence.`;

    if (mode === "Reflective Journaling") {
      systemInstruction = `${baseGuardrails}
CURRENT MODE: Reflective Journaling
PRIMARY PURPOSE: Deep personal introspection, emotional clarity, values alignment, and retrospective awareness.
PERMITTED & ENCOURAGED QUESTIONS:
- Exploring authentic feelings, fears, hopes, and relationships.
- Unpacking daily events, stressors, or personal milestones.
- Clarifying personal core values, motivations, and life transitions.
- Mindful Socratic questioning into "Why do I feel this way?" or "What is this situation teaching me?"
GUARDRAIL ENFORCEMENT:
- Do not provide quick superficial fixes. Ask gentle, thought-provoking Socratic questions.
- If asked unrelated technical or transactional questions, invite the user to explore what underlying thoughts or feelings led them to this topic.`;
    } else if (mode === "Creative Brainstorm") {
      systemInstruction = `${baseGuardrails}
CURRENT MODE: Creative Brainstorm
PRIMARY PURPOSE: Expansive lateral thinking, associative ideas, metaphors, narrative exploration, and unlocking creative breakthroughs.
PERMITTED & ENCOURAGED QUESTIONS:
- Generating project ideas, creative writing seeds, and metaphors.
- Exploring "What if?" possibilities and non-linear associations.
- Brainstorming hobbies, artistic concepts, and visionary goals.
GUARDRAIL ENFORCEMENT:
- Avoid mundane linear advice; provide 2-3 evocative, diverse angles or metaphors.
- Reject harmful, illegal, or destructive ideation by steering towards constructive and ethical creative expressions.`;
    } else if (mode === "Problem Solver") {
      systemInstruction = `${baseGuardrails}
CURRENT MODE: Problem Solver
PRIMARY PURPOSE: Structured cognitive problem deconstruction (Root-cause 5 Whys, identifying assumptions, cognitive distortions, tradeoff analysis, actionable micro-steps).
PERMITTED & ENCOURAGED QUESTIONS:
- Dissecting difficult dilemmas, interpersonal conflicts, productivity friction, or decision fatigue.
- Weighing pros and cons of major personal choices.
- Breaking overwhelming projects into low-friction next actions.
GUARDRAIL ENFORCEMENT:
- Focus on what is within the user's direct circle of control.
- Never provide formal medical diagnosis, legal counsel, or certified financial advice; encourage seeking accredited professionals when relevant.
- Always conclude with 1-2 practical, high-impact micro-steps.`;
    } else if (mode === "Gratitude & Wins") {
      systemInstruction = `${baseGuardrails}
CURRENT MODE: Gratitude & Wins
PRIMARY PURPOSE: Positive psychology anchoring, celebrating micro-wins, savoring progress, acknowledging supportive relationships, building self-compassion.
PERMITTED & ENCOURAGED QUESTIONS:
- Highlighting micro-wins, moments of joy, or silver linings.
- Acknowledging mentors, loved ones, or daily blessings.
- Reframing self-criticism into self-compassion and appreciation.
GUARDRAIL ENFORCEMENT:
- Counter negativity bias by helping the user savor the sensory and emotional depth of their positive experience.
- Deflect cynicism or self-sabotage with compassionate validation and gentle re-anchoring to gratitude.`;
    }

    try {
      // 1. Retrieve existing turns for multi-turn conversational memory
      let priorTurns: Array<{ role: "user" | "model"; content: string; timestamp?: string }> = [];

      // Try Firestore
      try {
        if (db) {
          const turnsSnap = await db
            .collection("users")
            .doc(uid)
            .collection("sessions")
            .doc(sessionId)
            .collection("turns")
            .orderBy("timestamp", "asc")
            .get();
          if (!turnsSnap.empty) {
            priorTurns = turnsSnap.docs.map((d) => d.data() as any);
          }
        }
      } catch (err) {
        // Fallback to local store
      }

      const userStore = getUserStore(uid);
      let session = userStore.sessions[sessionId];
      if (!priorTurns.length && session && session.turns) {
        priorTurns = session.turns;
      }

      // 2. Build multi-turn contents array for Gemini
      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = priorTurns.map((turn) => ({
        role: turn.role === "user" ? "user" : "model",
        parts: [{ text: turn.content }],
      }));
      contents.push({
        role: "user",
        parts: [{ text: userMessage }],
      });

      // Step 2: Daily Token Budget Rate Limiter Check for Default Tier
      const customApiKey = getCustomApiKey(req);
      const estimatedInputTokens = estimateTokens(contents);
      const budgetCheck = checkTokenBudget(uid, estimatedInputTokens, customApiKey);
      if (!budgetCheck.allowed) {
        return res.status(429).json({
          error: budgetCheck.error,
          quotaExceeded: true,
          usage: budgetCheck.usage,
        });
      }

      // 3. Call Gemini model ladder
      const reply = await generateWithFallback(contents, systemInstruction, customApiKey);

      // Record consumed tokens
      const consumedTokens = estimatedInputTokens + estimateTokens(reply);
      consumeTokens(uid, consumedTokens);

      const now = new Date().toISOString();
      const turnUser = { role: "user" as const, content: userMessage, timestamp: now };
      const turnModel = { role: "model" as const, content: reply, timestamp: new Date().toISOString() };

      // 4. Update local durable store
      if (!session) {
        session = {
          id: sessionId,
          mode,
          title: userMessage.slice(0, 48) + (userMessage.length > 48 ? "..." : ""),
          createdAt: now,
          updatedAt: now,
          turns: [],
        };
        userStore.sessions[sessionId] = session;
      }
      session.mode = mode;
      session.updatedAt = now;
      session.turns.push(turnUser, turnModel);
      saveLocalStore();

      // 5. Persist to Firestore
      try {
        if (db) {
          const sessionRef = db.collection("users").doc(uid).collection("sessions").doc(sessionId);
          await sessionRef.set(
            sanitizePayload({
              id: sessionId,
              mode,
              title: session.title,
              updatedAt: now,
              createdAt: session.createdAt || now,
            }),
            { merge: true }
          );

          await sessionRef.collection("turns").add(sanitizePayload(turnUser));
          await sessionRef.collection("turns").add(sanitizePayload(turnModel));
        }
      } catch (dbErr) {
        console.warn("Firestore save turn error:", dbErr);
      }

      return res.json({
        reply,
        sessionId,
        turns: session.turns,
        tokenUsage: getUserUsageRecord(uid),
      });
    } catch (err: any) {
      console.error("Chat generation failed:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // 7. POST /api/summarize
  app.post("/api/summarize", authenticate, async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      sessionId?: string;
    };
    const uid = (req as any).user.uid;
    const sessionId = body.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID required" });
    }

    // Retrieve conversation history
    let turns: any[] = [];
    try {
      if (db) {
        const snap = await db
          .collection("users")
          .doc(uid)
          .collection("sessions")
          .doc(sessionId)
          .collection("turns")
          .orderBy("timestamp", "asc")
          .get();
        if (!snap.empty) {
          turns = snap.docs.map((d) => d.data());
        }
      }
    } catch (err) {
      console.warn("Failed reading turns from Firestore:", err);
    }

    const userStore = getUserStore(uid);
    const session = userStore.sessions[sessionId];
    if (!turns.length && session && session.turns) {
      turns = session.turns;
    }

    if (!turns.length) {
      return res.status(400).json({ error: "No reflection messages found in this session to summarize yet." });
    }

    const conversationTranscript = turns
      .map((t) => `${t.role === "user" ? "User" : "Companion"}: ${t.content}`)
      .join("\n");

    const prompt = `Analyze this personal journal reflection session and generate a structured JSON summary.
Transcript:
${conversationTranscript}

Respond with valid JSON conforming to this schema ONLY (no markdown fences, no extra text):
{
  "summary": "2-3 sentence executive reflection summary",
  "emotionalTone": ["Primary mood/theme 1", "Theme 2", "Theme 3"],
  "moodEmoji": "A single representative emoji (e.g., ✨, 🎯, 🧘, 🌿, ⚡, 🤔, 💡, 🏆, 🌧️, 🌪️, 🛡️, 🔋)",
  "moodLabel": "A 1-3 word mood archetype (e.g., Inspired & Creative, Focused & Driven, Calm & Centered, Grateful, Breakthrough, Reflective)",
  "actionItems": [
    "Concrete actionable takeaway or inquiry 1",
    "Concrete actionable takeaway or inquiry 2"
  ]
}`;

    // Step 2: Daily Token Budget Rate Limiter Check
    const customApiKey = getCustomApiKey(req);
    const estimatedInputTokens = estimateTokens(prompt);
    const budgetCheck = checkTokenBudget(uid, estimatedInputTokens, customApiKey);
    if (!budgetCheck.allowed) {
      return res.status(429).json({
        error: budgetCheck.error,
        quotaExceeded: true,
        usage: budgetCheck.usage,
      });
    }

    try {
      const rawOutput = await generateWithFallback(
        prompt,
        "You are an expert executive coach and cognitive reflection synthesizer. Output strictly valid JSON.",
        customApiKey
      );

      // Record consumed tokens
      const consumedTokens = estimatedInputTokens + estimateTokens(rawOutput);
      consumeTokens(uid, consumedTokens);

      // Clean output
      let cleaned = rawOutput.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
      }

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseError) {
        parsed = {
          summary: cleaned,
          emotionalTone: ["Reflective", "Focused"],
          moodEmoji: "✨",
          moodLabel: "Reflective",
          actionItems: ["Continue periodic reflection in your vault"],
        };
      }

      const summaryPayload = {
        text: parsed.summary || cleaned,
        summary: parsed.summary || cleaned,
        emotionalTone: Array.isArray(parsed.emotionalTone) ? parsed.emotionalTone : ["Reflective"],
        moodEmoji: parsed.moodEmoji ? String(parsed.moodEmoji).trim().substring(0, 8) : "✨",
        moodLabel: parsed.moodLabel ? String(parsed.moodLabel).trim().substring(0, 50) : "Reflective",
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : ["Continue periodic reflection"],
        generatedAt: new Date().toISOString(),
      };

      // Persist to local durable store
      if (session) {
        session.summary = summaryPayload;
        session.hasSummary = true;
        session.moodEmoji = summaryPayload.moodEmoji;
        session.moodLabel = summaryPayload.moodLabel;
        session.updatedAt = new Date().toISOString();
        saveLocalStore();
      }

      // Persist to Firestore
      try {
        if (db) {
          const sessionRef = db.collection("users").doc(uid).collection("sessions").doc(sessionId);
          await sessionRef.collection("summary").doc("main").set(sanitizePayload(summaryPayload));
          await sessionRef.set(
            sanitizePayload({
              hasSummary: true,
              summaryText: summaryPayload.text,
              moodEmoji: summaryPayload.moodEmoji,
              moodLabel: summaryPayload.moodLabel,
              updatedAt: new Date().toISOString(),
            }),
            { merge: true }
          );
        }
      } catch (dbErr) {
        console.warn("Firestore summary save error:", dbErr);
      }

      return res.json({
        summary: summaryPayload.text,
        emotionalTone: summaryPayload.emotionalTone,
        moodEmoji: summaryPayload.moodEmoji,
        moodLabel: summaryPayload.moodLabel,
        actionItems: summaryPayload.actionItems,
      });
    } catch (err: any) {
      console.error("Summarization error:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // 7b. POST /api/sessions/:id/mood - Update mood emoji for a session
  app.post("/api/sessions/:id/mood", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const sessionId = req.params.id;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      moodEmoji?: string;
      moodLabel?: string;
  location?: { lat: number; lng: number; address: string; name?: string };
    };

    const moodEmoji = (body.moodEmoji || "✨").trim().substring(0, 8);
    const moodLabel = (body.moodLabel || "Reflective").trim().substring(0, 50);

    const userStore = getUserStore(uid);
    const session = userStore.sessions[sessionId];
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    session.moodEmoji = moodEmoji;
    session.moodLabel = moodLabel;
    if (session.summary) {
      session.summary.moodEmoji = moodEmoji;
      session.summary.moodLabel = moodLabel;
    }
    session.updatedAt = new Date().toISOString();
    saveLocalStore();

    await safeFirestore(async (client) => {
      await client.collection("users").doc(uid).collection("sessions").doc(sessionId).set(
        sanitizePayload({
          moodEmoji,
          moodLabel,
          updatedAt: session.updatedAt,
        }),
        { merge: true }
      );
    });

    return res.json({ success: true, moodEmoji, moodLabel });
  });

  // 8. GET /api/calendar/overview
  app.get("/api/calendar/overview", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const tzOffset = parseInt((req.query.tzOffset as string) || "0", 10);
    const userStore = getUserStore(uid);
    const daysMap: Record<string, { count: number; hasNote: boolean; hasSummary: boolean; tones: string[]; moodEmojis: string[]; notesCount: number }> = {};

    const getLocalDateStr = (isoString: string) => {
      if (!isoString) return "";
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString.split("T")[0];
      d.setMinutes(d.getMinutes() - tzOffset);
      return d.toISOString().split("T")[0];
    };

    // Aggregate sessions
    for (const sess of Object.values(userStore.sessions)) {
      const d = getLocalDateStr(sess.createdAt || sess.updatedAt || "");
      if (!d) continue;
      if (!daysMap[d]) {
        daysMap[d] = { count: 0, hasNote: false, hasSummary: false, tones: [], moodEmojis: [], notesCount: 0 };
      }
      daysMap[d].count += 1;
      const emoji = sess.moodEmoji || sess.summary?.moodEmoji;
      if (emoji && !daysMap[d].moodEmojis.includes(emoji) && daysMap[d].moodEmojis.length < 4) {
        daysMap[d].moodEmojis.push(emoji);
      }
      if (sess.summary?.emotionalTone) {
        for (const tone of sess.summary.emotionalTone) {
          if (!daysMap[d].tones.includes(tone) && daysMap[d].tones.length < 3) {
            daysMap[d].tones.push(tone);
          }
        }
      }
    }

    // Aggregate notes
    for (const note of Object.values(userStore.notes || {})) {
      const d = getLocalDateStr(note.createdAt || note.updatedAt || "");
      if (!d) continue;
      if (!daysMap[d]) {
        daysMap[d] = { count: 0, hasNote: false, hasSummary: false, tones: [], moodEmojis: [], notesCount: 0 };
      }
      daysMap[d].notesCount = (daysMap[d].notesCount || 0) + 1;
      if (note.moodEmoji && !daysMap[d].moodEmojis.includes(note.moodEmoji) && daysMap[d].moodEmojis.length < 4) {
        daysMap[d].moodEmojis.push(note.moodEmoji);
      }
    }

    // Aggregate calendar notes
    // Note: calendarNotes keys might already be YYYY-MM-DD. 
    // Wait, are they stored as UTC YYYY-MM-DD or Local YYYY-MM-DD?
    // In index.html, they are sent as `selectedDateStr`, which currently uses UTC `toISOString().split('T')[0]`.
    for (const [date, entry] of Object.entries(userStore.calendarNotes || {})) {
      if (!daysMap[date]) {
        daysMap[date] = { count: 0, hasNote: false, hasSummary: false, tones: [], moodEmojis: [], notesCount: 0 };
      }
      if (entry.note && entry.note.trim()) {
        daysMap[date].hasNote = true;
      }
      if (entry.daySummary && entry.daySummary.trim()) {
        daysMap[date].hasSummary = true;
      }
      if (entry.moodEmoji && !daysMap[date].moodEmojis.includes(entry.moodEmoji) && daysMap[date].moodEmojis.length < 4) {
        daysMap[date].moodEmojis.push(entry.moodEmoji);
      }
    }

    return res.json({ days: daysMap });
  });

  // 9. GET /api/calendar/:date
  app.get("/api/calendar/:date", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const date = req.params.date;
    const tzOffset = parseInt((req.query.tzOffset as string) || "0", 10);
    
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date format. Expected YYYY-MM-DD." });
    }

    const getLocalDateStr = (isoString: string) => {
      if (!isoString) return "";
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString.split("T")[0];
      d.setMinutes(d.getMinutes() - tzOffset);
      return d.toISOString().split("T")[0];
    };

    const userStore = getUserStore(uid);
    const sessions = Object.values(userStore.sessions).filter((s) => {
      const cd = getLocalDateStr(s.createdAt || "");
      const ud = getLocalDateStr(s.updatedAt || "");
      return cd === date || ud === date;
    });

    const notes = Object.values(userStore.notes || {}).filter((n) => {
      const cd = getLocalDateStr(n.createdAt || "");
      const ud = getLocalDateStr(n.updatedAt || "");
      return cd === date || ud === date;
    });

    const calendarEntry = userStore.calendarNotes?.[date] || {
      date,
      note: "",
      moodEmoji: "",
      moodLabel: "",
      daySummary: null,
      updatedAt: new Date().toISOString(),
    };

    return res.json({
      date,
      sessions,
      notes,
      note: calendarEntry.note || "",
      moodEmoji: calendarEntry.moodEmoji || null,
      moodLabel: calendarEntry.moodLabel || null,
      daySummary: calendarEntry.daySummary || null,
      updatedAt: calendarEntry.updatedAt,
    });
  });

  // 10. POST /api/calendar/:date/note
  app.post("/api/calendar/:date/note", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date format. Expected YYYY-MM-DD." });
    }

    const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
      note?: string;
      moodEmoji?: string;
      moodLabel?: string;
  location?: { lat: number; lng: number; address: string; name?: string };
    };
    const note = (body.note || "").trim();
    const moodEmoji = body.moodEmoji ? String(body.moodEmoji).trim().substring(0, 8) : undefined;
    const moodLabel = body.moodLabel ? String(body.moodLabel).trim().substring(0, 50) : undefined;
    const now = new Date().toISOString();

    const userStore = getUserStore(uid);
    if (!userStore.calendarNotes) userStore.calendarNotes = {};
    const current = userStore.calendarNotes[date] || { date, note: "", daySummary: null, updatedAt: now };
    current.note = note;
    if (moodEmoji !== undefined) current.moodEmoji = moodEmoji;
    if (moodLabel !== undefined) current.moodLabel = moodLabel;
    current.updatedAt = now;
    userStore.calendarNotes[date] = current;
    saveLocalStore();

    await safeFirestore(async (client) => {
      await client.collection("users").doc(uid).collection("calendar").doc(date).set(sanitizePayload(current), { merge: true });
    });

    return res.json({ success: true, date, note, moodEmoji: current.moodEmoji, moodLabel: current.moodLabel, updatedAt: now });
  });

  // 11. POST /api/calendar/:date/synthesize
  app.post("/api/calendar/:date/synthesize", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date format. Expected YYYY-MM-DD." });
    }

    const userStore = getUserStore(uid);
    const sessions = Object.values(userStore.sessions).filter((s) => {
      const cd = s.createdAt ? s.createdAt.split("T")[0] : "";
      const ud = s.updatedAt ? s.updatedAt.split("T")[0] : "";
      return cd === date || ud === date;
    });

    const dayNote = userStore.calendarNotes?.[date]?.note || "";

    if (!sessions.length && !dayNote) {
      return res.status(400).json({ error: "No reflections or daily notes found for this date to synthesize." });
    }

    let contentToAnalyze = `Date: ${date}\n\n`;
    if (dayNote) {
      contentToAnalyze += `Daily Intentions & Notes:\n${dayNote}\n\n`;
    }
    if (sessions.length) {
      contentToAnalyze += `Sessions Recorded on this Day (${sessions.length}):\n`;
      sessions.forEach((s, idx) => {
        contentToAnalyze += `--- Session ${idx + 1} (${s.mode} - "${s.title}") ---\n`;
        if (s.summary?.text) {
          contentToAnalyze += `Summary: ${s.summary.text}\nTones: ${s.summary.emotionalTone?.join(", ")}\n`;
        }
        if (s.turns && s.turns.length) {
          s.turns.slice(0, 6).forEach((t) => {
            contentToAnalyze += `${t.role}: ${t.content}\n`;
          });
        }
        contentToAnalyze += `\n`;
      });
    }

    const prompt = `You are an expert executive cognitive coach and daily review synthesizer.
Analyze all the reflection sessions and notes from ${date} and provide a holistic, inspiring, and actionable Daily Synthesis. Also infer the day's dominant overall Mood Emoji and descriptive Mood Label.

Review data:
${contentToAnalyze}

Output strict JSON only with NO markdown fences:
{
  "daySummary": "Comprehensive 3-4 sentence holistic day review summarizing core insights, emotional trajectory, and personal growth.",
  "keyThemes": ["Theme 1", "Theme 2", "Theme 3"],
  "dominantMoodEmoji": "Single representative emoji (e.g., 🌟, ✨, 🎯, 🧘, 🌿, 💡, 🏆, ⚡, 🌧️, 🛡️)",
  "dominantMoodLabel": "Short 1-3 word mood archetype (e.g. Energized & Productive, Calm & Reflective, Purposeful)",
  "dailyWins": ["Meaningful accomplishment or realization 1", "Realization 2"],
  "tomorrowFocus": "A clear, motivating intention or focus area for tomorrow."
}`;

    // Token budget check
    const customApiKey = getCustomApiKey(req);
    const estimatedInputTokens = estimateTokens(prompt);
    const budgetCheck = checkTokenBudget(uid, estimatedInputTokens, customApiKey);
    if (!budgetCheck.allowed) {
      return res.status(429).json({
        error: budgetCheck.error,
        quotaExceeded: true,
        usage: budgetCheck.usage,
      });
    }

    try {
      const rawOutput = await generateWithFallback(
        prompt,
        "You are a cognitive journal synthesizer. Return strictly valid JSON.",
        customApiKey
      );
      const consumedTokens = estimatedInputTokens + estimateTokens(rawOutput);
      consumeTokens(uid, consumedTokens);

      let cleaned = rawOutput.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
      }

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        parsed = {
          daySummary: cleaned,
          keyThemes: ["Mindfulness", "Self-Reflection"],
          dominantMoodEmoji: "✨",
          dominantMoodLabel: "Reflective",
          dailyWins: ["Maintained daily reflection practice"],
          tomorrowFocus: "Cultivate clarity and deliberate focus",
        };
      }

      const now = new Date().toISOString();
      if (!userStore.calendarNotes) userStore.calendarNotes = {};
      const current = userStore.calendarNotes[date] || { date, note: "", daySummary: null, updatedAt: now };
      current.daySummary = parsed.daySummary;
      if (parsed.dominantMoodEmoji) current.moodEmoji = parsed.dominantMoodEmoji;
      if (parsed.dominantMoodLabel) current.moodLabel = parsed.dominantMoodLabel;
      current.updatedAt = now;
      userStore.calendarNotes[date] = current;
      saveLocalStore();

      await safeFirestore(async (client) => {
        await client.collection("users").doc(uid).collection("calendar").doc(date).set(sanitizePayload(current), { merge: true });
      });

      return res.json({
        date,
        daySummary: parsed.daySummary,
        dominantMoodEmoji: parsed.dominantMoodEmoji || current.moodEmoji || "✨",
        dominantMoodLabel: parsed.dominantMoodLabel || current.moodLabel || "Reflective",
        keyThemes: parsed.keyThemes || [],
        dailyWins: parsed.dailyWins || [],
        tomorrowFocus: parsed.tomorrowFocus || "",
      });
    } catch (err: any) {
      console.error("Day synthesis error:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // 11b. POST /api/calendar/:date/notify
  app.post("/api/calendar/:date/notify", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const email = (req as any).user.email;
    const date = req.params.date;
    const googleToken = req.headers["x-google-access-token"];
    
    if (!email) return res.status(400).json({ error: "User email not found in auth token." });
    if (!googleToken) return res.status(401).json({ error: "Missing X-Google-Access-Token header." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format." });

    const userStore = getUserStore(uid);
    const dayNote = userStore.calendarNotes?.[date]?.note || "";
    
    if (!dayNote) {
      return res.status(400).json({ error: "No planned tasks found for this date to send." });
    }

    const emailSubject = `Planned Tasks for ${date}`;
    const emailBody = `Here are your planned tasks for ${date}:\n\n${dayNote}\n\n- Sent from your AI Studio app.`;

    const rawMessage = [
      `To: ${email}`,
      `Subject: ${emailSubject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      '',
      emailBody
    ].join('\n');

    const base64EncodedEmail = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const gRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${googleToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ raw: base64EncodedEmail })
      });

      const gData = await gRes.json();
      if (!gRes.ok) {
        throw new Error(gData.error?.message || "Failed to send email via Gmail API");
      }

      return res.json({ success: true, messageId: gData.id });
    } catch (e: any) {
      console.error("Gmail send error:", e);
      return res.status(500).json({ error: "Gmail send failed: " + e.message });
    }
  });

  // Maps config endpoint
  app.get("/api/maps-config", (req: Request, res: Response) => {
    res.json({ apiKey: process.env.GOOGLE_MAPS_API_KEY || "" });
  });

  // 12. GET /api/notes - Retrieve user notes
  app.get("/api/notes", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const userStore = getUserStore(uid);

    const notes = Object.values(userStore.notes || {});
    // Sort pinned first, then by updatedAt descending
    notes.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return res.json({ notes });
  });

  // 13. POST /api/notes - Create or update a note
  app.post("/api/notes", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Partial<NoteRecord>;
    const userStore = getUserStore(uid);
    if (!userStore.notes) userStore.notes = {};

    const now = new Date().toISOString();
    const id = body.id && /^[a-zA-Z0-9_\-]+$/.test(body.id)
      ? body.id
      : `note-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const existing = userStore.notes[id];
    const updatedNote: NoteRecord = {
      id,
      title: (body.title || existing?.title || "Untitled Note").trim().substring(0, 150),
      content: (body.content !== undefined ? body.content : existing?.content || "").trim().substring(0, 50000),
      category: (body.category || existing?.category || "Idea").trim().substring(0, 50),
      tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim().substring(0, 30)).filter(Boolean).slice(0, 10) : existing?.tags || [],
      color: (body.color || existing?.color || "amber").trim().substring(0, 20),
      isPinned: typeof body.isPinned === "boolean" ? body.isPinned : existing?.isPinned || false,
      moodEmoji: (body.moodEmoji || existing?.moodEmoji || "💡").trim().substring(0, 8),
      moodLabel: (body.moodLabel || existing?.moodLabel || "Insight").trim().substring(0, 50),
      location: body.location ? {
        lat: Number(body.location.lat) || 0,
        lng: Number(body.location.lng) || 0,
        address: String(body.location.address || "").substring(0, 500),
        name: String(body.location.name || "").substring(0, 200)
      } : existing?.location,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    userStore.notes[id] = updatedNote;
    saveLocalStore();

    await safeFirestore(async (client) => {
      await client.collection("users").doc(uid).collection("notes").doc(id).set(sanitizePayload(updatedNote), { merge: true });
    });

    return res.json({ success: true, note: updatedNote });
  });

  // 14. DELETE /api/notes/:id - Delete a note
  app.delete("/api/notes/:id", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const id = req.params.id;
    const userStore = getUserStore(uid);

    if (userStore.notes && userStore.notes[id]) {
      delete userStore.notes[id];
      saveLocalStore();
    }

    await safeFirestore(async (client) => {
      await client.collection("users").doc(uid).collection("notes").doc(id).delete();
    });

    return res.json({ success: true });
  });

  // 15. POST /api/notes/categorize - AI Auto-Categorization & Tagging
  app.post("/api/notes/categorize", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user?.uid || "anonymous_user";
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { content?: string; title?: string };
    const content = (body.content || "").trim();
    if (!content) {
      return res.status(400).json({ error: "Content is required for AI categorization." });
    }

    const prompt = `You are an intelligent cognitive note organizer. Analyze this note draft and generate a concise title, a primary category, keywords/tags, an accent color theme, and the single best mood emoji + mood label expressing the overall note.
Note Title: "${body.title || ""}"
Note Body:
${content.substring(0, 4000)}

Available categories: "Reflection", "Idea", "Habit", "Goal", "Gratitude", "Learning", "Brainstorm"
Available colors: "amber", "emerald", "blue", "purple", "rose"
Recommended Mood Emojis:
🧘 Calm & Centered, ✨ Inspired & Creative, 🎯 Focused & Driven, 🌿 Grateful & Content, ⚡ Energized & Motivated, 🤔 Reflective & Inquisitive, 💡 Insight & Breakthrough, 🌧️ Vulnerable & Melancholy, 🌪️ Overwhelmed & Anxious, 🛡️ Resilient & Courageous, 🏆 Proud & Accomplished, 🔋 Fatigued & Recharging

Return STRICT JSON only with NO markdown fences:
{
  "suggestedTitle": "A concise, meaningful 3-6 word title",
  "suggestedCategory": "One category from the list",
  "tags": ["2 to 4 relevant tags"],
  "accentColor": "one color from the list",
  "moodEmoji": "One representative emoji (e.g., ✨, 🎯, 💡, 🌿, 🧘)",
  "moodLabel": "Short 1-3 word mood description",
  "keyTakeaway": "One-sentence executive takeaway or punchline"
}`;

    // Token budget check
    const customApiKey = getCustomApiKey(req);
    const estimatedInputTokens = estimateTokens(prompt);
    const budgetCheck = checkTokenBudget(uid, estimatedInputTokens, customApiKey);
    if (!budgetCheck.allowed) {
      return res.status(429).json({
        error: budgetCheck.error,
        quotaExceeded: true,
        usage: budgetCheck.usage,
      });
    }

    try {
      const raw = await generateWithFallback(
        prompt,
        "You are a note categorization assistant. Output strictly valid JSON.",
        customApiKey
      );
      const consumedTokens = estimatedInputTokens + estimateTokens(raw);
      consumeTokens(uid, consumedTokens);

      let cleaned = raw.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
      }

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        parsed = {
          suggestedTitle: body.title || "Quick Note",
          suggestedCategory: "Idea",
          tags: ["Thought"],
          accentColor: "amber",
          moodEmoji: "💡",
          moodLabel: "Insight",
          keyTakeaway: "",
        };
      }

      return res.json({
        suggestedTitle: parsed.suggestedTitle || "Note",
        suggestedCategory: parsed.suggestedCategory || "Idea",
        tags: parsed.tags || ["Insight"],
        accentColor: parsed.accentColor || "amber",
        moodEmoji: parsed.moodEmoji || "💡",
        moodLabel: parsed.moodLabel || "Insight",
        keyTakeaway: parsed.keyTakeaway || "",
      });
    } catch (err: any) {
      console.error("Note categorization error:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // 16. GET /api/insights - Retrieve analytics & latest cognitive audit
  app.get("/api/insights", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const userStore = getUserStore(uid);

    const sessions = Object.values(userStore.sessions || {});
    const notes = Object.values(userStore.notes || {});
    const calendarEntries = Object.values(userStore.calendarNotes || {});

    // Word count calculation
    let totalWords = 0;
    for (const s of sessions) {
      if (s.turns) {
        for (const t of s.turns) {
          totalWords += (t.content || "").split(/\s+/).filter(Boolean).length;
        }
      }
      if (s.summary?.text) {
        totalWords += s.summary.text.split(/\s+/).filter(Boolean).length;
      }
    }
    for (const n of notes) {
      totalWords += (n.content || "").split(/\s+/).filter(Boolean).length;
    }
    for (const c of calendarEntries) {
      if (c.note) totalWords += c.note.split(/\s+/).filter(Boolean).length;
      if (c.daySummary) totalWords += c.daySummary.split(/\s+/).filter(Boolean).length;
    }

    // Emotional tone frequencies
    const toneCounts: Record<string, number> = {};
    for (const s of sessions) {
      if (s.summary?.emotionalTone) {
        for (const tone of s.summary.emotionalTone) {
          toneCounts[tone] = (toneCounts[tone] || 0) + 1;
        }
      }
    }

    // Category distribution for notes
    const categoryCounts: Record<string, number> = {};
    for (const n of notes) {
      const cat = n.category || "Uncategorized";
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    return res.json({
      metrics: {
        totalSessions: sessions.length,
        totalNotes: notes.length,
        totalCalendarDays: calendarEntries.length,
        totalWords,
      },
      emotionalDistribution: toneCounts,
      categoryDistribution: categoryCounts,
      latestAudit: userStore.latestAudit || null,
    });
  });

  // 17. POST /api/insights/generate - Deep Cognitive Audit & Psychological Reframing
  app.post("/api/insights/generate", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const userStore = getUserStore(uid);

    const sessions = Object.values(userStore.sessions || {});
    const notes = Object.values(userStore.notes || {});
    const calendarEntries = Object.values(userStore.calendarNotes || {});

    if (sessions.length === 0 && notes.length === 0 && calendarEntries.length === 0) {
      return res.status(400).json({ error: "At least one session or note is required to generate a cognitive audit." });
    }

    let archiveCorpus = "";
    // Sample recent sessions
    sessions.slice(0, 10).forEach((s, idx) => {
      archiveCorpus += `[Session ${idx + 1}: ${s.mode} - "${s.title}"]\n`;
      if (s.summary?.text) archiveCorpus += `Summary: ${s.summary.text}\nTones: ${s.summary.emotionalTone?.join(", ")}\n`;
      if (s.turns && s.turns.length) {
        archiveCorpus += `User: ${s.turns.filter((t) => t.role === "user").map((t) => t.content).join(" | ").substring(0, 500)}\n`;
      }
      archiveCorpus += "\n";
    });

    // Sample notes
    notes.slice(0, 10).forEach((n, idx) => {
      archiveCorpus += `[Note ${idx + 1}: (${n.category}) "${n.title}"]\n${n.content.substring(0, 300)}\n\n`;
    });

    // Sample calendar entries
    calendarEntries.slice(0, 7).forEach((c) => {
      if (c.note || c.daySummary) {
        archiveCorpus += `[Date: ${c.date}]\nNote: ${c.note || "None"}\nDay Review: ${c.daySummary || "None"}\n\n`;
      }
    });

    const prompt = `You are a world-class cognitive behavioral psychologist, executive reflection coach, and metacognitive analyst.
Conduct an in-depth, compassionate, and empowering Cognitive Growth Audit across this user's journal corpus:

${archiveCorpus.substring(0, 7500)}

Analyze:
1. Cognitive Growth Score (1-100 based on self-awareness, emotional honesty, and intentionality).
2. Mindset Assessment (2-3 sentences evaluating mental clarity, cognitive agility, and emotional equilibrium).
3. Top Recurring Themes (3-5 core motifs).
4. Cognitive Patterns & Distortions: Identify up to 3 cognitive distortions or mental friction points (e.g. All-or-Nothing thinking, Emotional Reasoning, Catastrophizing, Overthinking, Imposter feelings) with a brief quote/paraphrase and an empowering, actionable Cognitive Reframing technique.
5. Actionable Micro-Habits: 3 concrete, realistic behavioral commitments tailored to their reflections.
6. Weekly Focus: A guiding North Star principle for their upcoming week.

Return STRICT JSON ONLY with NO markdown fences:
{
  "growthScore": 85,
  "mindsetAssessment": "...",
  "topThemes": ["Growth Mindset", "Deep Work", "Self-Compassion"],
  "cognitiveDistortions": [
    {
      "distortion": "All-or-Nothing Thinking",
      "quote": "If today wasn't 100% productive, it feels wasted",
      "reframingSuggestion": "Recognize that small, consistent 1% progress compounds far more reliably than unsustainable perfection."
    }
  ],
  "habits": [
    { "id": "h-1", "action": "5-minute evening mental transition buffer before sleep", "frequency": "Daily", "completed": false },
    { "id": "h-2", "action": "Pause for 3 grounding breaths when feeling task overwhelm", "frequency": "Daily", "completed": false },
    { "id": "h-3", "action": "End morning planning with one non-negotiable priority", "frequency": "Daily", "completed": false }
  ],
  "weeklyFocus": "Anchor decisions in deliberate clarity rather than urgency."
}`;

    // Token budget check
    const customApiKey = getCustomApiKey(req);
    const estimatedInputTokens = estimateTokens(prompt);
    const budgetCheck = checkTokenBudget(uid, estimatedInputTokens, customApiKey);
    if (!budgetCheck.allowed) {
      return res.status(429).json({
        error: budgetCheck.error,
        quotaExceeded: true,
        usage: budgetCheck.usage,
      });
    }

    try {
      const raw = await generateWithFallback(
        prompt,
        "You are a master psychological coach. Output strictly valid JSON.",
        customApiKey
      );
      const consumedTokens = estimatedInputTokens + estimateTokens(raw);
      consumeTokens(uid, consumedTokens);

      let cleaned = raw.trim();
      if (cleaned.startsWith("```json")) {
        cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
      } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
      }

      const parsed = JSON.parse(cleaned);
      const auditRecord: CognitiveAuditRecord = {
        id: `audit-${Date.now()}`,
        generatedAt: new Date().toISOString(),
        growthScore: typeof parsed.growthScore === "number" ? parsed.growthScore : 82,
        mindsetAssessment: parsed.mindsetAssessment || "Reflective, seeking deeper balance and alignment.",
        topThemes: Array.isArray(parsed.topThemes) ? parsed.topThemes : ["Clarity", "Intentionality"],
        cognitiveDistortions: Array.isArray(parsed.cognitiveDistortions) ? parsed.cognitiveDistortions : [],
        habits: Array.isArray(parsed.habits)
          ? parsed.habits.map((h: any, idx: number) => ({
              id: h.id || `h-${idx + 1}`,
              action: h.action || "Daily reflection",
              frequency: h.frequency || "Daily",
              completed: !!h.completed,
            }))
          : [],
        weeklyFocus: parsed.weeklyFocus || "Cultivate present awareness.",
      };

      userStore.latestAudit = auditRecord;
      saveLocalStore();

      await safeFirestore(async (client) => {
        await client.collection("users").doc(uid).collection("insights").doc("latest").set(sanitizePayload(auditRecord), { merge: true });
      });

      return res.json({ success: true, audit: auditRecord });
    } catch (err: any) {
      console.error("Cognitive audit generation error:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // 18. POST /api/insights/habit-toggle - Toggle habit completion in latest audit
  app.post("/api/insights/habit-toggle", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { habitId?: string };
    const userStore = getUserStore(uid);

    if (!userStore.latestAudit || !userStore.latestAudit.habits) {
      return res.status(404).json({ error: "No active habits found." });
    }

    const target = userStore.latestAudit.habits.find((h) => h.id === body.habitId);
    if (!target) {
      return res.status(404).json({ error: "Habit not found." });
    }

    target.completed = !target.completed;
    saveLocalStore();

    await safeFirestore(async (client) => {
      await client.collection("users").doc(uid).collection("insights").doc("latest").set(sanitizePayload(userStore.latestAudit), { merge: true });
    });

    return res.json({ success: true, habit: target, audit: userStore.latestAudit });
  });

  // 19. GET /api/vault/export - Export full journal vault data (JSON or Markdown)
  app.get("/api/vault/export", authenticate, async (req: Request, res: Response) => {
    const uid = (req as any).user.uid;
    const format = req.query.format === "markdown" ? "markdown" : "json";
    const userStore = getUserStore(uid);

    if (format === "json") {
      res.setHeader("Content-Disposition", `attachment; filename="gemini-journal-vault-${new Date().toISOString().split("T")[0]}.json"`);
      res.setHeader("Content-Type", "application/json");
      return res.send(JSON.stringify(userStore, null, 2));
    }

    // Markdown format
    let md = `# Personal Gemini Journal Vault Export\nExported on: ${new Date().toLocaleString()}\n\n`;

    md += `## 1. Cognitive Growth & Audit\n`;
    if (userStore.latestAudit) {
      const a = userStore.latestAudit;
      md += `- **Growth Score**: ${a.growthScore}/100\n`;
      md += `- **Mindset Assessment**: ${a.mindsetAssessment}\n`;
      md += `- **Weekly Focus**: ${a.weeklyFocus}\n`;
      md += `- **Top Themes**: ${a.topThemes.join(", ")}\n\n`;
      if (a.habits && a.habits.length) {
        md += `### Actionable Commitments:\n`;
        a.habits.forEach((h) => {
          md += `- [${h.completed ? "x" : " "}] ${h.action} (${h.frequency})\n`;
        });
        md += "\n";
      }
    } else {
      md += `*No audit generated yet.*\n\n`;
    }

    md += `## 2. Reflection Sessions (${Object.keys(userStore.sessions || {}).length})\n\n`;
    for (const sess of Object.values(userStore.sessions || {})) {
      md += `### ${sess.title} (${sess.mode})\n`;
      md += `*Date: ${sess.createdAt}*\n\n`;
      if (sess.summary?.text) {
        md += `**Synthesis**: ${sess.summary.text}\n\n`;
        if (sess.summary.actionItems?.length) {
          md += `**Action Items**:\n${sess.summary.actionItems.map((t) => `- ${t}`).join("\n")}\n\n`;
        }
        if (sess.summary.emotionalTone?.length) {
          md += `**Emotional Tone**: ${sess.summary.emotionalTone.join(", ")}\n\n`;
        }
      }
      if (sess.turns?.length) {
        md += `**Conversation Turns**:\n`;
        sess.turns.forEach((t) => {
          md += `> **${t.role.toUpperCase()}**: ${t.content}\n\n`;
        });
      }
      md += `---\n\n`;
    }

    md += `## 3. Notes & Scratchpad (${Object.keys(userStore.notes || {}).length})\n\n`;
    for (const note of Object.values(userStore.notes || {})) {
      md += `### ${note.title} [${note.category}]\n`;
      md += `*Tags: ${note.tags.join(", ") || "None"} | Updated: ${note.updatedAt}*\n\n`;
      md += `${note.content}\n\n---\n\n`;
    }

    md += `## 4. Calendar Daily Log (${Object.keys(userStore.calendarNotes || {}).length})\n\n`;
    for (const [d, entry] of Object.entries(userStore.calendarNotes || {})) {
      md += `### Date: ${d}\n`;
      if (entry.note) md += `**Intention / Note**: ${entry.note}\n\n`;
      if (entry.daySummary) md += `**Daily Review**: ${entry.daySummary}\n\n`;
      md += `---\n\n`;
    }

    res.setHeader("Content-Disposition", `attachment; filename="gemini-journal-vault-${new Date().toISOString().split("T")[0]}.md"`);
    res.setHeader("Content-Type", "text/markdown");
    return res.send(md);
  });

  // 20. POST /api/grammar-check - AI Grammar & Spelling corrector
  app.post("/api/grammar-check", authenticate, async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      if (!text || text.length < 5 || text.length > 2000) {
        return res.json({ corrected: null });
      }

      const customApiKey = getCustomApiKey(req);
      const prompt = `You are a helpful writing assistant. 
Review the following text for spelling and grammar errors. 
If the text is perfectly fine, respond with EXACTLY the word "PERFECT". 
If there are errors, respond with the corrected text only. Do not add quotes, explanations, or introductory text. Maintain the original tone and intent.

Text to check:
${text}`;

      const aiResponse = await generateWithFallback(
        prompt,
        "You are a helpful writing assistant.",
        customApiKey
      );
      const corrected = aiResponse.trim();
      
      if (corrected === "PERFECT" || corrected === text) {
        return res.json({ corrected: null });
      }

      res.json({ corrected });
    } catch (err: any) {
      console.error("Grammar check error:", err);
      res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // 21. Mount Vite middleware for development, or serve dist in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
