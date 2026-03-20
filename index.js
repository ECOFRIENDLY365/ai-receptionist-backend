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

  function interruptAssistant() {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.send(
          JSON.stringify({
            type: "response.cancel",
          })
        );
      } catch (err) {
        console.error("Failed to cancel OpenAI response:", err);
      }
    }

    if (twilioWs && twilioWs.readyState === WebSocket.OPEN && streamSid) {
      try {
        twilioWs.send(
          JSON.stringify({
            event: "clear",
            streamSid,
          })
        );
      } catch (err) {
        console.error("Failed to clear Twilio audio:", err);
      }
    }

    assistantSpeaking = false;
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
            "Greet the caller briefly, naturally, and professionally. Introduce yourself as the receptionist and ask how you can help.",
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
You are the warm, professional phone receptionist for Pizza Express.

Your role:
- greet callers naturally
- find out why they are calling
- help briefly and efficiently
- take a clear message when needed

Style:
- sound human, calm, polished, and friendly
- use short natural sentences
- keep replies brief
- ask one question at a time
- do not sound robotic, scripted, or overly enthusiastic
- speak in a natural British call-handling style
- do not say you are an AI unless asked directly

Turn-taking:
- never interrupt the caller
- if they pause briefly, wait
- if they are still thinking, wait
- do not speak over them
- if interrupted, stop and listen
- when they finish, reply briefly

Call flow:
- begin with a short friendly greeting
- first understand the reason for the call
- collect only the necessary details
- if taking a message, get:
  - full name
  - phone number
  - reason for calling
  - preferred callback time if relevant
- repeat phone numbers slowly when confirming
- if something is unclear, ask only for the missing part

Important:
- do not repeat the greeting
- do not restart after interruptions
- do not fill silence unnecessarily
- most replies should be one or two short sentences
        `,
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "marin",
        turn_detection: {
          type: "server_vad",
          threshold: 0.55,
          prefix_padding_ms: 300,
          silence_duration_ms: 350,
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

      if (msg.type === "input_audio_buffer.speech_started") {
        console.log("Caller started speaking -> interrupting");
        interruptAssistant();
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

      if (msg.type === "response.done") {
        activeResponseId = null;
        assistantSpeaking = false;
        console.log("RESPONSE DONE");
      }

      if (
        (msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta") &&
        msg.delta
      ) {
        assistantSpeaking = true;

        if (streamSid && twilioWs && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta },
            })
          );

          twilioWs.send(
            JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: `audio-${Date.now()}` },
            })
          );
        }
      }

      if (msg.type === "error") {
        console.log("OPENAI ERROR:", JSON.stringify(msg, null, 2));
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
      console.log("TWILIO START", {
        streamSid,
        callSid: msg.start.callSid,
      });
      maybeSendGreeting();
    }

    if (msg.event === "mark") {
      console.log("Twilio mark received:", msg.mark?.name);
    }

    if (msg.event === "media") {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN && msg.media?.payload) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          })
        );
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