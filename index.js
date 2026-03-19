import express from "express";
import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials");
  process.exit(1);
}

if (!openaiApiKey) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

if (!publicBaseUrl) {
  console.error("Missing PUBLIC_BASE_URL");
  process.exit(1);
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
    res.status(500).json({ error: err.message });
  }
});

app.post("/incoming-call", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();

  connect.stream({
    url: `${publicBaseUrl.replace(/^http/, "ws")}/media-stream`,
  });

  res.type("text/xml");
  res.send(response.toString());
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio media stream connected");

  let streamSid = null;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are a professional AI receptionist. Answer politely, collect caller details, and keep responses short and helpful.",
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
      })
    );
  });

  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "response.output_audio.delta" && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
      }

      if (msg.type === "error") {
        console.error("OpenAI error:", msg);
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err.message);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WebSocket error:", err.message);
  });

  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("Stream started:", streamSid);
      }

      if (msg.event === "media") {
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            })
          );
        }
      }

      if (msg.event === "stop") {
        console.log("Stream stopped");
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err.message);
    }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});