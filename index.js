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
  let greetingInProgress = false;
  let firstCallerTurnStarted = false;
  let activeResponseId = null;
  let responsePending = false;
  let assistantSpeaking = false;
  let blockInputAudioUntil = 0;
  let openaiLastActivityAt = Date.now();
  let twilioLastActivityAt = Date.now();
  let heartbeatInterval = null;
  let watchdogInterval = null;
  let watchdogWarned = false;

  let lastOpenAiEventType = null;
  let lastTwilioEventType = null;
  let lastCallerAudioAt = 0;
  let lastAssistantAudioAt = 0;
  let lastResponseCreatedAt = 0;
  let lastResponseDoneAt = 0;
  let lastAssistantAudioStartedAt = 0;
  let loggedAudioStartForResponseId = null;
  let twilioMediaPackets = 0;
  let openAiAudioPackets = 0;

  function clearCallTimers() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
  }

  function maybeSendGreeting() {
    if (!sessionReady) return;
    if (!streamSid) return;
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (greetingSent) return;

    greetingSent = true;
    greetingInProgress = true;
    assistantSpeaking = true;
    blockInputAudioUntil = Date.now() + 1500;

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

    openaiLastActivityAt = Date.now();
    twilioLastActivityAt = Date.now();

    heartbeatInterval = setInterval(() => {
      try {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.ping();
        }
      } catch (err) {
        console.error("OpenAI ping failed:", err);
      }

      try {
        if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.ping();
        }
      } catch (err) {
        console.error("Twilio ping failed:", err);
      }
    }, 15000);

    watchdogInterval = setInterval(() => {
      const now = Date.now();
      const openaiIdleMs = now - openaiLastActivityAt;
      const twilioIdleMs = now - twilioLastActivityAt;

      if (
        twilioWs.readyState === WebSocket.OPEN &&
        openaiIdleMs > 25000 &&
        !watchdogWarned
      ) {
        watchdogWarned = true;

        console.warn("WATCHDOG: OpenAI looks idle/stalled", {
          openaiIdleMs,
          twilioIdleMs,
          openaiReadyState: openaiWs?.readyState,
          twilioReadyState: twilioWs?.readyState,
          sessionReady,
          streamSid,
          activeResponseId,
          assistantSpeaking,
          lastOpenAiEventType,
          lastTwilioEventType,
          msSinceCallerAudio: lastCallerAudioAt ? now - lastCallerAudioAt : null,
          msSinceAssistantAudio: lastAssistantAudioAt ? now - lastAssistantAudioAt : null,
          msSinceResponseCreated: lastResponseCreatedAt ? now - lastResponseCreatedAt : null,
          msSinceResponseDone: lastResponseDoneAt ? now - lastResponseDoneAt : null,
          twilioMediaPackets,
          openAiAudioPackets,
        });
      }
    }, 10000);

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: `
You are the warm, professional phone receptionist for Pizza Express.

Your role:
- greet callers naturally
- ask how you can help
- help with reservation enquiries first
- do not claim to complete or confirm a booking unless the system has actually done so
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
- never say phrases like "no rush", "take your time", "no worries", "of course", or "no problem" unless the caller explicitly asks for reassurance
- do not add polite filler at the start of replies
- answer the caller's request directly
- never start a sentence you cannot finish cleanly
- if discussing a reservation, say you can help with the reservation enquiry rather than claiming the booking is already being completed
- once you have repeated their booking reservation at the end, say "see you then!"
        `.trim(),
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_noise_reduction: {
          type: "far_field",
        },
        voice: "cedar",
        max_response_output_tokens: 220,
        turn_detection: {
          type: "server_vad",
          threshold: 0.84,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
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
    openaiLastActivityAt = Date.now();
    watchdogWarned = false;

    const msg = JSON.parse(data.toString());
    lastOpenAiEventType = msg.type || null;

    if (msg.type === "session.updated") {
      console.log("SESSION UPDATED");
      sessionReady = true;
      maybeSendGreeting();
    }

    if (msg.type === "response.created") {
      responsePending = false;
      activeResponseId = msg.response?.id || null;
      lastResponseCreatedAt = Date.now();
      loggedAudioStartForResponseId = null;
      console.log("RESPONSE CREATED:", activeResponseId, {
      metadata: msg.response?.metadata || null,
      });
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      const canCreateResponse =
        openaiWs &&
        openaiWs.readyState === WebSocket.OPEN &&
        !activeResponseId &&
        !responsePending &&
        !assistantSpeaking &&
        firstCallerTurnStarted;

      if (canCreateResponse) {
        responsePending = true;

        console.log("Caller speech stopped, creating response");

        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              metadata: {
                trigger: "speech_stopped",
                manualResponseId: `manual-${Date.now()}`
              },
            },
          })
        );
      } else {
        console.log("Skipped response.create after speech_stopped", {
          activeResponseId,
          responsePending,
          assistantSpeaking,
          firstCallerTurnStarted,
          blockRemainingMs: Math.max(0, blockInputAudioUntil - Date.now()),
        });
      }
    }

    if (msg.type === "response.output_audio.done") {
      console.log("OUTPUT AUDIO DONE at", Date.now(), {
        responseId: activeResponseId,
      });
    }

    if (msg.type === "response.output_audio.done") {
      console.log("OUTPUT AUDIO DONE at", Date.now(), {
        responseId: activeResponseId,
      });
    }

    if (msg.type === "response.done") {
      responsePending = false;
      lastResponseDoneAt = Date.now();
      console.log("RESPONSE DONE at", Date.now(), {
        responseId: activeResponseId,
      });

      if (greetingInProgress) {
        greetingInProgress = false;
      }

      activeResponseId = null;
      loggedAudioStartForResponseId = null;
      assistantSpeaking = false;
      blockInputAudioUntil = Date.now() + 100;
    }

    if (msg.type === "input_audio_buffer.speech_started") {
      const now = Date.now();
      const msSinceAssistantAudio = lastAssistantAudioAt
        ? now - lastAssistantAudioAt
        : null;

      if (!firstCallerTurnStarted && !greetingInProgress) {
        firstCallerTurnStarted = true;
        console.log("First caller turn detected");
      }

      if (msSinceAssistantAudio !== null && msSinceAssistantAudio < 2000) {
        console.log("DIAG: speech_started soon after assistant audio", {
          msSinceAssistantAudio,
          activeResponseId,
          lastResponseDoneAt,
          lastCallerAudioAt,
        });
      }
    }

    if (
      (msg.type === "response.output_audio.delta" ||
        msg.type === "response.audio.delta") &&
      msg.delta
    ) {
      const now = Date.now();

      assistantSpeaking = true;
      lastAssistantAudioAt = now;
      openAiAudioPackets += 1;

      if (
        activeResponseId &&
        loggedAudioStartForResponseId !== activeResponseId
      ) {
        loggedAudioStartForResponseId = activeResponseId;
        lastAssistantAudioStartedAt = now;

        console.log("ASSISTANT AUDIO STARTED", {
          responseId: activeResponseId,
          msFromResponseCreated: lastResponseCreatedAt
            ? now - lastResponseCreatedAt
            : null,
        });
      }

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
    clearCallTimers();

    console.log("OpenAI WebSocket closed", {
      code,
      reason: reason?.toString?.(),
      streamSid,
      sessionReady,
      activeResponseId,
      assistantSpeaking,
      openaiLastActivityAgoMs: Date.now() - openaiLastActivityAt,
      twilioLastActivityAgoMs: Date.now() - twilioLastActivityAt,
      lastOpenAiEventType,
      lastTwilioEventType,
      lastCallerAudioAt,
      lastAssistantAudioAt,
      lastResponseCreatedAt,
      lastResponseDoneAt,
      twilioMediaPackets,
      openAiAudioPackets,
    });
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WebSocket error:", err);
  });

  openaiWs.on("pong", () => {
    openaiLastActivityAt = Date.now();
  });

  twilioWs.on("message", (message) => {
    try {
      twilioLastActivityAt = Date.now();

      const msg = JSON.parse(message.toString());
      lastTwilioEventType = msg.event || null;

      if (msg.event !== "media" && msg.event !== "mark") {
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
      }

      if (msg.event === "media") {
        if (msg.media?.payload) {
          lastCallerAudioAt = Date.now();
          twilioMediaPackets += 1;

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
    clearCallTimers();

    console.log("Twilio WebSocket closed", {
      code,
      reason: reason?.toString?.(),
      streamSid,
      openaiReadyState: openaiWs?.readyState,
      openaiLastActivityAgoMs: Date.now() - openaiLastActivityAt,
      twilioLastActivityAgoMs: Date.now() - twilioLastActivityAt,
      lastOpenAiEventType,
      lastTwilioEventType,
      lastCallerAudioAt,
      lastAssistantAudioAt,
      lastResponseCreatedAt,
      lastResponseDoneAt,
      twilioMediaPackets,
      openAiAudioPackets,
    });

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WebSocket error:", err);
  });

  twilioWs.on("pong", () => {
    twilioLastActivityAt = Date.now();
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});