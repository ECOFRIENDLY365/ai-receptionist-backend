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

const supabase = createClient(supabaseUrl, supabaseKey);

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
            "In British English from the first word, say exactly: Hello, Pizza Express, Peter speaking. How can I help you today?",
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
- ask how you can help
- help with reservation enquiries first
- find out why they are calling
- help briefly and efficiently
- take a clear message when needed

Style:
- speak in British English from the very first word
- sound like a real UK receptionist on a phone call
- warm, natural, and concise
- keep sentences short and clear
- avoid repetition
- never sound like a chatbot

Important:
- most replies should be one short sentence or two short sentences at most
- do not repeat the greeting
- do not fill silence unnecessarily
- after asking a question, do not speak again until the caller responds
- do not interrupt the caller if they sound like they are still forming their sentence
- if the caller says something incomplete such as "I have a question", wait for the rest before replying
- do not leave long awkward pauses before replying once the caller has clearly finished speaking
- never say phrases like "no rush", "take your time", or "no worries" unless the caller explicitly asks for a moment
        `.trim(),
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_noise_reduction: {
          type: "far_field",
        },
        voice: "cedar",
        max_response_output_tokens: 100,
        turn_detection: {
          type: "server_vad",
          threshold: 0.84,
          prefix_padding_ms: 300,
          silence_duration_ms: 220,
          create_response: true,
          interrupt_response: false,
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

      if (msg.type === "session.updated") {
        console.log("SESSION UPDATED");
        sessionReady = true;
        maybeSendGreeting();
      }

      if (msg.type === "response.created") {
        activeResponseId = msg.response?.id || null;
        console.log("RESPONSE CREATED:", activeResponseId);
      }

      if (msg.type === "input_audio_buffer.speech_started") {
        console.log("OpenAI detected caller speech at", Date.now(), {
          assistantSpeaking,
          activeResponseId,
        });
      }

      if (msg.type === "input_audio_buffer.speech_stopped") {
        console.log("OpenAI detected caller speech stopped at", Date.now());
      }

      if (msg.type === "response.done") {
        console.log("RESPONSE DONE at", Date.now(), {
          responseId: activeResponseId,
        });
        activeResponseId = null;
        assistantSpeaking = false;
      }

      if (
        (msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta") &&
        msg.delta
      ) {
        assistantSpeaking = true;

        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta },
            })
          );
        }
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