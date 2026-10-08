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
const claude = new Anthropic();
const CLAUDE_MODEL = 'claude-opus-5-5';
let aiEnabled = true;

const INTERPRET_SYSTEM = `You interpret freeform trackpad drawings for a wearable-AI-glasses research prototype.
The user wears glasses with a small HUD and draws strokes on a wrist trackpad. You receive JSON describing:
- screen: which app screen is showing
- drawing: one or more strokes made in quick succession (a complex drawing - an X, an arrow, a question mark, a letter - spans several strokes; interpret them TOGETHER as one gesture). Each stroke has a shape guess (circle | line-horizontal | line-vertical | line-diagonal | scribble | freeform), closed flag, length and bounding box in the 480x400 HUD; the shape guesses are crude, trust the screenshot over them for multi-stroke drawings
- elements: actionable UI elements (label, machine cmd, and flags: circled / crossed / underlined by the drawing)
- contents: non-interactive display text regions (id, current text, same flags)
A screenshot of the HUD with the glowing drawing on it may also be attached - use it to see the exact shape and placement.

Gestures are either INTERACTIVE (select/activate something) or CORRECTIVE (change how a part is displayed).
Gesture vocabulary (defaults, override with judgment and the screenshot):
- circle around element(s): activate/toggle them; circle around content text: corrective - rewrite it better (simpler, clearer) AND/OR emphasize it
- line through something (crossed=true): cross it out / dismiss / toggle it off (style "strike", or the matching action)
- line under something (underlined=true): emphasize it
- scribble over content: the user dislikes it - rewrite that text differently
- other shapes (arrow, question mark, check): judge from the screenshot; a check often means confirm/next, a question mark means explain (use "say" plus an edit if helpful)

Respond with ONLY compact JSON, no markdown fences:
{"say": "<one short sentence to show the user>",
 "confidence": "high" | "normal",
 "actions": ["<cmd>", ...],
 "edits": [{"target": "<cmd or content id>", "text": "<replacement display text, optional>", "style": "emphasize|dim|strike (optional)"}]}
- actions: for interactive intent; each cmd copied EXACTLY from elements
- edits: for corrective intent; target copied EXACTLY from elements' cmd or contents' id

ALWAYS make your best guess at a concrete action or edit - never return empty actions AND empty edits unless the drawing touches nothing recognizable at all.
confidence "high" = the intent is unmistakable (e.g. a plain circle around one button or checklist item); your actions/edits run immediately and "say" states what you did.
confidence "normal" = everything else; the glasses show your proposal and the user confirms with a flick, so phrase "say" as a short question naming the concrete thing you will do: "Should I simplify this step?", "Cross off the eggs?", "Make the question bigger?".`;

function parseInterpretation(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(text);
    return {
      say: typeof parsed.say === 'string' ? parsed.say : text,
      confidence: parsed.confidence === 'high' ? 'high' : 'normal',
      actions: Array.isArray(parsed.actions) ? parsed.actions.filter(a => typeof a === 'string') : [],
      edits: Array.isArray(parsed.edits)
        ? parsed.edits.filter(e => e && typeof e.target === 'string')
        : [],
    };
  } catch {
    return { say: text.slice(0, 140), confidence: 'normal', actions: [], edits: [] };
  }
}

// Split a payload into {text parts, image} - the screenshot travels as a
// proper image attachment, not inside the JSON.
function splitPayload(payload) {
  const { image, ...rest } = payload || {};
  const m = typeof image === 'string' ? image.match(/^data:(image\/\w+);base64,(.+)$/) : null;
  return { json: JSON.stringify(rest), mediaType: m ? m[1] : null, b64: m ? m[2] : null, dataUrl: m ? image : null };
}

async function interpretWithClaude(payload) {
  const p = splitPayload(payload);
  const content = p.b64
    ? [
        { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.b64 } },
        { type: 'text', text: p.json },
      ]
    : p.json;
  const response = await claude.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 400,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: INTERPRET_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('model declined the request');
  }
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  return parseInterpretation(text);
}

// Alternative backend: OpenAI (set OPENAI_API_KEY; override model with OPENAI_MODEL)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
async function interpretWithOpenAI(payload) {
  const p = splitPayload(payload);
  const userContent = p.dataUrl
    ? [
        { type: 'text', text: p.json },
        { type: 'image_url', image_url: { url: p.dataUrl } },
      ]
    : p.json;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: INTERPRET_SYSTEM },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const err = new Error(`OpenAI HTTP ${res.status}: ${body}`);
    err.fatalAuth = res.status === 401 || res.status === 403;
    throw err;
  }
  const data = await res.json();
  return parseInterpretation(data.choices?.[0]?.message?.content || '');
}

const USE_OPENAI = !!process.env.OPENAI_API_KEY;
function interpretGesture(payload) {
  return USE_OPENAI ? interpretWithOpenAI(payload) : interpretWithClaude(payload);
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
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', // always serve the latest page after a git pull
    });
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
      if (!aiEnabled) {
        sendTo('display', { type: 'assistant', ai: false });
        return;
      }
      const tag = USE_OPENAI ? 'openai' : 'claude';
      interpretGesture(msg.payload || {})
        .then((r) => {
          const editDesc = r.edits.map(e => e.target + (e.text ? '→"' + e.text.slice(0, 40) + '"' : '') + (e.style ? ':' + e.style : '')).join(', ');
          console.log(`[${tag}] (${r.confidence}) "${r.say}" actions=[${r.actions.join(', ')}] edits=[${editDesc}]`);
          sendTo('display', { type: 'assistant', ai: true, say: r.say, confidence: r.confidence, actions: r.actions, edits: r.edits });
          sendTo('trackpad', { type: 'ack', action: r.say, hit: r.actions.length > 0 || r.edits.length > 0 });
        })
        .catch((err) => {
          if (err.fatalAuth ||
              err instanceof Anthropic.AuthenticationError ||
              /authentication method|api key/i.test(err.message || '')) {
            console.log(`[${tag}] invalid or missing API key - falling back to local rules from now on`);
            aiEnabled = false;
          } else if (err instanceof Anthropic.RateLimitError || /HTTP 429/.test(err.message || '')) {
            console.log(`[${tag}] rate limited - using local rules for this gesture`);
          } else {
            console.log(`[${tag}] interpretation failed:`, err.message);
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
  if (USE_OPENAI) {
    console.log(`  Drawing interpretation: OpenAI (${OPENAI_MODEL})`);
  } else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(`  Drawing interpretation: Claude (${CLAUDE_MODEL})`);
  } else {
    console.log('  Drawing interpretation: no OPENAI_API_KEY or ANTHROPIC_API_KEY found - using local circle rules');
  }
  console.log('');
});
