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

const supabase = createClient(supabaseUrl, supabaseKey);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/test", async (req, res) => {
  try {
    const { data, error } = await supabase.from("Contacts").select("*").limit(1);
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error("/api/test error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/incoming-call", (req, res) => {
  try {
    console.log("Incoming call webhook hit", {
      from: req.body?.From,
      to: req.body?.To,
      callSid: req.body?.CallSid,
    });

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      { voice: "alice" },
      "Please hold while I connect you."
    );

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

  try {
    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
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

    const event = {
      type: "session.update",
      session: {
        type: "realtime",
        instructions:
          "You are a professional AI receptionist for a business.

Your job is to:
- greet callers warmly
- understand why they are calling
- collect their name and phone number if needed
- keep responses short and natural
- confirm important details

If you don’t know something, say a team member will follow up.

Never sound robotic. Speak like a real receptionist..",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: "alloy",
          },
        },
      },
    };

    console.log("Sending session.update");
    openaiWs.send(JSON.stringify(event));
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
        console.log("OpenAI event:", msg.type, msg);
      }

      if (
        msg.type === "response.output_audio.delta" &&
        msg.delta &&
        streamSid &&
        twilioWs.readyState === WebSocket.OPEN
      ) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
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

      if (msg.event === "connected") {
        console.log("Twilio connected event");
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("Twilio stream started:", {
          streamSid,
          callSid: msg.start.callSid,
        });
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