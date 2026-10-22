// glasses-trackpad prototype server
// Serves the glasses display page + phone trackpad page, and relays
// gesture messages between them over WebSocket.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

// --- optional Claude-powered gesture interpretation -----------------------
// With an API key (env ANTHROPIC_API_KEY), freeform drawings are sent to
// Claude along with screen context, and Claude decides what the user meant.
// Without one, the display falls back to its built-in circle rules.
const sdkModule = require('@anthropic-ai/sdk');
const Anthropic = sdkModule.Anthropic || sdkModule.default || sdkModule;
const claude = new Anthropic();
const CLAUDE_MODEL = 'claude-opus-5-5';
const PROMPT_VERSION = 19; // bump when INTERPRET_SYSTEM changes
let aiEnabled = true;

const INTERPRET_SYSTEM = `You interpret freeform trackpad drawings for a wearable-AI-glasses research prototype.
The user wears glasses with a small HUD and draws strokes on a wrist trackpad. You receive JSON describing:
- screen: which app screen is showing
- mode: the user's declared drawing intent, chosen on the trackpad:
  "interact" = the drawing is INPUT to the app. FIRST decide from the screenshot whether the drawing is HANDWRITING (letters, words, numbers) or a gesture; drawing.looksLikeWriting is a geometric hint, but the screenshot is the truth.
    If it is handwriting: transcribe it and treat the text as something the user just SAID to you. The circled/crossed/underlined flags are then meaningless artifacts of writing on top of the UI - IGNORE them completely (writing "tools" across the ingredient list is a question about tools, NOT a request to cross off ingredients). Respond to the meaning in the screen's context: a written answer to the on-screen question means they are answering it (check it: if right, say so and use the matching action; if wrong, say the correct answer); "yes"/"no" answers your previous question; any other written word or phrase is a request or query (e.g. "tools" while cooking -> briefly list the tools the recipe needs). For written queries an informative "say" with empty actions is a GOOD response - the act-first rule below applies to gestures, not writing.
    If it is a gesture: select, activate, answer, navigate per the vocabulary below.
  "correct" = the drawing critiques the DISPLAY itself: the marked part is a feature they want changed or explained. Propose changing, rewriting, moving or hiding it (edits), explain it (a "note" edit), or use a matching extraCommand (e.g. circling the quiz topic chip -> offer to switch the quiz to one topic, or to hide the chip with style dim). Do not treat marks as app input in this mode.
- state: the LIVE DATA of the current task (quiz question queue, cooking ingredients/checked/steps, idea cards, translate scenes). This is also your most general tool: your response may include "state" with a partial replacement - any top-level keys you return (quiz / cook / ideate / translate / nav) replace that task's data and the display re-renders. Use it for anything no listed action expresses: change how many quiz questions there are by returning a new queue YOU generate ({topic, cls: "add"|"mult", text, answer}), make the questions harder, add or rename ingredients, reorder or reword steps, rewrite a scene. Keep the shapes identical to what you were shown. Alternatives may each carry their own "state". Prefer a listed action/edit when one fits; with "state" available you should never have to answer "I can't do that".
- extraCommands: additional cmds that are valid in "actions" but have no on-screen element (each with a description). Some are parameterized - a desc like 'quiz:length:<n> accepts any 2-50' means you may construct the cmd with your own number (e.g. the user circles the progress counter: offering a different quiz length is a natural alternative)
- drawing: one or more strokes made in quick succession (a complex drawing - an X, an arrow, a question mark, a letter - spans several strokes; interpret them TOGETHER as one gesture). Each stroke has a shape guess (circle | line-horizontal | line-vertical | line-diagonal | scribble | freeform), closed flag, length and bounding box in the 600x600 HUD; the shape guesses are crude, trust the screenshot over them for multi-stroke drawings
- elements: actionable UI elements (label, machine cmd, and flags: circled / crossed / underlined / touched by the drawing)
- contents: non-interactive display text regions (id, current text, same flags)
  (touched = the stroke made a small mark on it without clearly circling or striking it - treat it like a single-item circle: the user is pointing at it)
A screenshot of the HUD with the glowing drawing on it may also be attached - use it to see the exact shape and placement.

ANCHOR ON THE MARK: respond to what the drawing actually marks - the circled/crossed/underlined/touched flags, and the stroke's position in the screenshot. When no flags are set, drawing.nearest names the closest labeled thing to the stroke - that is almost certainly the subject. NEVER assume the user means the screen's main buttons or options just because they are prominent; the mark's location decides the subject.

Gestures are either INTERACTIVE (select/activate something) or CORRECTIVE (change how a part is displayed).
Gesture vocabulary (defaults, override with judgment and the screenshot):
- CIRCLES: the trackpad already has a TAP for plain selection, so a circle is a richer mark - it means "tell me more about this / do something smart with this", not "click this".
  * ANY circled or touched item(s) - one or several (ingredients, terms, questions, lines, titles): EXPAND on them. For EACH circled item pin an edits "note" (2-3 sentences: what it is, where you'd get it, varieties, a tip, a substitute, why it matters). "say" = one short overall summary, optionally ending with an offer of more (they can write yes or draw again). This is harmless: confidence "high", answer directly. NEVER toggle/check items from a circle and never ask to - checking things off is what TAP is for.
  * the one exception: a plain control button circled (Reveal, Next, Start, Skip) - just activate it.
- NEVER propose removing, hiding or deleting something from a plain circle - removal needs a gesture that says so (a strike-through or scribble over it)
- line through something (crossed=true): cross it out / dismiss / toggle it off (style "strike", or the matching action)
- line under something (underlined=true): emphasize it
- scribble over content: the user dislikes it - rewrite that text differently
- other shapes (arrow, question mark, check): judge from the screenshot; a check often means confirm/next, a question mark means explain (use "say" plus an edit if helpful)

SPECIAL TASK: when the payload has task "photo-translate", the attached image is a photo the user just took with their camera. Read ALL the text you can see in it and translate each distinct piece to Spanish. Respond with the usual JSON shape plus a "lines" field:
{"say": "<one-sentence summary of what the photo shows>", "confidence": "high", "actions": [], "edits": [], "lines": [{"orig": "<text as written>", "es": "<Spanish translation>"}, ...]}
If no text is readable, use "lines": [] and say so.

DIRECTIONS SCREEN (screen "nav"): a turn-by-turn walking-directions task. state.nav = {dest, eta, phase: "pick"|"go"|"arrived", step, steps: [{dir: "left"|"right"|"straight"|"arrive", text, dist}]}. When the user WRITES a place name (handwriting, any screen but especially the "where to?" screen), treat it as their destination: invent a plausible 3-6 step walking route and return state.nav = {dest: "<the place>", eta: <minutes>, phase: "go", step: 0, steps: [...]} - texts under 8 words, dist like "400 ft" or "0.2 mi", last step dir "arrive". Circling the current instruction = explain it or offer a landmark ("say"/note). Writing "faster"/"avoid stairs" or similar = return a reworked steps list.

SPECIAL TASK: when the payload has task "generate-ideas", the user finished a short intake for hackathon brainstorming; payload.answers holds their choices (project type, audience, vibe). Invent exactly 6 DISTINCT hackathon project ideas genuinely tailored to those answers. Respond:
{"say": "<one-line intro referencing their answers>", "confidence": "high", "actions": [], "edits": [],
 "ideas": [{"title": "<2-3 word name>", "tag": "<one-line pitch>", "tags": ["<topic>", "<topic>"], "details": ["<concrete feature>", "<how to demo it live>", "<why judges will like it>"]}, ...]}

Respond with ONLY compact JSON, no markdown fences:
{"say": "<UNDER 10 WORDS - shown on a tiny glasses display AND read aloud>",
 "confidence": "high" | "normal",
 "actions": ["<cmd>", ...],
 "edits": [{"target": "<cmd or content id>", "text": "<replacement display text, optional>", "style": "emphasize|dim|strike (optional)", "note": "<2-3 sentence caption shown under the target, e.g. an explanation (optional)>"}],
 "alternatives": [{"label": "<short reading, a few words>", "actions": [...], "edits": [...]}] (optional, see AMBIGUITY)}
- actions: for interactive intent; each cmd copied EXACTLY from elements
- edits: for corrective intent; target copied EXACTLY from elements' cmd or contents' id

AMBIGUITY: when the drawing has 2-3 genuinely different plausible readings, do NOT guess and do NOT return empty arrays - return "alternatives" (2-3 entries, most likely FIRST), each with a short label and the actions/edits that reading would run, and set "say" to a short question like "Did you mean:". Leave the top-level actions/edits empty in that case. The glasses list the options; the user taps one or flicks right for the first.

For GESTURES, always make your best guess at a concrete action or edit - never return empty actions AND empty edits unless the drawing touches nothing recognizable at all. (Handwritten queries are exempt: answering them in "say" is enough.)
confidence "high" = the intent is unmistakable; your actions/edits run immediately and "say" states what you did.
confidence "normal" = everything else. DEFAULT to returning 2-3 "alternatives" (see AMBIGUITY) so the user picks what they meant - that beats guessing wrong. Use a single yes/no proposal (actions/edits + a question in "say") only when there is exactly one sensible reading.`;

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
            .map(({ target, text, style, note }) => ({ target, text, style, note }))
        : [],
      lines: Array.isArray(parsed.lines)
        ? parsed.lines.filter(l => l && typeof l.orig === 'string' && typeof l.es === 'string')
            .map(({ orig, es }) => ({ orig, es })).slice(0, 25)
        : [],
      ideas: Array.isArray(parsed.ideas)
        ? parsed.ideas.filter(i => i && typeof i.title === 'string')
            .map(({ title, tag, tags, details }) => ({ title, tag, tags, details })).slice(0, 8)
        : [],
      alternatives: Array.isArray(parsed.alternatives)
        ? parsed.alternatives.filter(a => a && typeof a.label === 'string').slice(0, 3)
            .map(a => ({
              label: a.label,
              actions: Array.isArray(a.actions) ? a.actions.filter(x => typeof x === 'string') : [],
              edits: Array.isArray(a.edits)
                ? a.edits.filter(e => e && typeof e.target === 'string')
                    .map(({ target, text, style, note }) => ({ target, text, style, note }))
                : [],
              state: (a.state && typeof a.state === 'object') ? a.state : undefined,
            }))
        : [],
      state: (parsed.state && typeof parsed.state === 'object') ? parsed.state : undefined,
    };
  } catch {
    return { say: text.slice(0, 140), confidence: 'normal', actions: [], edits: [], lines: [], ideas: [], alternatives: [] };
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
    max_tokens: 2000,
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
      max_completion_tokens: 2000,
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
  '/test': 'test.html',
};

const handleRequest = (req, res) => {
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
};

const server = http.createServer(handleRequest);

// --- HTTPS (self-signed) -------------------------------------------------
// iOS only shows the motion-permission prompt (needed for the shake
// gesture) on secure pages, so the trackpad must be served over https.
// A self-signed cert is generated once with openssl and reused.
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
function ensureCert() {
  const dir = path.join(__dirname, '.cert');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '825', '-subj', '/CN=glasses-trackpad'],
        { stdio: 'ignore' });
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch {
    return null; // no openssl - https (and iOS shake) unavailable
  }
}

// --- WebSocket relay ---------------------------------------------------
// Clients identify themselves with {type:"hello", role:"display"|"trackpad"}.
// Messages from trackpads are relayed to displays; "ack" messages from
// displays are relayed back to trackpads. Connection status is broadcast
// to both sides whenever the roster changes.

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

function onConnection(ws) {
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
      const hasImg = !!(msg.payload && msg.payload.image);
      if (!hasImg) console.log(`[${tag}] note: no screenshot attached (html2canvas missing or capture failed)`);
      interpretGesture(msg.payload || {})
        .then((r) => {
          const editDesc = r.edits.map(e => e.target + (e.text ? '→"' + e.text.slice(0, 40) + '"' : '') + (e.style ? ':' + e.style : '')).join(', ');
          console.log(`[${tag}] (${r.confidence}) "${r.say}" actions=[${r.actions.join(', ')}] edits=[${editDesc}]`);
          sendTo('display', { type: 'assistant', ai: true, say: r.say, confidence: r.confidence, actions: r.actions, edits: r.edits, lines: r.lines, ideas: r.ideas, alternatives: r.alternatives, state: r.state });
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
}

new WebSocketServer({ server }).on('connection', onConnection);

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const tlsCreds = ensureCert();
if (tlsCreds) {
  const httpsServer = https.createServer(tlsCreds, handleRequest);
  new WebSocketServer({ server: httpsServer }).on('connection', onConnection);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0');
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIP();
  console.log('');
  console.log('  glasses-trackpad prototype');
  console.log('  ==========================');
  console.log(`  Glasses assistant (laptop): http://localhost:${PORT}/glasses`);
  console.log(`  GitHub mock (laptop):      http://localhost:${PORT}/display`);
  console.log(`  Quiz only (laptop):        http://localhost:${PORT}/quiz`);
  if (tlsCreds) {
    console.log(`  Trackpad (phone, same wifi): https://${ip}:${HTTPS_PORT}/trackpad`);
    console.log('    (accept the certificate warning once - https is what lets iOS ask for motion permission / shake)');
  } else {
    console.log(`  Trackpad (phone, same wifi): http://${ip}:${PORT}/trackpad  (no openssl found - shake won't work on iOS)`);
  }
  console.log(`  Test bench (laptop only):  http://localhost:${PORT}/test`);
  if (USE_OPENAI) {
    console.log(`  Drawing interpretation: OpenAI (${OPENAI_MODEL}) - prompt v${PROMPT_VERSION}`);
  } else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(`  Drawing interpretation: Claude (${CLAUDE_MODEL})`);
  } else {
    console.log('  Drawing interpretation: no OPENAI_API_KEY or ANTHROPIC_API_KEY found - using local circle rules');
  }
  console.log('');
});
