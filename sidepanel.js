// sidepanel.js — chat UI + the Gemini autonomous agent loop.
// Executes tools via the content-script bridge (panel → SW → content → bridge → page).

import { callGemini, webmcpToolToGemini, reconcileArgs } from './gemini.js';
import { textFromResult, resultIsError } from './results.js';

const MAX_LOOPS = 8;
const TOOL_TIMEOUT_MS = 20000;
// 2.5 Pro fills multi-argument / special-character tool calls (e.g. CSS strings)
// far more reliably than Flash; Flash is the fast option. Switchable in the panel.
const DEFAULT_MODEL = 'gemini-2.5-pro';

const els = {
  status: document.getElementById('status'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  messages: document.getElementById('messages'),
  empty: document.getElementById('empty-state'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  apikey: document.getElementById('apikey'),
  model: document.getElementById('model'),
  copy: document.getElementById('copy'),
  refresh: document.getElementById('refresh'),
  activate: document.getElementById('activate'),
  activateAuto: document.getElementById('activate-auto'),
  autoscan: document.getElementById('autoscan'),
};

const ALL_URLS = { origins: ['<all_urls>'] };

const state = {
  tabId: null,
  host: '',
  tools: [],
  apiKey: '',
  model: DEFAULT_MODEL,
  busy: false,
  // Bumped whenever the active tab navigates. Lets an in-flight agent turn notice the
  // page (and its tools) changed underneath it and stop, instead of calling stale tools.
  navGen: 0,
  // True when the active tab hasn't been injected yet — the user must click the
  // toolbar icon (a gesture that grants activeTab) before we can scan or act on it.
  needsActivation: false,
  // True when the optional <all_urls> grant is active — pages scan automatically (v1
  // behaviour), so the per-page activation prompt never applies.
  ambient: false,
  // Rolling Gemini turn history, persisted across messages so follow-ups keep
  // context. Reset when the active page changes (its tools no longer apply).
  conversation: [],
  // Human-readable transcript (you / calls+args / results / agent) for the copy button.
  trace: [],
};

// ── boot ──────────────────────────────────────────────────────────────────
init();

async function init() {
  const stored = await chrome.storage.local.get(['geminiApiKey', 'geminiModel']);
  if (stored.geminiApiKey) {
    state.apiKey = stored.geminiApiKey;
    els.apikey.value = stored.geminiApiKey;
    els.apikey.classList.add('saved');
  }
  if (stored.geminiModel) state.model = stored.geminiModel;
  els.model.value = state.model;

  state.ambient = await chrome.permissions.contains(ALL_URLS).catch(() => false);
  renderAutoscan();
  // Wire listeners BEFORE the first scan so we don't miss the initial TOOLS_UPDATED.
  wireEvents();
  await syncActiveTab();
  renderStatus();
  renderKeyHint();
}

async function syncActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (state.tabId !== null && state.tabId !== tab.id) {
    // Moved to a different page — its tools and context no longer apply, so drop
    // the model's memory to avoid it referencing tools that aren't here anymore.
    state.conversation = [];
  }
  state.tabId = tab.id;
  try {
    state.host = tab.url ? new URL(tab.url).host : '';
  } catch {
    state.host = '';
  }
  // Pull whatever the SW already cached, then ask for a fresh scan. A tab that can't be
  // scanned without a fresh toolbar click (ambient off, not yet injected) needs activation.
  const cached = await chrome.runtime.sendMessage({ type: 'REQUEST_TOOLS', tabId: tab.id }).catch(() => null);
  state.tools = (cached && cached.tools) || [];
  state.needsActivation = !state.ambient && !(cached && cached.scannable) && state.tools.length === 0;
  renderStatus();
  renderActivate();
  renderKeyHint();
  chrome.runtime.sendMessage({ type: 'REFRESH_TOOLS', tabId: tab.id }).catch(() => {});
}

function wireEvents() {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    onSend();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.input.addEventListener('input', autosize);

  els.apikey.addEventListener('input', () => {
    state.apiKey = els.apikey.value.trim();
    renderKeyHint();
  });
  els.apikey.addEventListener('change', async () => {
    state.apiKey = els.apikey.value.trim();
    await chrome.storage.local.set({ geminiApiKey: state.apiKey });
    els.apikey.classList.toggle('saved', !!state.apiKey);
    renderKeyHint();
  });

  els.model.addEventListener('change', async () => {
    state.model = els.model.value;
    await chrome.storage.local.set({ geminiModel: state.model });
  });

  els.refresh.addEventListener('click', () => {
    if (state.tabId != null) chrome.runtime.sendMessage({ type: 'REFRESH_TOOLS', tabId: state.tabId }).catch(() => {});
    els.statusText.textContent = 'Re-scanning…';
  });

  // The banner button and the footer toggle both drive the optional <all_urls> grant.
  // Use the identical call shape for both so neither can behave differently.
  els.activateAuto.addEventListener('click', () => enableAmbient());
  els.autoscan.addEventListener('click', () => (state.ambient ? disableAmbient() : enableAmbient()));

  // Keep ambient state in sync if the permission changes elsewhere (e.g. chrome://extensions).
  chrome.permissions.onAdded.addListener(async () => {
    state.ambient = await chrome.permissions.contains(ALL_URLS).catch(() => false);
    if (state.ambient) state.needsActivation = false;
    renderAutoscan();
    renderActivate();
  });
  chrome.permissions.onRemoved.addListener(async () => {
    state.ambient = await chrome.permissions.contains(ALL_URLS).catch(() => false);
    renderAutoscan();
    renderActivate();
  });

  els.copy.addEventListener('click', async () => {
    const text = state.trace.length ? state.trace.join('\n') : '(nothing yet)';
    try {
      await navigator.clipboard.writeText(text);
      const prev = els.copy.textContent;
      els.copy.textContent = '✓';
      setTimeout(() => { els.copy.textContent = prev; }, 1200);
    } catch {
      els.copy.textContent = '✗';
    }
  });

  // Follow the active tab so the panel always reflects the page in front of you.
  chrome.tabs.onActivated.addListener(syncActiveTab);
  chrome.windows.onFocusChanged.addListener((wid) => {
    if (wid !== chrome.windows.WINDOW_ID_NONE) syncActiveTab();
  });

  // A navigation in the active tab (user- or tool-triggered) tears down its tools and
  // invalidates the model's memory. Abort any in-flight turn and re-discover the new page.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== state.tabId) return;
    if (info.status === 'loading') {
      state.navGen += 1;
      state.tools = [];
      state.conversation = [];
      state.needsActivation = false;
      renderStatus();
      renderActivate();
      renderKeyHint();
    } else if (info.status === 'complete') {
      syncActiveTab(); // re-discover whatever the new page exposes
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'sidepanel') return;
    if (message.type === 'TOOLS_UPDATED' && message.tabId === state.tabId) {
      state.tools = message.tools || [];
      state.needsActivation = false;
      renderStatus();
      renderActivate();
      renderKeyHint();
    } else if (message.type === 'NEEDS_ACTIVATION' && message.tabId === state.tabId) {
      // Ambient mode handles scanning itself; only prompt when it's off.
      if (!state.ambient) {
        state.tools = [];
        state.needsActivation = true;
        renderStatus();
        renderActivate();
      }
    } else if (message.type === 'DISCOVERY_ERROR' && message.tabId === state.tabId) {
      els.statusText.textContent = 'Discovery error';
    }
    // TOOL_RESULT is handled by per-request listeners in executeToolOnPage().
  });
}

// ── ambient (optional <all_urls>) opt-in ────────────────────────────────────
async function enableAmbient() {
  // permissions.request must run in a user gesture — the button click provides it.
  let granted = false;
  try {
    granted = await chrome.permissions.request(ALL_URLS);
  } catch (err) {
    appendError('Could not request the all-sites permission: ' + (err.message || err));
    return;
  }
  if (!granted) {
    // Denied, dismissed, or refused (e.g. no user gesture). Say so instead of silently
    // doing nothing, and point at the per-page fallback.
    appendError(
      'Automatic scanning was not enabled (permission not granted). ' +
        'You can still scan one page at a time with the toolbar icon.',
    );
    return;
  }
  state.ambient = true;
  state.needsActivation = false;
  renderAutoscan();
  renderActivate();
  renderStatus();
  renderKeyHint();
  els.statusText.textContent = 'Scanning…';
  // Nudge a scan of the page you're already on so tools appear immediately.
  if (state.tabId != null) chrome.runtime.sendMessage({ type: 'REFRESH_TOOLS', tabId: state.tabId }).catch(() => {});
  // The permission prompt can blur the panel, so the pushed TOOLS_UPDATED may be missed.
  // Pull the cached result ourselves until it shows up, instead of waiting for a focus change.
  pollForTools(10);
}

// After enabling ambient the first scan can land too early (the just-granted permission
// / freshly-registered content script isn't ready yet), so the cache stays empty and the
// pushed update never comes. Keep re-triggering an actual scan and reading the result
// until tools show up — instead of relying on a single scan or a focus change.
function pollForTools(tries) {
  if (state.tools.length > 0 || state.tabId == null) return;
  if (tries <= 0) {
    renderStatus(); // gave up — don't leave a perpetual "Scanning…"
    return;
  }
  setTimeout(async () => {
    if (state.tabId == null || state.tools.length > 0) return;
    const cached = await chrome.runtime.sendMessage({ type: 'REQUEST_TOOLS', tabId: state.tabId }).catch(() => null);
    if (cached && cached.tools && cached.tools.length) {
      state.tools = cached.tools;
      state.needsActivation = false;
      renderStatus();
      renderActivate();
      renderKeyHint();
      return;
    }
    // Nothing cached yet — re-trigger an actual scan (re-inject + re-discover), then retry.
    chrome.runtime.sendMessage({ type: 'REFRESH_TOOLS', tabId: state.tabId }).catch(() => {});
    pollForTools(tries - 1);
  }, 450);
}

async function disableAmbient() {
  await chrome.permissions.remove(ALL_URLS).catch(() => {});
  state.ambient = await chrome.permissions.contains(ALL_URLS).catch(() => false);
  // Re-evaluate the current tab: with no tools and no ambient, it needs activation again.
  state.needsActivation = !state.ambient && state.tools.length === 0;
  renderAutoscan();
  renderActivate();
  renderStatus();
}

function renderAutoscan() {
  els.autoscan.classList.toggle('on', state.ambient);
  els.autoscan.textContent = state.ambient ? '◉' : '◎';
  els.autoscan.title = state.ambient
    ? 'Automatic scanning: on — click to turn off (revokes all-sites access)'
    : 'Automatic scanning: off — click to scan every site automatically';
}

function renderActivate() {
  // Only when the page genuinely can't be scanned without action: ambient off, not yet
  // scanned, and nothing discovered. Tools present (or ambient on) => never show it.
  els.activate.hidden = !(state.needsActivation && !state.ambient && state.tools.length === 0);
}

// Discovery is independent of the Gemini key — but you can't *chat* without one. When
// tools are ready and no key is set, say so and flag the key field, so it never feels
// like scanning "didn't work."
function renderKeyHint() {
  const n = state.tools.length;
  els.apikey.classList.toggle('needed', n > 0 && !state.apiKey);
  // Only rewrite the empty state while it's still visible (before any chat messages).
  if (!els.empty || els.empty.style.display === 'none') return;
  const p = els.empty.querySelector('p');
  const hint = els.empty.querySelector('.hint');
  if (!p) return;
  if (n > 0 && !state.apiKey) {
    p.textContent = `${n} tool${n === 1 ? '' : 's'} ready on this page.`;
    if (hint) hint.textContent = 'Add your Gemini API key below to start asking.';
  } else if (n > 0) {
    p.textContent = `${n} tool${n === 1 ? '' : 's'} ready — ask away.`;
    if (hint) hint.textContent = "The agent discovers the page's tools and calls them for you.";
  } else {
    p.textContent = 'Open a page that exposes WebMCP tools, then ask for something.';
    if (hint) hint.textContent = "The agent discovers the page's tools and calls them for you.";
  }
}

// ── status ────────────────────────────────────────────────────────────────
function renderStatus() {
  const n = state.tools.length;
  const where = state.host ? ` · ${state.host}` : '';
  if (n > 0) {
    els.statusDot.className = 'dot live';
    els.statusText.textContent = `${n} tool${n === 1 ? '' : 's'}${where}`;
  } else if (state.needsActivation) {
    els.statusDot.className = 'dot none';
    els.statusText.textContent = `Not scanned${where}`;
  } else {
    els.statusDot.className = 'dot none';
    els.statusText.textContent = `No tools${where}`;
  }
}

// ── send / agent loop ───────────────────────────────────────────────────────
async function onSend() {
  if (state.busy) return;
  const text = els.input.value.trim();
  if (!text) return;

  if (!state.apiKey) {
    appendError('Enter your Gemini API key below to start.');
    els.apikey.focus();
    return;
  }

  els.input.value = '';
  autosize();
  appendMessage('user', text);
  state.trace.push('YOU: ' + text);

  if (state.tools.length === 0) {
    appendError(
      state.needsActivation
        ? "This page hasn't been scanned yet. Use “Scan pages automatically” above, or click the Refraktor toolbar icon to scan just this page."
        : 'No WebMCP tools found on this page. Try ↻ to re-scan, or open a page that exposes tools.',
    );
    return;
  }

  setBusy(true);
  const thinking = appendThinking();
  try {
    const reply = await runAgentLoop(text);
    thinking.remove();
    if (reply && reply.trim()) {
      appendMessage('agent', reply);
      state.trace.push('AGENT: ' + reply);
    }
  } catch (err) {
    thinking.remove();
    const msg = err.message || String(err);
    appendError(msg);
    state.trace.push('ERROR: ' + msg);
  } finally {
    setBusy(false);
  }
}

function buildSystemInstruction() {
  const where = state.host ? ` on ${state.host}` : '';
  const list = state.tools.map((t) => `- ${t.name}: ${t.description || ''}`).join('\n');
  return (
    `You are a WebMCP page agent${where}. The page exposes these tools:\n${list}\n\n` +
    `Use them to help the user, chaining calls when it helps. Always pull the concrete ` +
    `values out of the user's message — CSS code, instrument ids, free text — and pass them ` +
    `as the matching tool arguments. Use the exact argument names defined by each tool's input ` +
    `schema — copy the property keys verbatim; never rename, abbreviate, or invent a key. ` +
    `Never call a tool with an empty or missing required field. ` +
    `If a tool returns an error about missing or empty input, call it again with the arguments ` +
    `correctly filled in rather than giving up. After the tools run, give a concise, helpful ` +
    `summary. Do not invent tool results.`
  );
}

async function runAgentLoop(userMessage) {
  const geminiFunctions = state.tools.map(webmcpToolToGemini);
  const systemInstruction = buildSystemInstruction();

  // Append to the persisted history so the model sees prior turns (and its own
  // earlier tool calls / errors) and can self-correct on follow-ups.
  state.conversation.push({ role: 'user', parts: [{ text: userMessage }] });

  // If the page navigates during the turn, the captured tools + history go stale — bail.
  const startGen = state.navGen;
  let loops = 0;
  while (loops < MAX_LOOPS) {
    if (state.navGen !== startGen) { state.conversation = []; return PAGE_CHANGED; }
    const response = await callGemini(state.apiKey, state.conversation, geminiFunctions, state.model, systemInstruction);
    const candidate = response.candidates && response.candidates[0];
    if (!candidate) throw new Error('Gemini returned no candidates.');

    const parts = (candidate.content && candidate.content.parts) || [];
    state.conversation.push({ role: 'model', parts });

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (calls.length === 0) {
      return parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
    }

    loops += 1;
    const responseParts = [];
    let navigated = false;
    for (const fc of calls) {
      const rawArgs = fc.args || {};
      // Fix sensible-but-wrong arg keys (e.g. css→code) against the tool's schema.
      const tool = state.tools.find((t) => t.name === fc.name);
      const callArgs = reconcileArgs(rawArgs, tool && tool.inputSchema);
      if (JSON.stringify(callArgs) !== JSON.stringify(rawArgs)) {
        console.info('[webmcp] reconciled ' + fc.name + ': ' + JSON.stringify(rawArgs) + ' -> ' + JSON.stringify(callArgs));
        state.trace.push('RECONCILED ' + fc.name + ': ' + JSON.stringify(rawArgs) + ' -> ' + JSON.stringify(callArgs));
      }
      // Ground-truth logging — open the panel's DevTools Console, or use the
      // Copy-transcript button, to see exactly what the model sent.
      console.info('[webmcp] call ' + fc.name + ' args: ' + JSON.stringify(callArgs));
      state.trace.push('CALL ' + fc.name + ' args=' + JSON.stringify(callArgs));
      appendToolCall(fc.name, callArgs);
      let resultText;
      let isErr = false;
      try {
        const result = await executeToolOnPage(fc.name, callArgs);
        if (result === NAVIGATION) {
          // A page teardown mid-call (full-page submit/navigate) — stop the turn.
          navigated = true;
          resultText = `“${fc.name}” navigated the page; no value was returned.`;
        } else if (result === null || result === undefined) {
          resultText = '(the tool returned no value)';
        } else {
          resultText = textFromResult(result);
          isErr = resultIsError(result);
        }
      } catch (err) {
        resultText = `Error: ${err.message || String(err)}`;
        isErr = true;
      }
      console.info('[webmcp] result ' + fc.name + ' ' + (isErr ? 'ERROR' : 'ok') + ': ' + resultText);
      state.trace.push('RESULT ' + fc.name + ' ' + (isErr ? 'ERROR' : 'ok') + ': ' + resultText);
      appendToolResult(resultText, isErr);
      responseParts.push({ functionResponse: { name: fc.name, response: { result: resultText } } });
      if (navigated) break; // don't run the rest of the batch against a torn-down page
    }
    // Function results go back under role "user" (the consistently-supported
    // REST shape for Gemini function responses).
    state.conversation.push({ role: 'user', parts: responseParts });
    if (navigated || state.navGen !== startGen) { state.conversation = []; return PAGE_CHANGED; }
  }

  return 'Reached the tool-call limit for one turn. Ask me to continue if you need more.';
}

// Sentinel for "the page navigated away mid-call" — a common outcome for
// side-effecting WebMCP tools (submit, navigate, etc.), distinct from a real error.
const NAVIGATION = Symbol('navigation');
const PAGE_CHANGED =
  'The page navigated, so I stopped here — its tools may have changed. ' +
  'Re-scan if needed, then ask again to continue.';

// Execute one tool on the page, round-tripping through the SW + content bridge.
function executeToolOnPage(toolName, args) {
  return new Promise((resolve, reject) => {
    if (state.tabId == null) return reject(new Error('No active tab.'));
    const requestId = crypto.randomUUID();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onResult);
      chrome.tabs.onUpdated.removeListener(onNav);
    };
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    const timeout = setTimeout(() => finish(reject, new Error('Tool execution timed out.')), TOOL_TIMEOUT_MS);

    const onResult = (message) => {
      if (message && message.target === 'sidepanel' && message.type === 'TOOL_RESULT' && message.requestId === requestId) {
        if (message.error) finish(reject, new Error(message.error));
        else finish(resolve, message.result); // result may be null (navigation)
      }
    };
    // If the target tab starts navigating while the call is in flight, the content
    // script is being torn down and no result will arrive — resolve as navigation
    // rather than hanging until the timeout.
    const onNav = (tabId, info) => {
      if (tabId === state.tabId && info.status === 'loading') finish(resolve, NAVIGATION);
    };

    chrome.runtime.onMessage.addListener(onResult);
    chrome.tabs.onUpdated.addListener(onNav);

    chrome.runtime.sendMessage({
      type: 'EXECUTE_TOOL_REQUEST',
      tabId: state.tabId,
      requestId,
      toolName,
      args,
    });
  });
}

// ── rendering helpers ────────────────────────────────────────────────────────
function hideEmpty() {
  if (els.empty) els.empty.style.display = 'none';
}
function scroll() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function appendMessage(who, text) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = `msg ${who}`;
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'user' ? 'You' : 'Agent';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.append(label, bubble);
  els.messages.appendChild(wrap);
  scroll();
  return wrap;
}

function appendError(text) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg error';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);
  scroll();
}

function appendThinking() {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'thinking';
  el.textContent = 'thinking';
  els.messages.appendChild(el);
  scroll();
  return el;
}

function appendToolCall(name, args) {
  hideEmpty();
  const card = document.createElement('div');
  card.className = 'tool';
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span class="label">call</span><span class="name"></span>`;
  head.querySelector('.name').textContent = name;
  const pre = document.createElement('pre');
  const hasArgs = args && Object.keys(args).length > 0;
  pre.textContent = hasArgs ? JSON.stringify(args, null, 2) : '(no arguments)';
  if (!hasArgs) pre.classList.add('muted');
  card.append(head, pre);
  els.messages.appendChild(card);
  scroll();
}

function appendToolResult(text, isErr) {
  const card = document.createElement('div');
  card.className = `tool ${isErr ? 'err' : ''}`;
  const label = document.createElement('div');
  label.className = 'result-label';
  label.textContent = isErr ? 'error' : 'result';
  const pre = document.createElement('pre');
  pre.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…(truncated)' : text;
  card.append(label, pre);
  els.messages.appendChild(card);
  scroll();
}


// ── misc ──────────────────────────────────────────────────────────────────
function setBusy(b) {
  state.busy = b;
  els.send.disabled = b;
  els.input.disabled = b;
}
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
}
