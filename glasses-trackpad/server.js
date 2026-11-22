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

// --- local .env file (git-ignored) so keys don't have to be typed each run.
// Create glasses-trackpad/.env with lines like ANTHROPIC_API_KEY=sk-ant-...
// Real environment variables still win over the file.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log('[env] loaded .env');
} catch {}

// --- hard spending budget --------------------------------------------------
// Every AI call's token usage is priced and accumulated in .usage.json.
// Once BUDGET_USD is reached the server refuses further AI calls for good.
const BUDGET_USD = Number(process.env.BUDGET_USD || 100);
const USAGE_FILE = path.join(__dirname, '.usage.json');
let spentUSD = 0;
try { spentUSD = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')).spentUSD || 0; } catch {}
// $ per 1M tokens [input, output]; unknown models get a deliberately high
// estimate so the guard errs on the safe side
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20],
  'gpt-4o-mini': [0.15, 0.60], 'gpt-5-mini': [0.25, 2], 'gpt-5.4': [10, 40], 'gpt-5': [10, 40],
};
function recordSpend(model, inTok, outTok) {
  const [pi, po] = PRICES[model] || [5, 25];
  const cost = (inTok * pi + outTok * po) / 1e6;
  spentUSD += cost;
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ spentUSD })); } catch {}
  console.log(`[budget] $${cost.toFixed(4)} this call · $${spentUSD.toFixed(2)} of $${BUDGET_USD} total`);
  if (spentUSD >= BUDGET_USD) console.log('[budget] LIMIT REACHED - AI calls are now disabled');
}
function budgetLeft() {
  return spentUSD < BUDGET_USD;
}

// --- optional Claude-powered gesture interpretation -----------------------
// With an API key (env ANTHROPIC_API_KEY), freeform drawings are sent to
// Claude along with screen context, and Claude decides what the user meant.
// Without one, the display falls back to its built-in circle rules.
const sdkModule = require('@anthropic-ai/sdk');
const Anthropic = sdkModule.Anthropic || sdkModule.default || sdkModule;
const claude = new Anthropic();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const PROMPT_VERSION = 51; // bump when INTERPRET_SYSTEM changes
let aiEnabled = true;

const INTERPRET_SYSTEM = `You interpret freeform trackpad drawings for a wearable-AI-glasses research prototype.
The user wears glasses with a small HUD and draws strokes on a wrist trackpad. You receive JSON describing:
- directive: when present, a BINDING instruction the system computed for this exact input. Follow it to the letter, over every other rule and reading.
- screen: which app screen is showing
- task: one line of plain language saying what the user is DOING right now and where they are in it (e.g. 'Cooking carbonara: gathering ingredients, 2/6 checked'). GROUND EVERYTHING IN THIS: the mark and the words are about this activity, at this point in it - not about the screen as an abstract picture.
- history: the last few exchanges in this session, oldest first, as {user, ai} pairs ('user' = what they drew/said, 'ai' = what you answered). Use it to resolve follow-ups: "yes"/"no" answer YOUR latest question; "it"/"this"/"that one" and a repeated gesture refer to what was just discussed; when the user circles the same thing again, go DEEPER or try a different reading instead of repeating your last answer.
- mode: always "steer" - the pad is in steer mode: the ink (and any spoken words) STEER the task, whether that means driving it forward (select, answer, navigate, confirm) or correcting how something is shown (change, rewrite, explain, restyle a part via edits). Decide from what the mark is on and what would help; both repertoires are always available.
  FIRST decide from the screenshot whether the drawing is HANDWRITING (letters, words, numbers) or a gesture; drawing.looksLikeWriting is a geometric hint, but the screenshot is the truth.
    MARK + WORD COMBINED: the strokes may be BOTH - one stroke that clearly encloses or strikes an item (a loop around a row) PLUS separate strokes forming a short written word next to it. That is one utterance, exactly like speaking while marking: the WORD is the command, the ENCLOSED item is its target ("veg" + a circle on bacon = make THAT ingredient vegetarian - replace it with a vegetarian option via an edit or state; "why" + a circle = explain THAT item; "5" + a circle on the question counter = make it 5 questions). Flags from the letter strokes themselves (letters crossing neighboring rows) are noise - the enclosing loop names the only target. Check for this combination FIRST, before the pure-handwriting rule below.
    CONTEXT CHECKS THE TRANSCRIPTION: handwriting is sloppy, so sanity-check what you read against the task before acting. If your best literal reading fits the context poorly while a close spelling (one letter off) fits naturally ("press" vs "dress" on an event poster, "mead" vs "meat" on a recipe), PREFER the sensible reading - or offer both as named alternatives ("Add a dress code" first, "Something about press" second). Never build your whole answer on a reading that makes no sense in the task.
    If it is ONLY handwriting (no separate enclosing mark): transcribe it and treat the text as something the user just SAID to you. The circled/crossed/underlined flags are then meaningless artifacts of writing on top of the UI - IGNORE them completely (writing "tools" across the ingredient list is a question about tools, NOT a request to cross off ingredients). Respond to the meaning in the screen's context: a written answer to the on-screen question means they are answering it (check it: if right, say so and use the matching action; if wrong, say the correct answer); "yes"/"no" answers your previous question; any other written word or phrase is a request or query (e.g. "tools" while cooking -> briefly list the tools the recipe needs). EXCEPTION - MODIFIER WORDS: a short written word that names a CHANGE to the task ("veg", "vegan", "no pork", "gluten free", "cheaper", "faster", "spicy", "half", "x2") is a COMMAND, not a query: apply it NOW to the obvious target(s) - "veg" while cooking = make the recipe vegetarian: return edits/state swapping every non-vegetarian ingredient (bacon -> mushrooms or smoked tofu) and updating the steps that mention them, confidence "high". Prefer acting over asking; answer informationally only when the word has no sensible application to the task. For other written queries an informative "say" with empty actions is a GOOD response - the act-first rule below applies to gestures, not writing. Written NAVIGATION words ("home", "menu", "back", "exit", "quit") usually mean the matching extraCommand (e.g. "home" = close the task, back to the main menu) - when another reading also makes sense in the task (on directions, "home" could equally be a destination), offer BOTH as alternatives, navigation first. When you ask "did you mean X?", X itself MUST be one of the options.
    LOOPS THAT ENCLOSE NOTHING ARE LETTERS: a closed, circle-shaped stroke that contains NO item's text and sits in line with other letter strokes is a LETTER with a loop (o, e, a, g, d), part of the word - read the whole stroke run as ONE written word using the close-up image and the corner paths ("ve" + a loop = "veg", not "ve" plus a circle). Only a loop that actually contains an item's text counts as a circle on a target.
    INK IN EMPTY SPACE: people write where there is room - usually in the blank area below or beside the content, NOT on top of it. Handwriting floating in empty space (marked empty, nothing enclosed) is STILL about the current task: match the word to the items above it ("veg" written under an ingredient list = make the recipe vegetarian, exactly as if spoken). In that case IGNORE drawing.nearest - a word's meaning decides its target, not whichever button happens to sit closest to the ink. Never answer that there is nothing there.
    If it is a gesture: select, activate, answer, navigate per the vocabulary below - or, when the mark targets how something is DISPLAYED (a setting chip, a wording, a layout element), correct it: change, rewrite, hide (edits), explain it (a "note" edit), or use a matching extraCommand.
- MODIFY requests ("replace A with B", "change A to B", "rename A", "swap A for B", "make A say B"), written or spoken: these change the TEXT of the item - return an edits entry with the item's cmd/id as target and the NEW text (e.g. {"target": "cook:ing:3", "text": "Chicken (150 g)"}), or rewrite it via state. NEVER answer a replace/change/rename request with a plain select/toggle action on the item - checking a box does not change anything's text. If the change ripples (an ingredient appears in cooking steps), update those via state too.
- speech: words the user SPOKE aloud (optional). Treat speech exactly like handwriting: a request, an answer, or a command in the screen's context. When speech arrives alongside a drawing payload (strokes/flags/marked present, or inkOnScreen true), the user SPOKE WHILE MARKING: interpret the words and the mark as ONE utterance - the words usually say WHAT, the mark says WHERE ("what is this" + a circle = explain the circled thing; "swap this for chicken" + a circle on bacon = replace THAT item). The mark binds the words to their target; never answer the words as if the mark were not there.
- state: the LIVE DATA of the current task (quiz question queue, cooking ingredients/checked/steps, idea cards, translate scenes). This is also your most general tool: your response may include "state" with a partial replacement - any top-level keys you return (quiz / cook / ideate / translate / nav / custom) replace that task's data and the display re-renders. Use it for anything no listed action expresses: change how many quiz questions there are by returning a new queue YOU generate ({topic, cls: "add"|"mult", text, answer}), make the questions harder, add or rename ingredients, reorder or reword steps, rewrite a scene. Keep the shapes identical to what you were shown. Alternatives may each carry their own "state". Prefer a listed action/edit when one fits; with "state" available you should never have to answer "I can't do that".
- extraCommands: additional cmds that are valid in "actions" but have no on-screen element (each with a description). Some are parameterized - a desc like 'quiz:length:<n> accepts any 2-50' means you may construct the cmd with your own number (e.g. the user circles the progress counter: offering a different quiz length is a natural alternative)
- drawing: one or more strokes made in quick succession (a complex drawing - an X, an arrow, a question mark, a letter - spans several strokes; interpret them TOGETHER as one gesture). Each stroke has a shape guess (circle | line-horizontal | line-vertical | line-diagonal | scribble | freeform), closed flag, length, bounding box in the 600x600 HUD, and "path": the EdgeWrite-style sequence of its own bounding-box corners the pen visited in order (T/B = top/bottom, L/R = left/right; e.g. an 'L' stroke ~ TL-BL-BR, a 'V' ~ TL-BL-TR, a '7' ~ TL-TR-BL). Corner sequences survive sloppy drawing far better than shapes - for handwriting, read the close-up image and the per-stroke paths TOGETHER to decide the letters; the shape guesses are crude, trust the screenshot over them for multi-stroke drawings
- elements: actionable UI elements (label, machine cmd, and flags: circled / crossed / underlined / touched by the drawing)
- contents: non-interactive display text regions (id, current text, same flags)
  (touched = the stroke made a small mark on it without clearly circling or striking it - treat it like a single-item circle: the user is pointing at it)
A screenshot of the HUD with the glowing drawing on it may also be attached - use it to see the exact shape and placement. When a SECOND image is attached, it is a zoomed CLOSE-UP of the ink region: the ground truth for what exactly sits inside/under the mark and for reading handwriting - trust it over the small full shot.

NEVER WRITE META-TEXT INTO THE CONTENT: the task's content (poster fields, ingredient lists, steps, notes) only ever holds the USER'S OWN material. Never write instructions about this assistant, command lists, usage examples, or explanations of what the user can say or draw into any text field, edit, or note - not even when asked "what can I do". Usage help is SPOKEN: answer it in "say" (under 10 words, e.g. "Circle anything, or speak - I'll change it") and change nothing. A note explains the user's content, never the system.
STAY ON SUBJECT: "marked" lists the labels/ids the ink actually touched - the user's subject is there (or, when marked is empty, at drawing.nearest). Everything you say, do or edit must be about those items. NEVER bring in unmarked items, other list entries, or the screen's prominent buttons; if the subject is unclear, ask about the marked items, not about the screen.

ANCHOR ON THE MARK: respond to what the drawing actually marks - the circled/crossed/underlined/touched flags, and the stroke's position in the screenshot. When no flags are set, drawing.nearest names the closest labeled thing to the stroke - that is almost certainly the subject. NEVER assume the user means the screen's main buttons or options just because they are prominent; the mark's location decides the subject.

Gestures are either INTERACTIVE (select/activate something) or CORRECTIVE (change how a part is displayed).
Gesture vocabulary (defaults, override with judgment and the screenshot):
- CIRCLES: the trackpad already has a TAP for plain selection, so a circle is a richer mark - it means "tell me more about this / do something smart with this", not "click this".
  * a circled or touched item the TASK CAN CHANGE (an ingredient, a step, a checklist entry, a destination): the user wants something DONE with it, not an encyclopedia entry. FIRST check task+history for a constraint that already decides it (they said or wrote they are vegetarian, then circled bacon -> replace it NOW via edits/state, confidence "high", updating any steps that mention it). Otherwise return 2-3 ACTION alternatives on that item, each with its edits/state filled in ("Swap bacon -> mushrooms", "Halve the amount", "Suggest a substitute") - "explain it" may be ONE alternative, always LAST. A purely informational note is the WRONG answer to a lone circle on a changeable item.
  * a circled item with nothing to change (a term, a question's wording, a translation line, a title): EXPAND on it - pin an edits "note" (2-3 sentences: what it is, a tip, why it matters). "say" = one short overall summary. confidence "high". NEVER toggle/check items from a circle and never ask to - checking things off is what TAP is for.
  * the one exception: a plain control button circled (Reveal, Next, Start, Skip) - just activate it.
  * a circled SETTING or STATE indicator (the quiz topic chip, the progress counter, a scene name, a destination) usually means CHANGE THIS: offer the OTHER values it could take as alternatives (circling the topic chip during a multiplication quiz -> switch to addition / mixed topics / a different length). NEVER offer an option that re-applies the current value (e.g. "start multiplication quiz" while already on multiplication) - an option that changes nothing is useless. Explaining what the setting means can be ONE alternative, never the only one.
- NEVER propose removing, hiding or deleting something from a plain circle - removal needs a gesture that says so (a strike-through or scribble over it)
- line through something (crossed=true): cross it out / dismiss / toggle it off (style "strike", or the matching action)
- line under something (underlined=true): emphasize it
- scribble over content: the user dislikes it - rewrite that text differently
- other shapes (arrow, question mark, check): judge from the screenshot; a check often means confirm/next, a question mark means explain (use "say" plus an edit if helpful)

BUILD-FROM-SCRATCH (state.custom): when the user asks for something NO preset covers - spoken or written, from the launcher, the "NEW TASK" screen, or mid-task ("help me stretch for 5 minutes", "plan my morning", "quiz me on Spanish words", "box breathing") - BUILD the task yourself by returning
 "state": {"custom": {"title": "<2-3 words>", "chip": "<short label>", "mode": "steps"|"list", "steps": [{"text": "<one instruction, under 10 words>"}, ...], "items": [{"text": "<item>", "done": false}, ...], "step": 0, "note": "<optional one-liner>"}}
Use "steps" for guided sequences (one per glance, user flicks through; 3-12 steps) and "list" for checklists/options (tappable; up to 12). Glasses rules apply: tiny texts, big ideas. confidence "high", "say" introduces it in under 10 words. You own this task afterwards: marks, writing and speech on it are handled by rewriting state.custom (reorder, extend, check things off, change mode). Prefer a PRESET task (quiz/cook/translate/directions/ideas) when the request clearly matches one - open it with its action or rewrite its state instead.
SETUP QUESTIONS (state.custom mode "ask") - this applies to ANY prompt, not just the examples: when a from-scratch request is complex or underspecified ("design a poster for my project", "plan a weekend trip", "help me prep for my interview"), do NOT build blind - interview the user first, ONE question per turn, 2-3 questions total. And when you are unsure WHAT KIND of result they even want, the FIRST question asks exactly that, with the plausible deliverables as its options ("Want me to make you a poster draft, or walk you through designing one?" -> ["a poster draft", "step-by-step guidance"]; "quiz me on Spanish" could ask ["a quick quiz", "a phrase list"]). Pick the final result's FORM from their answer using EVERYTHING you have: a visual draft (state.poster), a steps/list plan (state.custom), a quiz (state.quiz), a route (state.nav), ideas - the pattern is always the same: ask if unsure -> produce the THING ITSELF, not instructions about it -> their later marks and words tweak it.
 "state": {"custom": {"title": "<2-3 words>", "chip": "<short>", "mode": "ask", "question": "<under 8 words>", "options": ["<under 5 words>", ...], "asked": [<carry forward every earlier {"q", "a"} pair>]}}
2-4 options, each concrete and under 5 words. The glasses number them 1-N and read them aloud; the user answers by tapping one, writing or saying its NUMBER (1-based) or its words, or saying something else entirely - a free answer is just as valid. CRITICAL: when a setup answer reaches you (speech or writing while mode is "ask" - match it against state.custom.options yourself), your reply MUST ITSELF carry the next move: either the NEXT question (mode "ask" again, "asked" extended with the {q, a} just answered) or the FINISHED result. Never reply with only an acknowledgement, an action, or empty state - the screen would hang on the old question. state.custom.asked holds every answer so far: USE them, never re-ask one. After the last question return the finished RESULT tailored to EVERY answer (keep "asked"): a steps/list plan for a doing-task - or, for a DESIGN request, the state.poster draft below, NEVER a checklist of design instructions. Example: "design a poster" -> "What is the poster for?" [my research project, a class, an event] -> "What style?" [clean and minimal, bold and loud, playful] -> then the rendered poster draft via state.poster.
VISUAL DRAFTS (state.poster): when the user asks you to DESIGN anything visual-and-textual (a poster, flyer, cover, title card, invite, sign, menu, title slide), never answer with instructions and NEVER ask setup questions first - immediately show a complete DRAFT ITSELF, inventing sensible placeholder content (title, date, place) they can then tweak; the glasses render it as a live preview, labeled by "kind":
 "state": {"poster": {"kind": "poster|flyer|invite|cover|sign|menu|slide", "title": "<3-6 words, from their answers>", "subtitle": "<under 10 words>", "accent": "#hex", "bg": "#hex", "ink": "<#hex text color, readable on bg>", "sections": [{"head": "<2-3 words>", "body": "<under 12 words>"}, ...2-3...], "footer": "<name / venue / date, short>"}}
Pick colors that fit their stated style and keep text readable on the background. "say" introduces the draft in under 10 words.
TWEAKS to the rendered poster - THE ONE RULE: a mark on any part of the poster names the ASPECT the user wants CORRECTED, and your answer is corrections OF THAT ASPECT. Every part is a contents region (poster-title, poster-subtitle, poster-sec-<i>-head, poster-sec-<i>-body, poster-footer, the color chips poster-accent / poster-bg); the close-up image shows exactly what sits in the loop, down to a single word. With spoken or written words attached, APPLY that correction directly ("fix this color" + a circled chip, "bolder title", "darker background"). With a mark ALONE, offer 2-3 alternatives that are each a concrete DESIGN CHANGE to the circled aspect, carrying its state.poster diff:
 - title or subtitle circled -> reword it (shorter / catchier / different angle), change its prominence, or drop it
 - a section circled -> rewrite its text, merge it with another, split it, or remove it
 - a color chip or any colored element circled -> 2-3 OTHER colors or pairings that fit the stated style (never the current one)
 - a phrase or single word circled inside a region -> change THAT phrase: reword, remove, move it to its own section; a style word ("Bold", "playful", "minimal") -> change that QUALITY of the whole design, first
 - a word WRITTEN on the draft (not circling anything) usually ADDS content: the first alternative adds it to the poster ("dress" -> add a dress code line or section; "food" -> add a food section) - renaming or restyling an existing field from a written noun comes later, if at all
Return "state": {"poster": {<only the fields that change>}} - partial updates merge. NEVER answer a mark on the poster with information, a definition, or an option that restates what is already there; every option must visibly change the draft if picked.

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
  const { image, imageCrop, ...rest } = payload || {};
  const parse = (d) => (typeof d === 'string' ? d.match(/^data:(image\/\w+);base64,(.+)$/) : null);
  const m = parse(image);
  const c = parse(imageCrop);
  return {
    json: JSON.stringify(rest),
    mediaType: m ? m[1] : null, b64: m ? m[2] : null, dataUrl: m ? image : null,
    cropMediaType: c ? c[1] : null, cropB64: c ? c[2] : null, cropDataUrl: c ? imageCrop : null,
  };
}

async function interpretWithClaude(payload) {
  const p = splitPayload(payload);
  const content = p.b64
    ? [
        { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.b64 } },
        ...(p.cropB64 ? [{ type: 'image', source: { type: 'base64', media_type: p.cropMediaType, data: p.cropB64 } }] : []),
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
  if (response.usage) recordSpend(CLAUDE_MODEL, response.usage.input_tokens | 0, response.usage.output_tokens | 0);
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  return parseInterpretation(text);
}

// Alternative backend: OpenAI (set OPENAI_API_KEY; override model with OPENAI_MODEL)
// Best available first: if the key doesn't have a model, step down the chain.
// LOW_COST=1: cheapest capable models + lighter screenshots (set by the glasses)
const LOW_COST = !!process.env.LOW_COST;
const OPENAI_MODELS = [...new Set(
  (LOW_COST
    ? [process.env.OPENAI_MODEL, 'gpt-5-mini', 'gpt-4o-mini']
    : [process.env.OPENAI_MODEL, 'gpt-5.4', 'gpt-5', 'gpt-4o-mini']
  ).filter(Boolean))];
let openaiIdx = 0;
const OPENAI_MODEL = OPENAI_MODELS[0]; // for the startup log
async function interpretWithOpenAI(payload) {
  const p = splitPayload(payload);
  const userContent = p.dataUrl
    ? [
        { type: 'text', text: p.json },
        { type: 'image_url', image_url: { url: p.dataUrl } },
        ...(p.cropDataUrl ? [{ type: 'image_url', image_url: { url: p.cropDataUrl } }] : []),
      ]
    : p.json;
  const res = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: OPENAI_MODELS[openaiIdx],
      // gpt-5 family are reasoning models: keep thinking short so answers
      // come back fast enough for an interactive gesture loop
      ...(OPENAI_MODELS[openaiIdx].startsWith('gpt-5') ? { reasoning_effort: 'low' } : {}),
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
    // unknown model on this key -> step down the chain and retry once per step
    if ((res.status === 400 || res.status === 404) && /model/i.test(body) &&
        openaiIdx < OPENAI_MODELS.length - 1) {
      console.log(`[openai] model "${OPENAI_MODELS[openaiIdx]}" unavailable - switching to "${OPENAI_MODELS[openaiIdx + 1]}"`);
      openaiIdx++;
      return interpretWithOpenAI(payload);
    }
    const err = new Error(`OpenAI HTTP ${res.status}: ${body}`);
    err.fatalAuth = res.status === 401 || res.status === 403;
    throw err;
  }
  const data = await res.json();
  if (data.usage) recordSpend(OPENAI_MODELS[openaiIdx], data.usage.prompt_tokens | 0, data.usage.completion_tokens | 0);
  return parseInterpretation(data.choices?.[0]?.message?.content || '');
}

// Which model family interprets drawings/speech. With both keys present,
// AI_BACKEND=claude|openai picks; otherwise whichever key exists wins.
const USE_OPENAI = process.env.AI_BACKEND
  ? process.env.AI_BACKEND === 'openai'
  : !!process.env.OPENAI_API_KEY;
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

  if (url === '/tts') {
    handleTTS(req, res, new URL(req.url, 'http://x').searchParams);
    return;
  }

  if (url === '/stt' && req.method === 'POST') {
    handleSTT(req, res);
    return;
  }

  if (url === '/') {
    res.writeHead(302, { Location: '/glasses' });
    res.end();
    return;
  }

  // the screenshot library is served locally so captures never depend on a CDN
  if (url === '/html2canvas.min.js') {
    fs.readFile(path.join(PUBLIC_DIR, 'html2canvas.min.js'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('missing'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'max-age=86400' });
      res.end(data);
    });
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

// --- optional ElevenLabs speech output --------------------------------
// With ELEVENLABS_API_KEY set, the glasses fetch natural TTS audio from
// /tts?text=... ; without it they fall back to the browser's voice.
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // "Rachel"
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
async function handleTTS(req, res, query) {
  const text = (query.get('text') || '').slice(0, 300);
  if (!ELEVEN_KEY) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('no ELEVENLABS_API_KEY set');
    return;
  }
  if (!text.trim()) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing text');
    return;
  }
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=mp3_44100_64`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
      },
    );
    if (!r.ok) {
      const msg = await r.text().catch(() => '');
      console.log(`[elevenlabs] HTTP ${r.status}: ${msg.slice(0, 120)}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('tts failed');
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (err) {
    console.log('[elevenlabs] error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('tts failed');
  }
}

// --- speech-to-text: the phone records audio and posts it here; we
// transcribe with the OpenAI key already used for drawing interpretation.
// Transcription models, best first: step down if the key lacks one.
const STT_MODELS = [...new Set([process.env.OPENAI_STT_MODEL, 'gpt-4o-mini-transcribe', 'whisper-1'].filter(Boolean))];
let sttIdx = 0;
function handleSTT(req, res) {
  if (!budgetLeft()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'budget limit reached' }));
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no OPENAI_API_KEY on the server' }));
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks);
      if (!body.length) throw new Error('empty audio');
      const ct = req.headers['content-type'] || 'audio/mp4';
      const ext = ct.includes('webm') ? 'webm' : ct.includes('ogg') ? 'ogg' : ct.includes('wav') ? 'wav' : 'mp4';
      let r, msg = '';
      for (;;) {
        const fd = new FormData();
        fd.append('file', new Blob([body], { type: ct }), 'speech.' + ext);
        fd.append('model', STT_MODELS[sttIdx]);
        fd.append('language', 'en');
        fd.append('prompt', 'Smart-glasses assistant commands, e.g.: design a poster, make it vegetarian, what is this, go home, next step, repeat that, an event, bolder, fix this color.');
        r = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: fd,
        });
        if (r.ok) break;
        msg = await r.text().catch(() => '');
        console.log(`[stt] ${STT_MODELS[sttIdx]} HTTP ${r.status}: ${msg.slice(0, 200)}`);
        if ((r.status === 400 || r.status === 404) && /model/i.test(msg) && sttIdx < STT_MODELS.length - 1) {
          console.log(`[stt] switching to "${STT_MODELS[sttIdx + 1]}"`);
          sttIdx++;
          continue;
        }
        let reason = 'transcription failed';
        try { reason = (JSON.parse(msg).error || {}).message || reason; } catch {}
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(reason).slice(0, 90) }));
        return;
      }
      let j = await r.json();
      // some models return an EMPTY transcript for clips another model hears
      // fine (iPhone mp4 fragments) - retry the same clip once on the next
      // model before reporting silence.
      if (!(j.text || '').trim() && sttIdx < STT_MODELS.length - 1) {
        console.log(`[stt] ${STT_MODELS[sttIdx]} heard nothing - retrying clip on "${STT_MODELS[sttIdx + 1]}"`);
        const fd2 = new FormData();
        fd2.append('file', new Blob([body], { type: ct }), 'speech.' + ext);
        fd2.append('model', STT_MODELS[sttIdx + 1]);
        fd2.append('language', 'en');
        const r2 = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: fd2,
        }).catch(() => null);
        if (r2 && r2.ok) {
          const j2 = await r2.json().catch(() => ({}));
          if ((j2.text || '').trim()) j = j2;
        }
      }
      // Whisper invents filler like "you" / "Hello?" / "Thank you." for
      // near-silent clips - sending those to the interpreter costs money and
      // derails the task. Treat known hallucinations as silence.
      const HALLUCINATIONS = ['you', 'hello', 'hello?', 'hi', 'bye', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching', 'okay', 'oh', 'uh', 'um', 'the', '.'];
      const norm = (j.text || '').trim().toLowerCase().replace(/[.!?,\s]+$/g, '');
      if (norm && HALLUCINATIONS.includes(norm)) {
        console.log(`[stt] "${j.text.trim()}" looks like a silence hallucination - treating as heard-nothing`);
        j = { text: '' };
      }
      // transcription isn't token-priced here: flat, conservative 1c per clip
      spentUSD += 0.01;
      try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ spentUSD })); } catch {}
      console.log(`[budget] $0.0100 this clip · $${spentUSD.toFixed(2)} of $${BUDGET_USD} total`);
      console.log('[stt] heard:', JSON.stringify((j.text || '').slice(0, 80)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: j.text || '' }));
    } catch (err) {
      console.log('[stt] error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'transcription failed' }));
    }
  });
}

// --- HTTPS (self-signed): iPhones only allow microphone access on https,
// so the phone-mic path needs this; the http link keeps working (laptop mic).
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
function ensureCert() {
  const dir = path.join(__dirname, '.cert');
  const ip = lanIP();
  // cert is bound to the current LAN IP (iOS wants a subjectAltName);
  // a new IP (different wifi) just generates a fresh one
  const key = path.join(dir, `key-${ip}.pem`);
  const cert = path.join(dir, `cert-${ip}.pem`);
  try {
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key, '-out', cert, '-days', '825',
        '-subj', `/CN=${ip}`,
        '-addext', `subjectAltName=IP:${ip},DNS:localhost`],
        { stdio: 'ignore' });
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  } catch {
    return null; // no openssl - phone-mic unavailable, laptop mic still works
  }
}

const server = http.createServer(handleRequest);

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
    tts: !!ELEVEN_KEY,
    lowCost: LOW_COST,
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
      // request id: echoed on the reply so the glasses can match replies to
      // requests and drop ones a newer drawing superseded
      const seq = msg.payload && msg.payload.seq;
      if (msg.payload) delete msg.payload.seq;
      if (!budgetLeft()) {
        console.log('[budget] over limit - refusing AI call');
        sendTo('display', { type: 'assistant', ai: false, seq });
        return;
      }
      if (!aiEnabled) {
        sendTo('display', { type: 'assistant', ai: false, seq });
        return;
      }
      // DEMO-CRITICAL: a design request renders a poster draft DETERMINISTICALLY,
      // server-side, with no model call - so it can never loop, ask endless
      // questions, or build the wrong kind of task. The model only handles the
      // tweaks afterward (circling), which is where the value is.
      {
        // DETERMINISTIC POSTER SETUP - fully server-controlled so it can
        // never loop: ask 2 fixed questions, then render. The model is never
        // involved in the setup flow.
        const pl = msg.payload || {};
        const sp = String(pl.speech || '').trim();
        const onPoster = pl.screen === 'poster';
        const cu = (pl.state && pl.state.custom) || {};
        const inSetup = pl.screen === 'custom' && cu.mode === 'ask' && cu.question && /^setup:/.test(cu.title || '');
        const designRe = /\b(design|make|create|build|want)\b.*\b(poster|flyer|invite|invitation|cover|sign|card)\b|\b(poster|flyer|invite|invitation|cover|sign)\b/i;
        const titleCase = (s) => String(s || '').replace(/^\s*(a|an|the|my|our)\s+/i, '').trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);

        // STEP 0 - a design request from home/elsewhere starts the setup
        if (!onPoster && !inSetup && sp && designRe.test(sp)) {
          const kindM = sp.match(/\b(poster|flyer|invite|invitation|cover|sign|card)\b/i);
          const kind = kindM ? kindM[1].toLowerCase().replace('invitation', 'invite') : 'poster';
          console.log(`[interpret] "${sp}" -> start poster setup (Q1)`);
          sendTo('display', { type: 'assistant', ai: true, seq, say: 'What is it for?', confidence: 'high', actions: [], edits: [],
            state: { custom: { title: 'setup:' + kind, chip: kind, mode: 'ask', question: 'What is it for?',
              options: ['A party', 'A job fair', 'A fundraiser'], asked: [] } } });
          sendTo('trackpad', { type: 'ack', action: 'setup', hit: true });
          return;
        }
        // STEP 1 / 2 - an answer while in setup
        if (inSetup) {
          const kind = (cu.chip || 'poster');
          const asked = Array.isArray(cu.asked) ? cu.asked.slice() : [];
          const answer = sp || 'it'; // handwriting answers arrive without text
          if (asked.length === 0) {
            // answered Q1 (what it's for) -> ask Q2 (style)
            console.log(`[interpret] setup Q1 answered "${answer}" -> Q2 (style)`);
            sendTo('display', { type: 'assistant', ai: true, seq, say: 'What style?', confidence: 'high', actions: [], edits: [],
              state: { custom: { title: 'setup:' + kind, chip: kind, mode: 'ask', question: 'What style?',
                options: ['Bold', 'Minimal', 'Playful'], asked: [{ q: 'What is it for?', a: answer }] } } });
            sendTo('trackpad', { type: 'ack', action: 'style?', hit: true });
            return;
          }
          // answered Q2 (style) -> RENDER the poster from both answers
          const topic = asked[0] && asked[0].a || '';
          const title = titleCase(topic) || 'Your Event';
          const style = answer.toLowerCase();
          const theme = /bold/.test(style) ? { accent: '#FF3B5C', bg: '#0C1020', ink: '#FFFFFF', sub: 'Big night. Be there.' }
            : /minimal/.test(style) ? { accent: '#3B4252', bg: '#FAFAF5', ink: '#1A1A1A', sub: 'Simple. Clear. Done.' }
            : /playful/.test(style) ? { accent: '#FF7AC6', bg: '#FFF3E0', ink: '#1C2130', sub: 'Come have some fun!' }
            : { accent: '#FF4D6D', bg: '#101826', ink: '#F2F5F9', sub: 'A can’t-miss event' };
          const poster = { kind, title, subtitle: theme.sub, accent: theme.accent, bg: theme.bg, ink: theme.ink,
            sections: [ { head: 'When', body: 'Sat, June 12 · 3 PM' }, { head: 'Where', body: 'Main Hall' }, { head: 'Bring', body: 'Friends — and good energy' } ],
            footer: 'Free · all welcome' };
          console.log(`[interpret] setup Q2 answered "${answer}" -> RENDER ${kind} "${title}" (${style})`);
          sendTo('display', { type: 'assistant', ai: true, seq, say: 'Here is your ' + kind, confidence: 'high', actions: [], edits: [], state: { poster } });
          sendTo('trackpad', { type: 'ack', action: 'drafted a ' + kind, hit: true });
          return;
        }
      }
      const tag = USE_OPENAI ? 'openai' : 'claude';
      const hasImg = !!(msg.payload && msg.payload.image);
      if (!hasImg) console.log(`[${tag}] note: no screenshot attached (html2canvas missing or capture failed)`);
      // show what the geometry decided the user marked - the first place to
      // look when a circle "wasn't understood"
      {
        const pl = msg.payload || {};
        const bits = [`screen=${pl.screen}`];
        if (Array.isArray(pl.marked) && pl.marked.length) bits.push(`marked=[${pl.marked.join(' | ')}]`);
        else if (pl.drawing && pl.drawing.nearest) bits.push(`marked=NONE nearest="${pl.drawing.nearest.label}"`);
        if (pl.speech) bits.push(`speech="${pl.speech}"`);
        if (pl.imageCrop) bits.push('crop=yes');
        console.log(`[interpret] ${bits.join(' ')}`);
      }
      // Poster marks are the demo-critical path: compute a binding directive
      // so the model cannot wander off into info-mode or the wrong target.
      {
        const pl = msg.payload || {};
        // DETERMINISTIC TIME OPTIONS: circling the When/time section (no speech)
        // always offers specific earlier/later times parsed from the current
        // one - never leaves it to the model.
        if (pl.screen === 'poster' && !pl.speech && Array.isArray(pl.marked) && pl.marked.length) {
          const secs = (pl.state && pl.state.poster && Array.isArray(pl.state.poster.sections)) ? pl.state.poster.sections : [];
          const secM = pl.marked.join(' ').match(/poster-sec-(\d+)/);
          const idx = secM ? +secM[1] : -1;
          const sec = idx >= 0 ? secs[idx] : null;
          const tM = sec && String(sec.body).match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
          if (sec && /when|date|time/i.test(sec.head) && tM) {
            let h = +tM[1] % 12; if (/pm/i.test(tM[3])) h += 12; // 24h
            const datePart = String(sec.body).replace(/[·|-]?\s*\d{1,2}(?::\d{2})?\s*(AM|PM).*$/i, '').replace(/[·|,\s]+$/, '').trim();
            const fmt = (hh) => { const ap = hh >= 12 ? 'PM' : 'AM'; let d = hh % 12; if (d === 0) d = 12; return d + ' ' + ap; };
            const mk = (hh, label) => ({ label: label + ' — ' + fmt(hh), state: { poster: { sections: secs.map((s, i) => i === idx ? { head: s.head, body: (datePart ? datePart + ' · ' : '') + fmt(hh) } : { head: s.head, body: s.body }) } } });
            const earlier = Math.max(8, h - 3), later1 = Math.min(21, h + 2), later2 = Math.min(22, h + 4);
            const alts = [ mk(earlier, 'Earlier'), mk(later1, 'Later'), mk(later2, 'Even later') ];
            console.log(`[${tag}] circle on time "${sec.body}" -> deterministic time options`);
            sendTo('display', { type: 'assistant', ai: true, seq, say: 'Did you mean:', confidence: 'normal', actions: [], edits: [], alternatives: alts });
            sendTo('trackpad', { type: 'ack', action: 'time options', hit: true });
            return;
          }
        }
        if (pl.screen === 'poster' && Array.isArray(pl.marked) && pl.marked.length) {
          const parts = pl.marked.join(', ');
          pl.directive = pl.speech
            ? `The user marked [${parts}] on their poster draft and said "${pl.speech}". Apply exactly that change to exactly those part(s) NOW, via "state": {"poster": {...partial diff...}}, confidence "high", "say" naming what changed. No questions, no information.`
            : `The user circled [${parts}] on their poster draft. They want that aspect CHANGED. Reply with "say": "Did you mean:" and 2-3 "alternatives", each a DIFFERENT concrete design change to exactly [${parts}] (reword it / change its value / change its color or prominence / remove it), and EACH alternative MUST carry its own "state": {"poster": {...partial diff...}} so picking it visibly changes the draft. No information, no definitions, no option that keeps things as they are.`;
        }
        // THE SETUP LOOP BUG: when the user ANSWERS a setup question, the
        // model must ADVANCE - record the answer and ask the NEXT (different)
        // question, or produce the result. It must never repeat a question.
        const cu = (pl.state && pl.state.custom) || {};
        const answering = cu.mode === 'ask' && cu.question &&
          (pl.speech || (pl.drawing && pl.drawing.strokes && pl.drawing.strokes.length) || pl.marked);
        if (answering) {
          const asked = Array.isArray(cu.asked) ? cu.asked.map((a) => a && a.q).filter(Boolean) : [];
          const theAnswer = pl.speech ? `"${pl.speech}"` : 'the handwriting shown in the image';
          // client counts answers independently, so a model that never grows
          // asked[] still terminates
          const nAnswered = Math.max(asked.length + 1, pl.setupAnswers || 1);
          pl.directive = nAnswered >= 2
            ? `The user is in poster setup. The current question is "${cu.question}" and their answer is ${theAnswer}. They have now answered enough. PRODUCE THE POSTER DRAFT NOW as "state": {"poster": {"kind":"poster","title":"<from their answers>","subtitle":"<short>","accent":"#hex","bg":"#hex","ink":"#hex","sections":[{"head":"When","body":"<placeholder>"},{"head":"Where","body":"<placeholder>"},{"head":"Bring","body":"<placeholder>"}],"footer":"<short>"}}, confidence "high", "say" under 8 words. DO NOT ask another question. DO NOT return mode "ask". DO NOT repeat "${cu.question}".`
            : `The user is in poster setup. The current question is "${cu.question}" and their answer is ${theAnswer}. RECORD this answer, then ask ONE DIFFERENT next question via "state": {"custom": {"mode":"ask","question":"<a NEW question, not '${cu.question}' and not any of ${JSON.stringify(asked)}>","options":["<opt>","<opt>","<opt>"],"asked":[<every prior {q,a} PLUS {"q":"${cu.question}","a":<their answer>}>]}}. You MUST move to a different question - NEVER return "${cu.question}" again, NEVER return empty state.`;
        }
      }
      interpretGesture(msg.payload || {})
        .then((r) => {
          // SAFETY NET for poster circles: if the model returned nothing
          // useful for a circle on a poster region, synthesize a working
          // options menu server-side so the gesture is never a dead end.
          const pl = msg.payload || {};
          const noResult = (!r.alternatives || r.alternatives.length < 2) &&
            (!r.actions || !r.actions.length) && (!r.edits || !r.edits.length) && !r.state;
          if (pl.screen === 'poster' && Array.isArray(pl.marked) && pl.marked.length && !pl.speech && noResult) {
            const m = pl.marked.join(' ');
            const curSecs = (pl.state && pl.state.poster && Array.isArray(pl.state.poster.sections)) ? pl.state.poster.sections : [];
            // rebuild the sections array with ONE section's body replaced
            const withSec = (idx, body) => ({ poster: { sections: curSecs.map((s, i) => i === idx ? { head: s.head, body } : { head: s.head, body: s.body }) } });
            const secM = m.match(/poster-sec-(\d+)/);
            let alts;
            if (/accent|bg|color/i.test(m)) {
              alts = [
                { label: 'Cool blue', state: { poster: { accent: '#2E6FDB' } } },
                { label: 'Warm orange', state: { poster: { accent: '#E8734C' } } },
                { label: 'Deep green', state: { poster: { accent: '#2F8F5B' } } },
              ];
            } else if (/title/i.test(m)) {
              alts = [
                { label: 'Punchier title', state: { poster: { title: 'Don’t Miss It' } } },
                { label: 'Add a subtitle', state: { poster: { subtitle: 'You’re invited' } } },
              ];
            } else if (secM && curSecs.length) {
              const idx = +secM[1];
              const head = (curSecs[idx] && curSecs[idx].head || '').toLowerCase();
              if (/when|date|time/.test(head)) {
                alts = [
                  { label: 'Change to 7 PM', state: withSec(idx, 'Sat, June 12 · 7 PM') },
                  { label: 'Make it a time range', state: withSec(idx, 'Sat, June 12 · 3–7 PM') },
                  { label: 'Move to next weekend', state: withSec(idx, 'Sat, June 19 · 3 PM') },
                ];
              } else if (/where|place|location/.test(head)) {
                alts = [
                  { label: 'Change the venue', state: withSec(idx, 'Rooftop Terrace') },
                  { label: 'Add an address', state: withSec(idx, 'Main Hall, 100 Center St') },
                  { label: 'Make it online', state: withSec(idx, 'Online — link to follow') },
                ];
              } else {
                alts = [
                  { label: 'Reword this', state: withSec(idx, 'Updated details') },
                  { label: 'Shorten it', state: withSec(idx, (curSecs[idx].body || '').split(/[,·—-]/)[0].trim() || 'Details') },
                  { label: 'Remove this line', state: { poster: { sections: curSecs.filter((_, i) => i !== idx) } } },
                ];
              }
            } else {
              alts = [
                { label: 'Make this bolder', state: { poster: { accent: '#FF4D6D' } } },
                { label: 'Soften the look', state: { poster: { accent: '#6C8EBF', bg: '#1A2230' } } },
                { label: 'Brighten background', state: { poster: { bg: '#15203A' } } },
              ];
            }
            console.log(`[${tag}] circle produced no model result - using deterministic fallback menu for [${m}]`);
            r = { say: 'Did you mean:', confidence: 'normal', actions: [], edits: [], lines: [], ideas: [], alternatives: alts, state: undefined };
          }
          const editDesc = r.edits.map(e => e.target + (e.text ? '→"' + e.text.slice(0, 40) + '"' : '') + (e.style ? ':' + e.style : '')).join(', ');
          console.log(`[${tag}] (${r.confidence}) "${r.say}" actions=[${r.actions.join(', ')}] edits=[${editDesc}]`);
          sendTo('display', { type: 'assistant', ai: true, seq, say: r.say, confidence: r.confidence, actions: r.actions, edits: r.edits, lines: r.lines, ideas: r.ideas, alternatives: r.alternatives, state: r.state });
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
          sendTo('display', { type: 'assistant', ai: false, seq });
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
    console.log('    (accept the certificate warning once; https lets the PHONE mic record your voice)');
    console.log(`    plain fallback (laptop mic): http://${ip}:${PORT}/trackpad`);
  } else {
    console.log(`  Trackpad (phone, same wifi): http://${ip}:${PORT}/trackpad  (no openssl - voice uses the laptop mic)`);
  }
  console.log(`  Test bench (laptop only):  http://localhost:${PORT}/test`);
  console.log(`  Budget: $${spentUSD.toFixed(2)} spent of $${BUDGET_USD} cap${spentUSD >= BUDGET_USD ? ' - AI DISABLED' : ''}`);
  console.log(ELEVEN_KEY
    ? '  Speech output: ElevenLabs'
    : '  Speech output: browser voice (set ELEVENLABS_API_KEY for a natural one)');
  if (USE_OPENAI) {
    console.log(`  Drawing interpretation: OpenAI (${OPENAI_MODEL}) - prompt v${PROMPT_VERSION}${LOW_COST ? ' - LOW COST mode' : ''}`);
  } else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(`  Drawing interpretation: Claude (${CLAUDE_MODEL})`);
  } else {
    console.log('  Drawing interpretation: no OPENAI_API_KEY or ANTHROPIC_API_KEY found - using local circle rules');
  }
  console.log('');
});
