import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { addUsage, getTodayCost, startSession, endSession, addMessage, getHistory, clearHistory as dbClearHistory, getPreference, setPreference } from './db.js';
import multer from 'multer';
import { createReadStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config (config.json for personal data, config.example.json as fallback)
const configPath = join(__dirname, existsSync(join(__dirname, 'config.json')) ? 'config.json' : 'config.example.json');
const CONFIG = JSON.parse(readFileSync(configPath, 'utf-8'));
const BOT_NAME = CONFIG.botName || 'Assistant';
const USER_NAME = CONFIG.userName || 'User';

const PORT = process.env.PORT || 8470;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY is required. Set it in .env or environment.');
  process.exit(1);
}

const app = express();

// Basic auth
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'changeme';

function basicAuth(req, res, next) {
  // Skip auth for PWA manifest, icons, and service worker
  if (['/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png'].includes(req.path)) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Voice Chat"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Voice Chat"');
  return res.status(401).send('Invalid credentials');
}

app.use(basicAuth);
app.use(express.static(join(__dirname, 'public'), { etag: false, maxAge: 0 }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json());

// ─── Chat History (SQLite) ───
function saveHistory(entry) {
  addMessage(entry.role, entry.text, entry.project || 'do');
}

app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before) : null;
  res.json(getHistory(limit, before));
});
app.delete('/api/history', (req, res) => { dbClearHistory(); res.json({ ok: true }); });

// ─── Preferences (SQLite, synced across devices) ───
app.get('/api/preferences', (req, res) => {
  const theme = getPreference('theme') || 'dark';
  const playbackSpeed = getPreference('playbackSpeed') || '1';
  const channel = getPreference('channel') || 'do';
  res.json({ theme, playbackSpeed, channel });
});

app.put('/api/preferences', (req, res) => {
  const { key, value } = req.body;
  if (key && value != null) {
    setPreference(key, String(value));
    // Broadcast to all connected clients
    const msg = JSON.stringify({ type: 'pref_sync', key, value: String(value) });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'key and value required' });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Build instructions from config, replacing {botName} and {userName} placeholders
const BASE_INSTRUCTIONS = (CONFIG.instructions || `You are {botName}, {userName}'s AI assistant. Be concise — 1-3 sentences max. You're on a voice call, not writing an essay.`)
  .replace(/\{botName\}/g, BOT_NAME)
  .replace(/\{userName\}/g, USER_NAME);

// Load project channels from config
const PROJECT_CONTEXTS = CONFIG.projects || {
  general: { name: '#general', slackChannel: '#general', context: 'General discussion.' },
};

// API endpoint for client config (names, avatars)
app.get('/api/config', (req, res) => {
  res.json({
    botName: BOT_NAME,
    userName: USER_NAME,
    botAvatar: CONFIG.botAvatar || '/icon-192.png',
    userAvatar: CONFIG.userAvatar || '/avatar.jpg',
  });
});

// API endpoint to list projects
app.get('/api/projects', (req, res) => {
  const projects = Object.entries(PROJECT_CONTEXTS).map(([id, p]) => ({ id, name: p.name }));
  res.json(projects);
});

// Latest Slack images for a project (fallback for missed websocket events)
app.get('/api/slack-images', async (req, res) => {
  try {
    if (!SLACK_BOT_TOKEN) return res.json({ ok: false, error: 'Slack token not configured', images: [] });
    const projectId = req.query.project || 'do';
    const project = PROJECT_CONTEXTS[projectId] || PROJECT_CONTEXTS.do;
    const channelId = await resolveSlackChannel(project.slackChannel);
    if (!channelId) return res.json({ ok: false, error: 'Could not resolve Slack channel', images: [] });

    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const r = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&limit=${limit}`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await r.json();
    if (!data.ok) return res.json({ ok: false, error: data.error || 'history_failed', images: [] });

    const images = [];
    for (const msg of data.messages || []) {
      const files = msg.files || [];
      for (const f of files) {
        if (!(f?.mimetype || '').startsWith('image/')) continue;
        images.push({
          fileId: f.id,
          name: f.name || 'image',
          text: msg.text || '',
          ts: msg.ts,
          from: msg.username || msg.user || 'Slack',
          url: `/api/slack-file/${f.id}?ts=${encodeURIComponent(msg.ts || Date.now())}`,
        });
      }
    }

    res.json({ ok: true, images });
  } catch (e) {
    res.json({ ok: false, error: e.message, images: [] });
  }
});

// Image upload to Slack
const upload = multer({ dest: '/tmp/voice-uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  console.log('📎 Upload request received', req.file?.originalname, req.file?.size);
  try {
    const file = req.file;
    if (!file) return res.json({ ok: false, error: 'No file received' });
    const projectId = req.body.project || 'do';
    const project = PROJECT_CONTEXTS[projectId] || PROJECT_CONTEXTS.do;
    const channelId = await resolveSlackChannel(project.slackChannel);
    console.log('📎 Uploading to channel:', project.slackChannel, channelId);
    if (!channelId) return res.json({ ok: false, error: 'Could not resolve Slack channel' });

    const token = process.env.SLACK_USER_TOKEN || SLACK_BOT_TOKEN;
    const fileData = readFileSync(file.path);
    const comment = req.body.comment || '';

    // Step 1: Get upload URL
    const getUrlRes = await fetch(`https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(file.originalname)}&length=${fileData.length}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const urlData = await getUrlRes.json();
    console.log('📎 getUploadURL:', urlData.ok, urlData.error || '');
    if (!urlData.ok) return res.json({ ok: false, error: urlData.error });

    // Step 2: Upload file to the URL
    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': file.mimetype },
      body: fileData,
    });

    // Step 3: Complete the upload
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: file.originalname }],
        channel_id: channelId,
        initial_comment: comment ? `🎙️ ${comment}` : `📎 ${file.originalname}`,
      }),
    });
    const data = await completeRes.json();
    console.log('📎 Slack complete:', data.ok, data.error || '');
    // Clean up temp file
    try { (await import('fs/promises')).unlink(file.path); } catch {}
    if (data.ok) {
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: data.error });
    }
  } catch (e) {
    console.error('📎 Upload error:', e);
    res.json({ ok: false, error: e.message });
  }
});

// Proxy Slack file to browser (so the voice site can display private Slack images)
app.get('/api/slack-file/:fileId', async (req, res) => {
  try {
    if (!SLACK_BOT_TOKEN) return res.status(500).send('Slack token not configured');
    const fileId = req.params.fileId;

    const infoRes = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const info = await infoRes.json();
    if (!info.ok || !info.file?.url_private_download) {
      return res.status(404).send(info.error || 'File not found');
    }

    const url = info.file.url_private_download;
    const fileRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    });
    if (!fileRes.ok) return res.status(fileRes.status).send('Failed to fetch file');

    const contentType = fileRes.headers.get('content-type') || info.file.mimetype || 'application/octet-stream';
    const contentDisp = info.file.name ? `inline; filename="${info.file.name}"` : 'inline';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisp);

    const arr = await fileRes.arrayBuffer();
    res.send(Buffer.from(arr));
  } catch (e) {
    res.status(500).send(e.message || 'Slack proxy error');
  }
});

// Slack channel name → ID cache
const slackChannelCache = {};

async function resolveSlackChannel(channelName) {
  if (!SLACK_BOT_TOKEN) return null;
  const name = channelName.replace('#', '');
  if (slackChannelCache[name]) return slackChannelCache[name];

  try {
    const res = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200', {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    if (data.ok) {
      for (const ch of data.channels) {
        slackChannelCache[ch.name] = ch.id;
      }
    }
  } catch (e) {
    console.error('Failed to list Slack channels:', e.message);
  }
  return slackChannelCache[name] || null;
}

async function postToSlack(channelName, text, { asUser = false } = {}) {
  const token = asUser ? SLACK_USER_TOKEN : SLACK_BOT_TOKEN;
  if (!token || !channelName) return;
  const channelId = await resolveSlackChannel(channelName);
  if (!channelId) {
    console.error(`Slack channel not found: ${channelName}`);
    return;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, text }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`Slack post failed: ${data.error}`);
    else console.log(`💬 Posted to ${channelName} as ${asUser ? USER_NAME : BOT_NAME}`);
  } catch (e) {
    console.error('Failed to post to Slack:', e.message);
  }
}

function buildSessionConfig(projectId) {
  const project = PROJECT_CONTEXTS[projectId] || PROJECT_CONTEXTS.do;
  const instructions = BASE_INSTRUCTIONS + (project.context ? '\n\n' + project.context : '');
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      voice: 'ash',
      instructions,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'whisper-1',
      },
      turn_detection: CONFIG.turn_detection || {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 800,
      },
    },
  };
}

// Bot user ID (for filtering responses)
let botUserId_cached = null;

async function getBotUserId() {
  if (botUserId_cached) return botUserId_cached;
  if (!SLACK_BOT_TOKEN) return null;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    if (data.ok) {
      botUserId_cached = data.user_id;
      console.log(`🤖 Bot user ID: ${botUserId_cached}`);
    }
  } catch (e) {
    console.error('Failed to get bot user ID:', e.message);
  }
  return botUserId_cached;
}

// Poll Slack for bot responses
function startSlackPoller(clientId, channelName, openaiWs, clientWs, getIsClosing) {
  let lastTs = (Date.now() / 1000).toFixed(6);
  let isSpeaking = false;
  let pendingMessages = [];
  let debounceTimer = null;
  const seenSlackFiles = new Set();

  // Track when voice AI is speaking to avoid interrupting
  const origSend = clientWs.send.bind(clientWs);
  
  const flushPending = () => {
    if (pendingMessages.length === 0 || getIsClosing()) return;
    
    // Combine all pending messages into one summary
    let combined;
    if (pendingMessages.length === 1) {
      combined = pendingMessages[0];
    } else {
      // Just use the last message if multiple came in quick succession
      combined = pendingMessages[pendingMessages.length - 1];
      console.log(`📦 [${clientId}] Batched ${pendingMessages.length} messages, using latest`);
    }
    pendingMessages = [];

    // Truncate very long messages for voice
    const maxLen = 500;
    const text = combined.length > maxLen 
      ? combined.slice(0, maxLen) + '... and more details in Slack.'
      : combined;

    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: `[SYSTEM: The bot posted this update in Slack. Relay the key info to ${USER_NAME} in your own voice. Be very brief, 1-2 sentences. Skip technical details and status updates. If it's not worth mentioning, say nothing.]\n\n${BOT_NAME} says: ${text}`,
          }],
        },
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
    }

    clientWs.send(JSON.stringify({
      type: 'transcript',
      role: 'assistant',
      delta: `\n[${BOT_NAME} via Slack]: ${combined.slice(0, 200)}${combined.length > 200 ? '...' : ''}\n`,
    }));
  };

  const poll = async () => {
    if (getIsClosing()) return;
    
    const channelId = await resolveSlackChannel(channelName);
    const botUserId = await getBotUserId();
    if (!channelId || !botUserId) return;

    try {
      const res = await fetch(
        `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${lastTs}&limit=50`,
        { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } }
      );
      const data = await res.json();
      
      if (data.ok && data.messages?.length) {
        const msgs = data.messages.reverse();
        for (const msg of msgs) {
          // Forward image attachments to voice web UI
          if (msg.files) console.log(`🖼️ [${clientId}] Message has ${msg.files.length} files:`, msg.files.map(f => `${f.id}:${f.mimetype}`));
          if (Array.isArray(msg.files) && msg.files.length) {
            for (const f of msg.files) {
              if (!f?.id || seenSlackFiles.has(f.id)) continue;
              const isImage = (f.mimetype || '').startsWith('image/');
              if (!isImage) continue;
              seenSlackFiles.add(f.id);

              const imgUrl = `/api/slack-file/${f.id}?ts=${encodeURIComponent(msg.ts || Date.now())}`;
              const imgName = f.name || 'image';
              const imgText = msg.text || '';
              addMessage('image', imgText || imgName, 'general', imgUrl);
              clientWs.send(JSON.stringify({
                type: 'slack_image',
                fileId: f.id,
                name: imgName,
                from: msg.username || msg.user || 'Slack',
                text: imgText,
                ts: msg.ts,
                url: imgUrl,
              }));
            }
          }

          if (msg.bot_id && msg.user === botUserId && !msg.text?.startsWith('🎙️')) {
            console.log(`📢 [${clientId}] Bot responded: "${msg.text?.slice(0, 60)}..."`);
            pendingMessages.push(msg.text);
            lastTs = msg.ts;
            
            // Debounce: wait 2s for more messages before flushing
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(flushPending, 5000);
          } else if (msg.ts > lastTs) {
            lastTs = msg.ts;
          }
        }
      }
    } catch (e) {
      // Silently ignore
    }
  };

  const interval = setInterval(poll, 3000);
  return () => {
    clearInterval(interval);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

wss.on('connection', (clientWs, req) => {
  const clientId = `client-${Date.now()}`;
  console.log(`🔌 [${clientId}] Browser connected from ${req.socket.remoteAddress}`);

  let openaiWs = null;
  let isClosing = false;

  // Connect to OpenAI Realtime API
  openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  let currentProject = 'do';
  let pendingAssistantTranscript = '';
  let sessionMsgCount = 0;
  let sessionCost = 0;

  // Track session in DB and send current daily cost
  try {
    startSession(clientId);
    const dailyCost = getTodayCost();
    clientWs.send(JSON.stringify({ type: 'cost_sync', daily: dailyCost }));
    const theme = getPreference('theme') || 'dark';
    const playbackSpeed = getPreference('playbackSpeed') || '1';
    clientWs.send(JSON.stringify({ type: 'pref_sync', key: 'theme', value: theme }));
    clientWs.send(JSON.stringify({ type: 'pref_sync', key: 'playbackSpeed', value: playbackSpeed }));
  } catch (e) { console.error('DB session start error:', e.message); }
  let lastUserTranscript = '';
  let stopPoller = null;

  openaiWs.on('open', () => {
    console.log(`🤖 [${clientId}] Connected to OpenAI Realtime API`);
    openaiWs.send(JSON.stringify(buildSessionConfig(currentProject)));
    clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));
  });

  openaiWs.on('message', (data) => {
    if (isClosing) return;

    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case 'session.created':
          console.log(`✅ [${clientId}] Session created: ${event.session?.id}`);
          break;

        case 'session.updated':
          console.log(`⚙️  [${clientId}] Session configured`);
          clientWs.send(JSON.stringify({ type: 'status', status: 'ready' }));
          // Start polling Slack for bot responses
          if (stopPoller) stopPoller();
          const project = PROJECT_CONTEXTS[currentProject];
          if (project?.slackChannel) {
            stopPoller = startSlackPoller(clientId, project.slackChannel, openaiWs, clientWs, () => isClosing);
            console.log(`👂 [${clientId}] Listening for bot responses in ${project.slackChannel}`);
          }
          break;

        case 'response.audio.delta':
          // Relay audio back to browser
          clientWs.send(JSON.stringify({
            type: 'audio',
            delta: event.delta,
          }));
          break;

        case 'response.audio_transcript.delta':
          pendingAssistantTranscript += (event.delta || '');
          clientWs.send(JSON.stringify({
            type: 'transcript',
            role: 'assistant',
            delta: event.delta,
          }));
          break;

        case 'conversation.item.input_audio_transcription.completed':
          lastUserTranscript = event.transcript || '';
          clientWs.send(JSON.stringify({
            type: 'transcript',
            role: 'user',
            text: event.transcript,
          }));
          if (lastUserTranscript.trim()) {
            saveHistory({ role: 'user', text: lastUserTranscript.trim(), time: new Date().toISOString(), project: currentProject });
          }
          // Post user message to Slack (filter Whisper hallucinations)
          {
            const project = PROJECT_CONTEXTS[currentProject];
            const text = lastUserTranscript.trim();
            const isHallucination = !text || text.length < 3 ||
              /^[\u3000-\u9FFF\uAC00-\uD7AF\u1100-\u11FF]+/.test(text) || // CJK/Korean
              /thank.*watch|subscribe|like.*comment|please.*like/i.test(text) || // YouTube outro
              /^(you|the|a|I|um|uh)\.?$/i.test(text); // Single word garbage
            
            if (project?.slackChannel && text && !isHallucination) {
              postToSlack(project.slackChannel, `🎙️ ${text}`, { asUser: true });
            } else if (isHallucination && text) {
              console.log(`🗑️ Filtered hallucination: "${text}"`);
            }
          }
          break;

        case 'response.audio.done':
          clientWs.send(JSON.stringify({ type: 'audio_done' }));
          break;

        case 'response.done':
          const rdStatus = event.response?.status;
          if (rdStatus === 'failed') {
            const errMsg = event.response?.status_details?.error?.message || 'Response failed';
            clientWs.send(JSON.stringify({ type: 'error', error: errMsg }));
            // Stop article reading on failure
            if (clientWs._articleChunks) { clientWs._articleChunks = null; }
          }
          console.log(`📡 [${clientId}] response.done status=${rdStatus} modalities=${JSON.stringify(event.response?.modalities)} output=${JSON.stringify(event.response?.output?.map(o=>({type:o.type,status:o.status,content:o.content?.map(c=>({type:c.type,tlen:c.transcript?.length||0}))})))}${rdStatus === 'failed' ? ' status_details=' + JSON.stringify(event.response?.status_details) : ''}`);
          // Extract usage data and send to client
          if (event.response?.usage) {
            const u = event.response.usage;
            // Track in SQLite
            const dailyCost = addUsage({
              input_token_details: u.input_token_details || {},
              output_token_details: u.output_token_details || {},
            });
            sessionMsgCount++;
            // Send daily total to client
            clientWs.send(JSON.stringify({
              type: 'usage',
              input_tokens: u.input_tokens || 0,
              output_tokens: u.output_tokens || 0,
              total_tokens: u.total_tokens || 0,
              input_token_details: u.input_token_details || {},
              output_token_details: u.output_token_details || {},
              daily: dailyCost,
            }));
            // Broadcast updated cost to all connected clients
            wss.clients.forEach(c => {
              if (c !== clientWs && c.readyState === WebSocket.OPEN) {
                c.send(JSON.stringify({ type: 'cost_sync', daily: dailyCost }));
              }
            });
          }
          clientWs.send(JSON.stringify({ type: 'response_done' }));
          if (pendingAssistantTranscript.trim()) {
            saveHistory({ role: 'assistant', text: pendingAssistantTranscript.trim(), time: new Date().toISOString(), project: currentProject });
          }
          pendingAssistantTranscript = '';
          
          // Continue reading article chunks
          if (clientWs._articleChunks && clientWs._articleIdx < clientWs._articleChunks.length - 1) {
            clientWs._articleIdx++;
            const idx = clientWs._articleIdx;
            const chunks = clientWs._articleChunks;
            const isLast = idx === chunks.length - 1;
            const chunkPrompt = `Continue reading the article "${clientWs._articleTitle}". Read this NEXT section word for word, naturally. Do NOT summarize:\n\n${chunks[idx]}${isLast ? '\n\n[This is the last section. Say something like "And that concludes the article."]' : '\n\n[Say "continuing..." at the end]'}`;
            console.log(`📖 [${clientId}] Sending chunk ${idx + 1}/${chunks.length}`);
            if (openaiWs?.readyState === WebSocket.OPEN) {
              // Delete previous chunk items to avoid context overflow
              const prevOutput = event.response?.output;
              if (prevOutput) {
                for (const item of prevOutput) {
                  if (item.id) openaiWs.send(JSON.stringify({ type: 'conversation.item.delete', item_id: item.id }));
                }
              }
              // Also delete the previous user prompt
              if (clientWs._lastChunkItemId) {
                openaiWs.send(JSON.stringify({ type: 'conversation.item.delete', item_id: clientWs._lastChunkItemId }));
              }
              openaiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: chunkPrompt }] }
              }));
              openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
            }
            if (isLast) { clientWs._articleChunks = null; }
          }
          break;

        case 'input_audio_buffer.speech_started':
          clientWs.send(JSON.stringify({ type: 'speech_started' }));
          // Stop article reading if user interrupts
          if (clientWs._articleChunks) {
            console.log(`⏹️ [${clientId}] User interrupted article reading at chunk ${(clientWs._articleIdx || 0) + 1}/${clientWs._articleChunks.length}`);
            clientWs._articleChunks = null;
          }
          break;

        case 'input_audio_buffer.speech_stopped':
          clientWs.send(JSON.stringify({ type: 'speech_stopped' }));
          break;

        case 'error':
          if (event.error?.code === 'response_cancel_not_active') break; // harmless
          console.error(`❌ [${clientId}] OpenAI error:`, event.error);
          clientWs.send(JSON.stringify({
            type: 'error',
            error: event.error?.message || 'Unknown error',
          }));
          break;

        default:
          if (event.type === 'conversation.item.created' && event.item?.role === 'user') {
            clientWs._lastChunkItemId = event.item.id;
          }
          if (event.type === 'response.done') {
            console.log(`📡 [${clientId}] response.done status=${event.response?.status} output_length=${JSON.stringify(event.response?.output?.map(o => ({ type: o.type, content: o.content?.map(c => ({ type: c.type, len: c.transcript?.length || c.text?.length || 0 })) })))}`);
          } else if (event.type && !event.type.includes('audio.delta') && !event.type.includes('input_audio_buffer')) {
            console.log(`📡 [${clientId}] ${event.type}`);
          }
          // Log unhandled events at debug level
          if (process.env.DEBUG) {
            console.log(`📨 [${clientId}] ${event.type}`);
          }
      }
    } catch (err) {
      console.error(`❌ [${clientId}] Error parsing OpenAI message:`, err.message);
    }
  });

  openaiWs.on('error', (err) => {
    console.error(`❌ [${clientId}] OpenAI WS error:`, err.message);
    if (!isClosing) {
      clientWs.send(JSON.stringify({
        type: 'error',
        error: 'Connection to AI lost',
      }));
    }
  });

  openaiWs.on('close', (code, reason) => {
    console.log(`🔌 [${clientId}] OpenAI WS closed: ${code} ${reason}`);
    if (!isClosing) {
      clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
    }
  });

  // Handle messages from browser
  clientWs.on('message', (data) => {
    if (isClosing) return;

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'audio' && msg.audio) {
        // Forward audio to OpenAI
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.audio,
          }));
        }
      } else if (msg.type === 'cancel') {
        if (openaiWs?.readyState === WebSocket.OPEN) {
          try {
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
            // Also clear the audio buffer to prevent stale audio
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          } catch(e) {}
          console.log(`⏹️ [${clientId}] Response cancelled`);
          // Stop article reading
          if (clientWs._articleChunks) { clientWs._articleChunks = null; console.log(`⏹️ [${clientId}] Article reading stopped`); }
        }
      } else if (msg.type === 'text_message') {
        (async () => {
          const text = msg.text || '';
          console.log(`💬 [${clientId}] Text message: ${text.slice(0, 80)}`);
          saveHistory({ role: 'user', text, project: currentProject });
          
          // Strip Slack angle-bracket URL formatting
          const cleanText = text.replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1');
          const urlMatch = cleanText.match(/(https?:\/\/[^\s<>]+)/i);
          // Cancel any in-progress response first (ignore error if none active)
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          if (urlMatch) {
            try {
              const url = urlMatch[1];
              console.log(`🔗 [${clientId}] Fetching URL: ${url}`);
              clientWs.send(JSON.stringify({ type: 'system', text: `Fetching ${url}...` }));
              const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
              const html = await resp.text();
              console.log(`📄 [${clientId}] Fetched ${html.length} chars, status ${resp.status}`);
              // Use Readability for proper article extraction
              const { document } = parseHTML(html);
              const reader = new Readability(document);
              const article = reader.parse();
              const content = (article?.textContent || html.replace(/<[^>]+>/g, ' '))
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 8000);
              console.log(`📰 [${clientId}] Extracted article: "${article?.title || 'unknown'}" (${content.length} chars)`);
              const userRequest = cleanText.replace(urlMatch[0], '').trim();
              // Chunk article into ~1500 char pieces for reliable audio generation
              const CHUNK_SIZE = 1500;
              const chunks = [];
              for (let i = 0; i < content.length; i += CHUNK_SIZE) {
                chunks.push(content.slice(i, i + CHUNK_SIZE));
              }
              console.log(`🗣️ [${clientId}] Sending ${content.length} chars in ${chunks.length} chunks to OpenAI`);
              clientWs.send(JSON.stringify({ type: 'system', text: `Reading "${article?.title || 'article'}" (${chunks.length} parts)...` }));
              
              // Store chunks for sequential reading
              if (!clientWs._articleChunks) clientWs._articleChunks = [];
              clientWs._articleChunks = chunks;
              clientWs._articleIdx = 0;
              clientWs._articleTitle = article?.title || 'this article';
              
              // Send first chunk
              const firstPrompt = `${userRequest ? `The user said: "${userRequest}"\n\n` : ''}You are reading the article "${article?.title || 'unknown'}" aloud.\n\nRead this FIRST section word for word, naturally, as if narrating. Do NOT summarize. Read every sentence:\n\n${chunks[0]}${chunks.length > 1 ? '\n\n[Say "continuing..." at the end]' : ''}`;
              if (openaiWs?.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstPrompt }] }
                }));
                openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
                console.log(`✅ [${clientId}] Sent chunk 1/${chunks.length}`);
              } else {
                console.error(`❌ [${clientId}] OpenAI WS not open, can't send`);
              }
            } catch (e) {
              console.error(`❌ [${clientId}] URL fetch error:`, e.message);
              clientWs.send(JSON.stringify({ type: 'system', text: `Failed to fetch URL: ${e.message}` }));
            }
          } else {
            if (openaiWs?.readyState === WebSocket.OPEN) {
              openaiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
              }));
              openaiWs.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
            }
          }
          const project = PROJECT_CONTEXTS[currentProject];
          if (project?.slackChannel) {
            postToSlack(project.slackChannel, `🎙️ ${text}`, { asUser: true });
          }
        })();
      } else if (msg.type === 'switch_project') {
        currentProject = msg.projectId || 'do';
        console.log(`📂 [${clientId}] Switched to project: ${currentProject}`);
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify(buildSessionConfig(currentProject)));
        }
      } else if (msg.type === 'commit') {
        // Commit the audio buffer (manual mode)
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.commit',
          }));
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['text', 'audio'] },
          }));
        }
      }
    } catch (err) {
      console.error(`❌ [${clientId}] Error parsing client message:`, err.message);
    }
  });

  // Cleanup on browser disconnect
  clientWs.on('close', () => {
    console.log(`👋 [${clientId}] Browser disconnected`);
    isClosing = true;
    if (stopPoller) stopPoller();
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error(`❌ [${clientId}] Client WS error:`, err.message);
    isClosing = true;
    if (openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`
🎙️ Voice Chat
━━━━━━━━━━━━━━━━━━━
🌐 http://localhost:${PORT}
🔑 API Key: ${OPENAI_API_KEY.slice(0, 8)}...${OPENAI_API_KEY.slice(-4)}
━━━━━━━━━━━━━━━━━━━
  `);
});
