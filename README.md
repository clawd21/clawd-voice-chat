# Clawd Voice Chat 🦝🎙️

A real-time voice chat app powered by OpenAI's Realtime API with Slack integration for task handoff. Talk naturally, get instant voice responses, and delegate real work to an AI team in Slack.

## Architecture

```
┌─────────────┐    WebSocket     ┌──────────────┐    WebSocket     ┌─────────────────┐
│   Browser    │ ◄─────────────► │  Node Server  │ ◄─────────────► │  OpenAI Realtime │
│  (AudioWorklet)                │  (Express)    │                 │  API (gpt-4o-mini│
│              │                 │               │                 │  -realtime)      │
└─────────────┘                 └──────┬───────┘                 └─────────────────┘
                                        │
                                   Slack API
                                        │
                                ┌───────┴───────┐
                                │   Slack Team   │
                                │  (OpenClaw /   │
                                │   Claude)      │
                                └───────────────┘
```

**Two-brain architecture:**
- **Voice AI** (OpenAI Realtime) = "front desk" — instant conversational responses, zero tools
- **Slack AI** (Claude via OpenClaw) = "back office" — writes code, runs commands, does real work
- Voice transcripts are posted to Slack → Claude picks them up → results are polled back and read aloud

## Features

- 🎙️ Real-time voice conversation (~300ms latency)
- 💬 Text input for typing or pasting URLs
- 📎 Image upload (drag & drop or file picker) → posts to Slack
- 📰 Article reading — paste a URL, AI reads the full article aloud
- 🔄 Cross-device sync (theme, channel, cost, playback speed)
- 🎨 Three themes: Dark, Light, Neon
- 📱 PWA — Add to Home Screen with app icon
- ♾️ Infinite scroll chat history
- 💰 Real-time cost tracking
- 🔇 Mute/unmute AI voice
- ⏹️ Stop button to interrupt responses

## Prerequisites

- **Node.js** 18+ 
- **OpenAI API key** with Realtime API access
- **Two Slack apps** (see Slack Setup below)
- A Slack workspace with OpenClaw (or any bot) listening on channels

## Installation

```bash
git clone https://github.com/youruser/clawd-voice-chat.git
cd clawd-voice-chat
npm install
cp .env.example .env
# Edit .env with your keys (see below)
node server.js
```

## Environment Variables

Create a `.env` file:

```env
# Server
PORT=8470

# OpenAI — needs Realtime API access
OPENAI_API_KEY=sk-proj-your-key-here

# Slack Bot (your AI assistant's bot token)
SLACK_BOT_TOKEN=xoxb-your-bot-token

# Slack User (User app — posts voice transcripts as you)
SLACK_USER_TOKEN=xoxp-your-user-token

# Basic Auth (protects the web UI)
AUTH_USER=yourname
AUTH_PASS=your-secure-password
```

## Slack Setup

You need **two separate Slack apps**. This prevents the polling loop where the bot would read its own messages.

### App 1: "Voice User" (User Token — posts as you)

This app posts your voice transcripts to Slack so they appear as messages from you.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it "Voice User" (or whatever), select your workspace
3. Go to **OAuth & Permissions**
4. Under **User Token Scopes**, add:
   - `chat:write` — post messages as you
   - `files:write` — upload images/files
   - `files:read` — read uploaded files
   - `channels:read` — list channels (for channel ID resolution)
   - `groups:read` — list private channels
   - `users:read` — resolve user info
   - `identify` — basic identity
5. Click **Install to Workspace** → Authorize
6. Copy the **User OAuth Token** (`xoxp-...`) → put in `.env` as `SLACK_USER_TOKEN`

### App 2: "Clawd" (Bot Token — your AI assistant)

This is your AI bot that does the actual work. If you're using OpenClaw, this is already set up.

1. Create another Slack app (or use your existing bot)
2. Go to **OAuth & Permissions**
3. Under **Bot Token Scopes**, add:
   - `chat:write` — post bot messages
   - `channels:history` — read channel messages (for the poller)
   - `channels:read` — list channels
   - `groups:history` — read private channel messages
   - `groups:read` — list private channels
   - `users:read` — resolve bot user ID
   - `files:read` — read files (for image proxy)
   - `files:write` — upload files
4. **Install to Workspace** → copy **Bot User OAuth Token** (`xoxb-...`) → put in `.env` as `SLACK_BOT_TOKEN`
5. **Invite the bot** to the channels you want to use (`/invite @Clawd`)

### Why Two Apps?

The server polls Slack for bot responses and reads them back via voice. If the voice transcripts were posted by the same bot, the poller would pick them up and create an infinite echo loop. The `🎙️` prefix on voice messages is an extra safety filter, but separate apps make it bulletproof.

## Project Channels

Edit `PROJECT_CONTEXTS` in `server.js` to map dropdown options to Slack channels:

```javascript
const PROJECT_CONTEXTS = {
  do: {
    name: '#do',
    slackChannel: '#do',
    context: 'General tasks and configuration.',
  },
  // Add more...
};
```

Each project provides:
- `name` — displayed in the dropdown
- `slackChannel` — where voice transcripts are posted and bot responses are polled
- `context` — additional system prompt context for the voice AI

## Exposing to the Internet

### Option A: Cloudflare Tunnel (recommended)

```bash
# Install cloudflared
# Create a tunnel
cloudflared tunnel create voice-chat
cloudflared tunnel route dns <tunnel-id> voice.yourdomain.com

# Create ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: voice.yourdomain.com
    service: http://localhost:8470
  - service: http_status:404

# Run it
cloudflared tunnel run voice-chat
```

### Option B: Reverse Proxy (nginx/Caddy)

Make sure to proxy WebSocket connections (`Upgrade` and `Connection` headers).

## Running as a Service

```bash
# Create systemd service
sudo tee /etc/systemd/system/clawd-voice-chat.service << 'EOF'
[Unit]
Description=Clawd Voice Chat
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/clawd-voice-chat
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now clawd-voice-chat
```

## PWA / Add to Home Screen

The app includes a web manifest and service worker. On mobile:
- **iOS**: Share → Add to Home Screen
- **Android**: Three dots → Add to Home Screen

The service worker uses a network-first strategy — always fetches fresh code, falls back to cache if offline. Auto-checks for updates every 60 seconds.

## How It Works

### Voice Conversation Flow

1. Browser captures mic audio via `AudioWorklet`
2. Raw PCM → base64 → WebSocket → server → OpenAI Realtime API
3. OpenAI's server-side VAD detects speech end → generates response
4. Response audio streams back: OpenAI → server → browser → `AudioContext` playback
5. Transcript of your speech is posted to Slack as you (🎙️ prefix)

### Slack Handoff Flow

1. Your voice transcript appears in Slack channel
2. Your AI bot (OpenClaw/Claude/etc.) sees it and does the work
3. Bot posts response in the same channel
4. Server polls every 3s, finds new bot messages
5. Debounces 5s, truncates to 500 chars for voice
6. Injects into OpenAI conversation → voice AI relays it back to you

### Article Reading

1. Paste a URL in the text input
2. Server fetches page → Mozilla Readability extracts clean text
3. Text is chunked into 1500-char pieces
4. Each chunk is sent sequentially to OpenAI (waits for `response.done` before next)
5. Previous chunk's conversation item is deleted to prevent context overflow
6. Interruptible — speaking or hitting stop cancels remaining chunks

### Image Upload

1. Drag & drop or 📎 button stages the image
2. Type an optional message in the text input
3. Send → Multer receives the file → Slack `files.uploadV2` API posts it
4. Image appears in Slack with your message as the comment
5. Slack poller detects the image → sends `slack_image` event to browser
6. Browser renders thumbnail with click-to-zoom modal

## File Structure

```
clawd-voice-chat/
├── server.js          # Express server, WebSocket relay, Slack integration (~880 lines)
├── db.js              # SQLite database module (~100 lines)
├── package.json       # Dependencies
├── .env               # API keys and config (not committed)
├── voice-chat.db      # SQLite database (auto-created)
└── public/
    ├── index.html     # Single-page app (~1100 lines)
    ├── manifest.json  # PWA manifest
    ├── sw.js          # Service worker
    ├── icon-192.png   # App icon (192x192)
    ├── icon-512.png   # App icon (512x512)
    └── avatar.jpg # User avatar
```

## Dependencies

```json
{
  "@mozilla/readability": "^0.6.0",
  "better-sqlite3": "^11.0.0",
  "dotenv": "^16.0.0",
  "express": "^4.18.0",
  "linkedom": "^0.16.0",
  "multer": "^1.4.0",
  "ws": "^8.18.0"
}
```

## Screen Recording (Video Bug Reports)

Record your screen and narrate bugs or feature requests — the AI analyzes the video and suggests fixes.

1. **Tap 🔴** next to the 📎 button
2. **Share your screen** and talk through the issue
3. **Tap ⏹️** to stop — auto-uploads and analyzes
4. **GPT-4o Vision** extracts frames + transcribes audio → identifies the bug → speaks the analysis back

Works on desktop Chrome. On mobile, falls back to video file upload (Android PWA doesn't support screen capture). Requires `ffmpeg` on the server.

## Cost

Using `gpt-4o-mini-realtime-preview`:
- Input audio: **$10/M tokens**
- Output audio: **$20/M tokens**
- Text tokens are negligible

Typical conversation: ~$0.01-0.05 per back-and-forth. Article reading burns more (~$0.10-0.50 per article due to audio output tokens). The cost tracker in the header shows daily spend in real-time.

The full `gpt-4o-realtime-preview` model is 10x more expensive. We chose mini for cost efficiency — the tradeoff is slightly less consistent accent/personality adherence.

## Customization

### Voice Personality

Edit `BASE_INSTRUCTIONS` in `server.js` (~line 86). This is the system prompt for the voice AI.

### Themes

CSS custom properties in `index.html`. Three themes defined: `dark`, `light`, `neon`. Add more by creating a new `[data-theme="yourtheme"]` block and adding it to the `themeOrder` array in the JS.

### VAD Tuning

In `server.js`, the `buildSessionConfig` function sets:
```javascript
turn_detection: {
  type: 'server_vad',
  threshold: 0.5,          // Speech detection sensitivity
  prefix_padding_ms: 300,  // Audio kept before speech detected
  silence_duration_ms: 800 // How long to wait after silence before responding
}
```

Lower `silence_duration_ms` = faster responses but more false triggers. Higher = more natural pauses but slower.

## License

MIT
