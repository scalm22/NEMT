import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import twilio from "twilio";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // required for Twilio webhooks

// ─── Twilio client ────────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER; // e.g. +13175550100

// ─── SMS session store ────────────────────────────────────────────────────────
// Keyed by member phone number. Stores conversation history + inferred member_id.
// In production replace with Redis or a database so sessions survive restarts.
const smsSessions = new Map();

function getSession(phone) {
  if (!smsSessions.has(phone)) {
    smsSessions.set(phone, { history: [], member_id: null, phone });
  }
  return smsSessions.get(phone);
}

function clearSession(phone) {
  smsSessions.delete(phone);
}

const client = new Anthropic();
const SYSTEM_PROMPT = readFileSync(
  join(__dirname, "../prompts/system_prompt.txt"),
  "utf-8"
);

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "check_eligibility",
    description:
      "Check a member's NEMT eligibility and retrieve their home address and covered benefits from the health plan system.",
    input_schema: {
      type: "object",
      properties: {
        member_id: {
          type: "string",
          description: "The member's health plan ID",
        },
      },
      required: ["member_id"],
    },
  },
  {
    name: "book_trip",
    description:
      "Book a NEMT trip in the dispatch system. Call only after member has confirmed all details.",
    input_schema: {
      type: "object",
      properties: {
        member_id: { type: "string" },
        pickup_address: { type: "string" },
        destination_name: { type: "string" },
        destination_address: { type: "string" },
        appointment_date: {
          type: "string",
          description: "YYYY-MM-DD format",
        },
        appointment_time: {
          type: "string",
          description: "HH:MM 24hr format — time member must ARRIVE",
        },
        round_trip: { type: "boolean" },
        special_needs: {
          type: "string",
          description: "e.g. wheelchair, none",
          default: "none",
        },
        language: {
          type: "string",
          description: "en or es — member's language",
        },
      },
      required: [
        "member_id",
        "pickup_address",
        "destination_name",
        "destination_address",
        "appointment_date",
        "appointment_time",
        "round_trip",
      ],
    },
  },
  {
    name: "send_confirmation",
    description: "Send a booking confirmation to the member via their channel.",
    input_schema: {
      type: "object",
      properties: {
        member_id: { type: "string" },
        confirmation_number: { type: "string" },
        pickup_address: { type: "string" },
        pickup_time: {
          type: "string",
          description: "Estimated driver arrival time",
        },
        destination_name: { type: "string" },
        appointment_date: { type: "string" },
        language: { type: "string", description: "en or es" },
        channel: {
          type: "string",
          description: "sms, chat, or whatsapp",
          default: "chat",
        },
      },
      required: [
        "member_id",
        "confirmation_number",
        "pickup_address",
        "pickup_time",
        "destination_name",
        "appointment_date",
      ],
    },
  },
];

// ─── Mock tool handlers (replace with real API calls in production) ──────────

function handleCheckEligibility({ member_id }) {
  console.log(`[tool] check_eligibility → member_id: ${member_id}`);

  // TODO: Replace with real health plan API call
  // Example: const res = await fetch(`https://api.healthplan.com/members/${member_id}/eligibility`, { headers: { Authorization: `Bearer ${process.env.HEALTH_PLAN_API_KEY}` } })

  const mockMembers = {
    "MBR-001": {
      member_id: "MBR-001",
      name: "Maria Garcia",
      home_address: "4521 West 56th Street, Indianapolis, IN 46254",
      nemt_covered: true,
      plan_name: "Hoosier Care Connect",
      trips_remaining: 24,
      language_preference: "es",
    },
    "MBR-002": {
      member_id: "MBR-002",
      name: "James Williams",
      home_address: "812 North Meridian Street, Indianapolis, IN 46204",
      nemt_covered: true,
      plan_name: "Hoosier Care Connect",
      trips_remaining: 18,
      language_preference: "en",
    },
    "MBR-003": {
      member_id: "MBR-003",
      name: "Robert Chen",
      home_address: "220 East Ohio Street, Indianapolis, IN 46204",
      nemt_covered: false,
      plan_name: "Marketplace Basic",
      trips_remaining: 0,
      language_preference: "en",
    },
  };

  const member = mockMembers[member_id];
  if (!member) {
    return { error: "Member not found", member_id };
  }
  return member;
}

function handleBookTrip(params) {
  console.log(`[tool] book_trip →`, params);

  // TODO: Replace with real Modivcare API call
  // Example: POST https://api.modivcare.com/v1/trips
  // Body: { memberId, pickupAddress, dropoffAddress, scheduledDate, scheduledTime, ... }

  // Calculate pickup time (45 min before appointment)
  const [hours, minutes] = params.appointment_time.split(":").map(Number);
  const pickupDate = new Date(2000, 0, 1, hours, minutes);
  pickupDate.setMinutes(pickupDate.getMinutes() - 45);
  const pickupTime = `${String(pickupDate.getHours()).padStart(2, "0")}:${String(pickupDate.getMinutes()).padStart(2, "0")}`;

  const confirmationNumber = `VIS-${Date.now().toString().slice(-6)}`;

  return {
    success: true,
    confirmation_number: confirmationNumber,
    pickup_time: pickupTime,
    pickup_address: params.pickup_address,
    destination_name: params.destination_name,
    destination_address: params.destination_address,
    appointment_date: params.appointment_date,
    appointment_time: params.appointment_time,
    round_trip: params.round_trip,
    driver_info: "Driver will be assigned 2 hours before pickup",
    status: "confirmed",
  };
}

async function handleSendConfirmation(params) {
  console.log(`[tool] send_confirmation →`, params);

  const msgEn =
`Your ride is confirmed!
Confirmation: ${params.confirmation_number}
Pickup: ${params.pickup_time} at ${params.pickup_address}
Destination: ${params.destination_name}
Date: ${params.appointment_date}
Reply CANCEL to cancel your ride.`;

  const msgEs =
`¡Su viaje está confirmado!
Confirmación: ${params.confirmation_number}
Recogida: ${params.pickup_time} en ${params.pickup_address}
Destino: ${params.destination_name}
Fecha: ${params.appointment_date}
Responda CANCELAR para cancelar su viaje.`;

  const body = params.language === "es" ? msgEs : msgEn;

  // Send real SMS if a phone number is attached to this booking
  if (params.member_phone && TWILIO_NUMBER) {
    try {
      const msg = await twilioClient.messages.create({
        to: params.member_phone,
        from: TWILIO_NUMBER,
        body,
      });
      console.log(`[twilio] SMS sent → SID: ${msg.sid}`);
      return { success: true, message_sent: body, sms_sid: msg.sid };
    } catch (err) {
      console.error("[twilio] SMS failed:", err.message);
      return { success: false, error: err.message, message_sent: body };
    }
  }

  // No phone available (web chat mode) — just log it
  console.log(`[confirmation — chat mode]\n${body}`);
  return { success: true, message_sent: body, channel: params.channel || "chat" };
}

// ─── Tool router ─────────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case "check_eligibility":
      return handleCheckEligibility(toolInput);
    case "book_trip":
      return handleBookTrip(toolInput);
    case "send_confirmation":
      return await handleSendConfirmation(toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────
// This runs Claude, executes any tools it calls, feeds results back,
// and repeats until Claude gives a final text response with no more tool calls.

async function runAgentLoop(messages) {
  let currentMessages = [...messages];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: currentMessages,
    });

    console.log(`[claude] stop_reason: ${response.stop_reason}`);

    // No tool calls — Claude gave a final reply, return it
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        reply: textBlock?.text || "",
        messages: [
          ...currentMessages,
          { role: "assistant", content: response.content },
        ],
      };
    }

    // Tool use — execute each tool and feed results back
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b) => b.type === "tool_use"
      );

      const toolResults = await Promise.all(toolUseBlocks.map(async (toolUse) => {
        console.log(`[tool call] ${toolUse.name}`, toolUse.input);
        const result = await executeTool(toolUse.name, toolUse.input);
        console.log(`[tool result]`, result);
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        };
      }));

      // Add Claude's tool-use turn + tool results to message history
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ];

      // Loop back — Claude will now process tool results and respond
      continue;
    }

    // Unexpected stop reason
    break;
  }

  return { reply: "Something went wrong. Please try again.", messages };
}

// ─── API routes ───────────────────────────────────────────────────────────────

// POST /chat — main conversation endpoint
// Body: { message: string, history: array, member_id?: string }
app.post("/chat", async (req, res) => {
  try {
    const { message, history = [], member_id } = req.body;

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    // Build message history
    // If member_id is known upfront, inject it so AI doesn't need to ask
    const userContent = member_id
      ? `[Member ID: ${member_id}]\n${message}`
      : message;

    const messages = [
      ...history,
      { role: "user", content: userContent },
    ];

    const { reply, messages: updatedMessages } = await runAgentLoop(messages);

    res.json({
      reply,
      history: updatedMessages,
    });
  } catch (err) {
    console.error("[error]", err);
    res.status(500).json({ error: "Internal server error", detail: err.message });
  }
});

// ─── SMS inbound webhook ──────────────────────────────────────────────────────
// Twilio calls POST /sms every time a member sends a text to your number.
// Configure this URL in your Twilio console under Phone Numbers → Messaging.

app.post("/sms", async (req, res) => {
  const from = req.body.From;   // member's phone number e.g. +13175559876
  const body = req.body.Body?.trim();

  console.log(`[sms inbound] from: ${from} | body: "${body}"`);

  if (!body) {
    return res.set("Content-Type", "text/xml").send("<Response></Response>");
  }

  // Handle CANCEL / CANCELAR commands
  const cancelWords = ["cancel", "cancelar", "stop", "parar"];
  if (cancelWords.includes(body.toLowerCase())) {
    clearSession(from);
    const reply =
      "Your conversation has been reset. Text us anytime to book a new ride.\n" +
      "Su conversación fue reiniciada. Escríbanos cuando quiera reservar un viaje.";
    await twilioClient.messages.create({ to: from, from: TWILIO_NUMBER, body: reply });
    return res.set("Content-Type", "text/xml").send("<Response></Response>");
  }

  const session = getSession(from);

  try {
    // Inject phone number into session so send_confirmation can SMS them
    // We pass it as context the AI sees but members don't need to provide
    const userContent = session.member_id
      ? `[Member ID: ${session.member_id}] [Phone: ${from}]\n${body}`
      : `[Phone: ${from}]\n${body}`;

    const messages = [
      ...session.history,
      { role: "user", content: userContent },
    ];

    const { reply, messages: updatedMessages } = await runAgentLoop(messages);

    // Persist updated history for this phone number
    session.history = updatedMessages;

    // Extract member_id from messages if AI found one
    // (simple heuristic — look for MBR- pattern in recent content)
    const historyStr = JSON.stringify(updatedMessages);
    const mbrMatch = historyStr.match(/MBR-\d+/);
    if (mbrMatch) session.member_id = mbrMatch[0];

    // Send reply back via SMS
    // Twilio SMS has a 1600 char limit — split if needed
    const chunks = splitSMS(reply);
    for (const chunk of chunks) {
      await twilioClient.messages.create({ to: from, from: TWILIO_NUMBER, body: chunk });
    }
  } catch (err) {
    console.error("[sms error]", err);
    await twilioClient.messages.create({
      to: from,
      from: TWILIO_NUMBER,
      body: "Sorry, something went wrong. Please try again in a moment.",
    });
  }

  // Twilio expects a TwiML response — empty means we handled it ourselves
  res.set("Content-Type", "text/xml").send("<Response></Response>");
});

// Split long AI replies into ≤1550 char SMS chunks (safe under 1600 limit)
function splitSMS(text, maxLen = 1550) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// GET /health — simple health check
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─── Serve the PWA app ────────────────────────────────────────────────────────
// Railway serves both backend AND frontend from one URL. No Netlify needed.
app.use(express.static(join(__dirname, "../src"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Service-Worker-Allowed", "/");
    }
    if (filePath.endsWith("manifest.json")) {
      res.setHeader("Content-Type", "application/manifest+json");
    }
  }
}));

// Catch-all — serve demo.html for any route (PWA)
app.get("*", (_, res) => {
  res.sendFile(join(__dirname, "../src/demo.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nNEMT AI server running on http://localhost:${PORT}`);
  console.log(`App available at your Railway URL\n`);
});
