# AGENTS.md — Setup Guide for AI Agents

This file helps an AI coding agent (Cursor, Copilot, Claude Code, etc.) set up and configure Clawd Voice Chat from scratch.

## Prerequisites

- **Node.js** ≥ 18
- **OpenAI API key** with Realtime API access (`gpt-4o-mini-realtime-preview` or `gpt-4o-realtime-preview`)
- **Slack workspace** you control
- A machine that can run a persistent Node.js process (VPS, home server, etc.)

## Quick Start

```bash
git clone https://github.com/clawd21/clawd-voice-chat.git
cd clawd-voice-chat
npm install
cp .env.example .env
# Fill in .env (see below), then:
node server.js
```

## Environment Variables

Create `.env` from `.env.example`:

```env
PORT=8470
OPENAI_API_KEY=sk-proj-...         # OpenAI key with Realtime API access
SLACK_BOT_TOKEN=xoxb-...           # Bot app token (reads responses)
SLACK_USER_TOKEN=xoxp-...          # User app token (posts as user)
AUTH_USER=yourname                 # Basic auth username for web UI
AUTH_PASS=change-me                # Basic auth password (no # characters — breaks .env parsing)
```

## Slack App Setup

You need **two** Slack apps to avoid an echo loop (the bot polling its own messages).

### App 1: Voice User App (posts transcripts as the human)

Create at https://api.slack.com/apps → **Create New App** → **From an app manifest**

Paste this manifest (YAML):

```yaml
display_information:
  name: Voice Chat
  description: Posts voice transcripts to Slack as the user
  background_color: "#1a1d21"
features:
  bot_user:
    display_name: Voice Chat
    always_online: false
oauth_config:
  scopes:
    user:
      - chat:write
      - files:write
      - files:read
      - channels:read
      - groups:read
      - users:read
      - identify
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

After creating:
1. Go to **OAuth & Permissions** → **Install to Workspace**
2. Copy the **User OAuth Token** (`xoxp-...`) → `.env` as `SLACK_USER_TOKEN`

### App 2: AI Bot App (your assistant that does work)

If you already have a bot (OpenClaw, custom bot, etc.), use its token. Otherwise create one:

```yaml
display_information:
  name: Clawd
  description: AI assistant bot
  background_color: "#12051e"
features:
  bot_user:
    display_name: Clawd
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - users:read
      - files:read
      - files:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

After creating:
1. **Install to Workspace** → copy **Bot User OAuth Token** (`xoxb-...`) → `.env` as `SLACK_BOT_TOKEN`
2. Invite the bot to your channels: `/invite @Clawd`

### Why Two Apps?

The server polls Slack for bot responses and reads them back via voice AI. If voice transcripts were posted by the same bot, the poller would read them and create an infinite echo loop. Separate apps isolate the two message streams.

## Project Channels

Edit `PROJECT_CONTEXTS` in `server.js` (~line 105) to map dropdown options to your Slack channels:

```javascript
const PROJECT_CONTEXTS = {
  general: {
    name: '#general',
    slackChannel: '#general',
    context: 'General discussion and tasks.',
  },
  myproject: {
    name: '#my-project',
    slackChannel: '#my-project',
    context: 'Context about this project for the voice AI personality.',
  },
};
```

The `context` string is appended to the voice AI's system prompt when that channel is selected.

## Voice AI Personality

Edit `BASE_INSTRUCTIONS` in `server.js` (~line 90) to change the voice AI's personality, accent, and behavior.

## Architecture

```
Browser (PWA) ←WebSocket→ Express Server ←WebSocket→ OpenAI Realtime API
                               ↕
                          Slack API (poll bot responses, post transcripts)
                               ↕
                          SQLite (conversations, costs, preferences)
```

- **Browser → Server**: Audio chunks streamed over WebSocket
- **Server → OpenAI**: Relayed to Realtime API, responses streamed back
- **Slack integration**: Voice transcripts posted via user token; bot responses polled and read aloud
- **SQLite**: Persists chat history, daily cost tracking, user preferences (theme, playback speed, channel)

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express server, WebSocket relay, Slack integration, auth |
| `db.js` | SQLite schema and query helpers |
| `public/index.html` | Single-file SPA (HTML + CSS + JS) |
| `public/sw.js` | Service worker (network-first, PWA offline) |
| `public/manifest.json` | PWA manifest |
| `public/icon-192.png` | App icon 192×192 |
| `public/icon-512.png` | App icon 512×512 |
| `.env` | Secrets (gitignored) |

## Optional: Public Access via Cloudflare Tunnel

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Create tunnel
cloudflared tunnel login
cloudflared tunnel create voice-chat
cloudflared tunnel route dns voice-chat voice.yourdomain.com

# Config (~/.cloudflared/config.yml)
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: voice.yourdomain.com
    service: http://localhost:8470
  - service: http_status:404

# Run
cloudflared tunnel run voice-chat
```

## Optional: systemd Service

```ini
# /etc/systemd/system/clawd-voice-chat.service
[Unit]
Description=Clawd Voice Chat
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/clawd-voice-chat
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/path/to/clawd-voice-chat/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now clawd-voice-chat
```

## Optional: User Avatar

Place your own avatar at `public/avatar.jpg` for the user avatar in the chat UI. This file is gitignored — each deployment provides their own. Any 192×192 JPG/PNG works.

## Tuning Guide — Lessons Learned

These are hard-won learnings from building and tuning the real-time voice experience. Read this before making changes.

### VAD (Voice Activity Detection)

The OpenAI Realtime API uses server-side VAD. These settings live in the `session.update` call in `server.js`:

```javascript
turn_detection: {
  type: 'server_vad',
  threshold: 0.5,        // How loud audio must be to count as speech (0-1)
  prefix_padding_ms: 300, // Audio captured before speech detection triggers
  silence_duration_ms: 800 // How long silence before turn ends
}
```

**What we learned:**
- `threshold: 0.5` filters out most background noise but still catches normal speech
- `silence_duration_ms: 800` is a sweet spot — shorter causes premature cutoffs mid-sentence, longer makes conversations feel sluggish
- `prefix_padding_ms: 300` captures the start of words that triggered detection
- The `eagerness` parameter does NOT work on `gpt-4o-mini-realtime-preview` — only on the full model

### Interrupts (Barge-In)

When the user starts speaking while the AI is talking, you want instant interruption. This required fixes on both sides:

**Server side:**
- On `input_audio_buffer.speech_started`, send a `speech_started` event to the browser
- Send `response.cancel` to stop the AI's current response

**Client side:**
- On `speech_started`, immediately stop audio playback (`audioCtx.close()` + clear queue)
- **Critical: 500ms ignore window** (`ignoreAudioUntil = Date.now() + 500`) — without this, pre-buffered audio chunks that were already in-flight from the server continue playing after the interrupt, making it seem like the AI didn't stop
- On `speech_started`, clear the `aiSpeaking` flag

### Modalities — Always Specify `['text', 'audio']`

Every `response.create` call MUST include `modalities: ['text', 'audio']`. Without this, the API sometimes defaults to text-only responses — the AI "responds" but you hear nothing. This was a painful bug to find.

```javascript
// ✅ Correct
openaiWs.send(JSON.stringify({
  type: 'response.create',
  response: { modalities: ['text', 'audio'] }
}));

// ❌ Wrong — may produce silent responses
openaiWs.send(JSON.stringify({ type: 'response.create' }));
```

### Cancel Before New Response

Always send `response.cancel` before creating a new response. If a response is already active (even finishing), creating a new one throws `conversation_already_has_active_response`. The cancel is harmless if nothing is active.

### Article Reading — Chunked Approach

Large text inputs cause the model to generate empty/silent audio. The solution is chunking:

1. **Extract article** with Mozilla Readability (`@mozilla/readability` + `linkedom`) — naive HTML stripping pulls in SVG base64 junk
2. **Limit to 8000 chars** (`.slice(0, 8000)`)
3. **Split into 1500-char chunks** at sentence boundaries
4. **Send sequentially** via `response.done` handler — when one chunk finishes, send the next
5. **Delete old conversation items** between chunks (`conversation.item.delete`) — without this, context overflows and ALL subsequent responses fail
6. **Track state** on the WebSocket object: `_articleChunks`, `_articleIdx`, `_lastChunkItemId`
7. **Interrupt support**: On `speech_started` or explicit `cancel`, clear `_articleChunks` to stop the queue

### Multi-Person Awareness

The system prompt includes instructions to NOT respond when the user is clearly talking to someone else in the room. This is critical for hands-free use — without it, the AI jumps in on every conversation. The prompt says: "If you're not sure, stay quiet. Don't be jumpy."

### Whisper Hallucination Filtering

When the room is quiet or there's background noise (especially dogs, TV), Whisper/VAD can trigger with hallucinated text — often in CJK characters, YouTube outros, or single repeated words. The server filters these before sending to Slack.

### Slack Polling — Avoiding Echo Loops

The server polls Slack for bot responses to read aloud. Key design decisions:
- **Two separate Slack apps**: Voice transcripts posted via user token, bot responses read via bot token
- **🎙️ prefix filter**: Voice messages are prefixed with 🎙️ and the poller skips them
- **2-second debounce**: Batches rapid bot messages into a single voice readback
- **500-char truncation**: Long bot responses are truncated for voice (full text stays in Slack)
- **Bot user ID filter**: Only reads messages from the specific bot user ID

### Push-to-Talk (Pointer Events)

The mic button uses Pointer Events (not click/touch) for unified handling across desktop, mobile, and PWA:

```javascript
pointerdown → start recording immediately (no delay)
pointerup:
  - held ≥ 300ms → push-to-talk, stop on release
  - held < 300ms → toggle (tap on = stays on, tap off = stops)
```

Key details:
- `touch-action: none` and `user-select: none` on the button CSS
- Block `contextmenu` and `touchstart` (prevent copy popup on long press)
- `document.activeElement?.blur()` on press (dismiss mobile keyboard)
- Spacebar hold-to-talk on desktop (only when not focused on text input)

### Model Selection

- `gpt-4o-mini-realtime-preview` — ~10x cheaper, good enough for conversation, but doesn't support `eagerness` param
- `gpt-4o-realtime-preview` — better voice quality, supports all params, but expensive for casual use
- Article reading burns audio tokens fast (~$0.10-0.50 per article)

### PWA Caching

The service worker uses network-first strategy — always fetches fresh code, falls back to cache if offline. It auto-checks for updates every 60 seconds. Auth bypass is configured for `/manifest.json`, `/sw.js`, and icon files so the PWA can install without credentials.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `401 Unauthorized` | Check `AUTH_USER` / `AUTH_PASS` in `.env` |
| No voice response | Verify `OPENAI_API_KEY` has Realtime API access |
| Slack messages not appearing | Check `SLACK_USER_TOKEN` scopes, ensure bot is invited to channel |
| Bot responses not read aloud | Check `SLACK_BOT_TOKEN` scopes, ensure `channels:history` is granted |
| Echo loop | Make sure you're using **two different** Slack apps |
| PWA not updating | Service worker caches aggressively; hard refresh or wait 60s |
| `AUTH_PASS` not working | Don't use `#` in the password — it's treated as a comment in `.env` |
