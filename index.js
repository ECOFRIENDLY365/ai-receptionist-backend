import express from "express";
import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const OPENAI_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime";

console.log("Startup check:", {
  hasSupabaseUrl: !!supabaseUrl,
  hasSupabaseKey: !!supabaseKey,
  hasOpenAiKey: !!openaiApiKey,
  hasPublicBaseUrl: !!publicBaseUrl,
  publicBaseUrl,
});

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase credentials");
}

if (!openaiApiKey) {
  throw new Error("Missing OPENAI_API_KEY");
}

if (!publicBaseUrl) {
  throw new Error("Missing PUBLIC_BASE_URL");
}

// Keep your existing setup
createClient(supabaseUrl, supabaseKey);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/test", async (req, res) => {
  res.json({ success: true, message: "API reachable" });
});

app.post("/incoming-call", (req, res) => {
  try {
    console.log("Incoming call webhook hit", {
      from: req.body?.From,
      to: req.body?.To,
      callSid: req.body?.CallSid,
    });

    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect();

    connect.stream({
      url: `${publicBaseUrl.replace(/^http/, "ws")}/media-stream`,
    });

    const twiml = response.toString();
    console.log("Returning TwiML:", twiml);

    res.type("text/xml");
    res.send(twiml);
  } catch (err) {
    console.error("/incoming-call error:", err);
    res.status(500).send("Webhook error");
  }
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;
  let openaiWs = null;
  let sessionReady = false;
  let greetingSent = false;

  let activeResponseId = null;
  let assistantSpeaking = false;
  let currentAssistantItemId = null;

  let assistantAudioMsSent = 0;
  let assistantAudioMsPlayed = 0;

  let lastInterruptAt = 0;
  const INTERRUPT_DEBOUNCE_MS = 150;

  function ulawBase64ToMs(base64Audio) {
    const bytes = Buffer.from(base64Audio, "base64").length;
    return Math.round(bytes / 8); // g711 ulaw @ 8kHz = ~8 bytes per ms
  }

  function sendTwilioMark(ws, sid, playedMs) {
    if (!sid || ws.readyState !== WebSocket.OPEN) return;

    ws.send(
      JSON.stringify({
        event: "mark",
        streamSid: sid,
        mark: { name: `ai_ms_${playedMs}` },
      })
    );
  }

  function interruptAssistant() {
    const now = Date.now();
    if (now - lastInterruptAt < INTERRUPT_DEBOUNCE_MS) return;
    lastInterruptAt = now;

    if (!assistantSpeaking) return;

    console.log("INTERRUPTING AI", {
      activeResponseId,
      currentAssistantItemId,
      assistantAudioMsPlayed,
      assistantAudioMsSent,
    });

    // 1) Cancel generation
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(
        JSON.stringify({
          type: "response.cancel",
          response_id: activeResponseId || undefined,
        })
      );
    }

    // 2) Clear Twilio buffered audio
    if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "clear",
          streamSid,
        })
      );
    }

    // 3) Truncate assistant audio to what was actually played
    if (
      openaiWs &&
      openaiWs.readyState === WebSocket.OPEN &&
      currentAssistantItemId &&
      assistantAudioMsPlayed > 0
    ) {
      openaiWs.send(
        JSON.stringify({
          type: "conversation.item.truncate",
          item_id: currentAssistantItemId,
          content_index: 0,
          audio_end_ms: assistantAudioMsPlayed,
        })
      );
    }

    assistantSpeaking = false;

    setTimeout(() => {
      activeResponseId = null;
      currentAssistantItemId = null;
      assistantAudioMsSent = 0;
      assistantAudioMsPlayed = 0;
    }, 50);
  }

  function maybeSendGreeting() {
    if (!sessionReady) return;
    if (!streamSid) return;
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (greetingSent) return;

    greetingSent = true;

    console.log("Sending AI greeting");

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Give one short, natural greeting. Introduce yourself as the receptionist for Pizza Express and ask how you can help in one sentence. Do not repeat or add filler.",
        },
      })
    );
  }

  openaiWs = new WebSocket(OPENAI_URL, {
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: `
You are a professional female UK receptionist for Pizza Express.

Speak naturally, clearly, and confidently.
Keep responses short, usually 1 to 2 sentences.
Do not repeat yourself.
Do not use filler phrases.
Do not say things like "no rush" or "take your time" repeatedly.
If the caller pauses, wait silently.
If interrupted, stop immediately.
`.trim(),
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "cedar",
        output: {
          speed: 1.15,
        },
        max_output_tokens: 80,
        turn_detection: {
          type: "server_vad",
          threshold: 0.35,
          prefix_padding_ms: 120,
          silence_duration_ms: 200,
          create_response: true,
          interrupt_response: true,
        },
      },
    };

    console.log("Sending session.update");
    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      console.log("OpenAI event:", msg.type);

      if (msg.type === "input_audio_buffer.speech_started") {
        console.log("OpenAI detected caller speech");
        if (assistantSpeaking) {
          interruptAssistant();
        }
      }

      if (msg.type === "session.updated") {
        console.log("SESSION UPDATED");
        sessionReady = true;
        maybeSendGreeting();
      }

      if (msg.type === "response.created") {
        activeResponseId = msg.response?.id || null;
        console.log("RESPONSE CREATED:", activeResponseId);
      }

      if (
        msg.type === "response.output_item.added" &&
        msg.item?.type === "message" &&
        msg.item?.role === "assistant"
      ) {
        currentAssistantItemId = msg.item.id;
        console.log("ASSISTANT ITEM ID:", currentAssistantItemId);
      }

      if (
        (msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta") &&
        msg.delta
      ) {
        assistantSpeaking = true;

        const deltaMs = ulawBase64ToMs(msg.delta);
        assistantAudioMsSent += deltaMs;

        console.log("AUDIO DELTA MS:", deltaMs, "TOTAL:", assistantAudioMsSent);

        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta },
            })
          );

          sendTwilioMark(twilioWs, streamSid, assistantAudioMsSent);
        }
      }

      if (msg.type === "response.done") {
        activeResponseId = null;
        assistantSpeaking = false;
        console.log("RESPONSE DONE");
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("OpenAI WebSocket closed", {
      code,
      reason: reason?.toString?.(),
    });
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WebSocket error:", err);
  });

  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      if (msg.event !== "media") {
        console.log("Twilio event:", msg.event);
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("TWILIO START:", streamSid);
        maybeSendGreeting();
      }

      if (msg.event === "mark") {
        const name = msg.mark?.name || "";
        console.log("TWILIO MARK:", name);

        if (name.startsWith("ai_ms_")) {
          const played = Number(name.replace("ai_ms_", ""));
          if (!Number.isNaN(played)) {
            assistantAudioMsPlayed = Math.max(assistantAudioMsPlayed, played);
          }
        }
      }

      if (msg.event === "media") {
        if (msg.media?.payload) {
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: msg.media.payload,
              })
            );
          }
        }
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err);
    }
  });

  twilioWs.on("close", (code, reason) => {
    console.log("Twilio WebSocket closed", {
      code,
      reason: reason?.toString?.(),
    });

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WebSocket error:", err);
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});