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

wss.on("connection", (twilioWs, req) => {
  console.log("Twilio media stream connected", {
    url: req.url,
    userAgent: req.headers["user-agent"],
  });

  let streamSid = null;
  let openaiWs = null;
  let sessionReady = false;
  let greetingSent = false;

  function maybeSendGreeting() {
    console.log("maybeSendGreeting called", {
      greetingSent,
      sessionReady,
      streamSid,
      openaiReadyState: openaiWs?.readyState,
    });

    if (
      greetingSent ||
      !sessionReady ||
      !streamSid ||
      !openaiWs ||
      openaiWs.readyState !== WebSocket.OPEN
    ) {
      console.log("Greeting blocked", {
        greetingSent,
        sessionReady,
        hasStreamSid: !!streamSid,
        hasOpenAiWs: !!openaiWs,
        openaiReadyState: openaiWs?.readyState,
      });
      return;
    }

    greetingSent = true;
    console.log("Sending AI greeting");

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Say exactly: Hello, thank you for calling Pizza Express. How can I help you today?",
        },
      })
    );
  }

  try {
    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );
  } catch (err) {
    console.error("Failed to create OpenAI websocket:", err);
    try {
      twilioWs.close();
    } catch {}
    return;
  }

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
          threshold: 0.65,
          prefix_padding_ms: 300,
          silence_duration_ms: 900,
          create_response: false,
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

      if (
        msg.type === "session.created" ||
        msg.type === "session.updated" ||
        msg.type === "response.created" ||
        msg.type === "response.done" ||
        msg.type === "error"
      ) {
        console.log("OpenAI event type:", msg.type);
      }

      if (msg.type === "error") {
        console.log("OPENAI ERROR:", JSON.stringify(msg, null, 2));
      }

      if (msg.type === "session.updated") {
        console.log("SESSION UPDATED");
        sessionReady = true;
        maybeSendGreeting();
      }

      if (msg.type === "response.created") {
        console.log("RESPONSE CREATED:", msg.response?.id);
      }

      if (msg.type === "response.done") {
        console.log("RESPONSE DONE:", msg.response?.id, msg.response?.status);
        console.log(
          "RESPONSE DONE OUTPUT:",
          JSON.stringify(msg.response?.output, null, 2)
        );
      }

      if (msg.type === "response.output_item.done") {
        console.log("OUTPUT ITEM DONE:", JSON.stringify(msg.item, null, 2));
      }

      if (msg.type === "response.content_part.added") {
        console.log("CONTENT PART ADDED type:", msg.part?.type);
        console.log("CONTENT PART ADDED has audio:", !!msg.part?.audio);
        console.log("CONTENT PART ADDED keys:", Object.keys(msg.part || {}));
        console.log("CONTENT PART ADDED transcript:", msg.part?.transcript);
      }

      if (msg.type === "response.content_part.done") {
        console.log("CONTENT PART DONE type:", msg.part?.type);
        console.log("CONTENT PART DONE has audio:", !!msg.part?.audio);
        console.log("CONTENT PART DONE keys:", Object.keys(msg.part || {}));
        console.log("CONTENT PART DONE transcript:", msg.part?.transcript);
      }

      // Handle both possible OpenAI audio delta event names
      if (
        (msg.type === "response.output_audio.delta" ||
          msg.type === "response.audio.delta") &&
        msg.delta
      ) {
        console.log("Audio delta event:", msg.type, "length:", msg.delta.length);

        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
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

          console.log("Forwarded audio delta to Twilio");
        }
      }

      if (msg.type === "response.output_audio.done") {
        console.log("Audio stream finished");
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
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            })
          );
        }
      }

      if (msg.event === "stop") {
        console.log("Twilio stream stopped");
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
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