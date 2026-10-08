// glasses-trackpad prototype server
// Serves the glasses display page + phone trackpad page, and relays
// gesture messages between them over WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

// --- optional Claude-powered gesture interpretation -----------------------
// With an API key (env ANTHROPIC_API_KEY), freeform drawings are sent to
// Claude along with screen context, and Claude decides what the user meant.
// Without one, the display falls back to its built-in circle rules.
const sdkModule = require('@anthropic-ai/sdk');
const Anthropic = sdkModule.Anthropic || sdkModule.default || sdkModule;
let claude = new Anthropic();
const CLAUDE_MODEL = 'claude-opus-5-5';

const INTERPRET_SYSTEM = `You interpret freeform trackpad drawings for a wearable-AI-glasses research prototype.
The user wears glasses with a small HUD and draws strokes on a wrist trackpad. You receive JSON describing:
- screen: which app screen is showing
- stroke: geometry summary (closed loop or open stroke, length, bounding box in the 480x400 HUD)
- elements: the actionable UI elements, each with its label, its machine cmd, and circled=true if the stroke enclosed it

Infer the user's intent. Respond with ONLY compact JSON, no markdown fences:
{"say": "<one short friendly sentence to show the user>", "actions": ["<cmd>", ...]}
Each action must be a cmd copied EXACTLY from the elements list; use [] when no action is clearly intended.
Rules of thumb: a loop around elements usually means select/activate them; a loop around several checklist items means toggle them all; an open stroke through or under an element may mean emphasis or dismissal - use judgment; if intent is ambiguous, return [] and ask a brief clarifying question in "say".`;

async function interpretGesture(payload) {
  const response = await claude.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: INTERPRET_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('model declined the request');
  }
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    return {
      say: typeof parsed.say === 'string' ? parsed.say : text,
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter(a => typeof a === 'string') : [],
    };
  } catch {
    return { say: text.slice(0, 140), actions: [] };
  }
}

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROUTES = {
  '/glasses': 'glasses.html',
  '/display': 'display.html',
  '/trackpad': 'trackpad.html',
  '/quiz': 'quiz.html',
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/') {
    res.writeHead(302, { Location: '/glasses' });
    res.end();
    return;
  }

  const file = ROUTES[url];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Try /display, /quiz or /trackpad');
    return;
  }

  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading ' + file);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// --- WebSocket relay ---------------------------------------------------
// Clients identify themselves with {type:"hello", role:"display"|"trackpad"}.
// Messages from trackpads are relayed to displays; "ack" messages from
// displays are relayed back to trackpads. Connection status is broadcast
// to both sides whenever the roster changes.

const wss = new WebSocketServer({ server });
const clients = new Set(); // { ws, role }

function countRole(role) {
  let n = 0;
  for (const c of clients) if (c.role === role) n++;
  return n;
}

function sendTo(role, msg) {
  const raw = JSON.stringify(msg);
  for (const c of clients) {
    if (c.role === role && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(raw);
    }
  }
}

function broadcastStatus() {
  const status = {
    type: 'status',
    displays: countRole('display'),
    trackpads: countRole('trackpad'),
  };
  sendTo('display', status);
  sendTo('trackpad', status);
}

wss.on('connection', (ws) => {
  const client = { ws, role: null };
  clients.add(client);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      client.role = msg.role === 'display' ? 'display' : 'trackpad';
      console.log(`[ws] ${client.role} connected (displays=${countRole('display')}, trackpads=${countRole('trackpad')})`);
      broadcastStatus();
      return;
    }

    // Displays ask the server to interpret a drawing with Claude.
    if (client.role === 'display' && msg.type === 'interpret') {
      if (!claude) {
        sendTo('display', { type: 'assistant', ai: false });
        return;
      }
      interpretGesture(msg.payload || {})
        .then((r) => {
          console.log(`[claude] "${r.say}" actions=[${r.actions.join(', ')}]`);
          sendTo('display', { type: 'assistant', ai: true, say: r.say, actions: r.actions });
          sendTo('trackpad', { type: 'ack', action: r.say, hit: r.actions.length > 0 });
        })
        .catch((err) => {
          if (err instanceof Anthropic.AuthenticationError ||
              /authentication method|api key/i.test(err.message || '')) {
            console.log('[claude] invalid or missing API key - falling back to local rules from now on');
            claude = null;
          } else if (err instanceof Anthropic.RateLimitError) {
            console.log('[claude] rate limited - using local rules for this gesture');
          } else {
            console.log('[claude] interpretation failed:', err.message);
          }
          sendTo('display', { type: 'assistant', ai: false });
        });
      return;
    }

    // Relay gestures from trackpads to displays, acks from displays back.
    if (client.role === 'trackpad') {
      sendTo('display', msg);
    } else if (client.role === 'display' && msg.type === 'ack') {
      sendTo('trackpad', msg);
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    if (client.role) {
      console.log(`[ws] ${client.role} disconnected`);
      broadcastStatus();
    }
  });

  ws.on('error', () => {});
});

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIP();
  console.log('');
  console.log('  glasses-trackpad prototype');
  console.log('  ==========================');
  console.log(`  Glasses assistant (laptop): http://localhost:${PORT}/glasses`);
  console.log(`  GitHub mock (laptop):      http://localhost:${PORT}/display`);
  console.log(`  Quiz only (laptop):        http://localhost:${PORT}/quiz`);
  console.log(`  Trackpad (phone, same wifi): http://${ip}:${PORT}/trackpad`);
  const hasCreds = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  console.log(hasCreds
    ? `  Claude drawing interpretation: ON (${CLAUDE_MODEL})`
    : '  Claude drawing interpretation: no ANTHROPIC_API_KEY found - will try anyway, falls back to local circle rules');
  console.log('');
});
