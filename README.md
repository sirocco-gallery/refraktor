# WebMCP Agent

A general-purpose Chrome extension that discovers the [WebMCP](https://github.com/webmachinelearning/webmcp)
tools a page registers and lets you drive them from a Gemini-powered chat in the side
panel. Point it at any WebMCP-enabled site; it reads whatever tools that page exposes —
nothing here is hard-coded to one site. Built as the consumer half of the
[sirocco.gallery](https://sirocco.gallery) WebMCP reference implementation.

See live demo here: [sirocco WebMCP provider and consumer loop](https://youtu.be/0D4jC-KZzNs)

## How it works

```
page (MAIN world)        extension
  bridge.js  ──postMessage──▶ content.js ──chrome.runtime──▶ background.js ──▶ side panel
  reads modelContext           (isolated relay)                (message hub)      (chat + Gemini loop)
```

- **bridge.js** runs in the page's JS context and reads the WebMCP consumer surface.
  It feature-detects across surfaces so it's **flag-agnostic**:
  - `document.modelContext.getTools()` / `executeTool()` — production imperative API
  - `navigator.modelContextTesting.listTools()` / `executeTool()` — testing variant
    (what the Model Context Inspector uses)
  - `navigator.modelContext` — older fallback
  It **parses `inputSchema`** (the surfaces return it as a JSON string) so tool
  parameters actually reach the model. Tool results come back as
  `{ content: [{ type: "text", text }] }`.
- **content.js** is the isolated-world relay (it has `chrome.*`; the bridge doesn't).
- **background.js** is the message hub: per-tab tool cache, badge count, panel routing.
- **sidepanel.js** runs the autonomous loop (max 8 tool calls/turn) against Gemini:
  it keeps conversation history across messages (so follow-ups have context),
  reconciles model-invented argument keys against each tool's schema (e.g. `css`→`code`),
  executes each tool on the page, and feeds the result back.

## Install (unpacked)

1. **Enable WebMCP in Chrome (146+).** Either flag works — the extension detects both:
   - `chrome://flags/#enable-experimental-web-platform-features` → exposes the
     production `document.modelContext` imperative API, **or**
   - `chrome://flags/#enable-webmcp-testing` → exposes `navigator.modelContextTesting`.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
   folder you downloaded (the one with `manifest.json` at its root).
3. Click the toolbar icon to open the side panel. Paste a **Gemini API key** (stored
   locally via `chrome.storage`, never sent anywhere but Google). Pick a model in the
   footer dropdown — **2.5 Pro** (default, reliable on multi-argument / special-character
   calls) or **2.5 Flash** (faster). The **⧉** button copies the full transcript
   (calls, args, results) for debugging.

## Try it (against sirocco.gallery)

Visit `https://sirocco.gallery/session`. The badge should show **5**. Then ask:

- "What palettes do you have?" → `list_instruments`
- "Recommend something for a dark financial dashboard" → `recommend_instrument`
- "Check this CSS: `.card { background: #1a1a1a; border-radius: 8px; }` against
  instrument 002" → `check_design_drift`

The agent chains calls on its own and summarizes the result.

## Regenerate icons

```bash
python3 make_icons.py
```

## Constraints (v0.1)

- **BYO Gemini key** — the extension ships no key.
- **General-purpose** — tool names, schemas, and behavior are all discovered at
  runtime; the extension knows nothing site-specific.
- **Chrome flag required** — WebMCP is still behind a flag (see Install).

## Verified

Across two independent providers in Chrome:

- **sirocco.gallery** (5 read-only tools): discovery; no-arg, single-arg, and multi-arg
  calls (`check_design_drift` → named color/radius drift); multi-turn memory.
- **A consultation-booking demo** (second provider): discovery; a read tool
  (`getAvailability`, two typed date args); two **state-mutating action tools**
  (`bookSlot` with four args → confirmation, then `cancelBooking`) — with the model
  carrying a `confirmationId` from one tool's result into the next, and parsing a
  name/email from conversational input.

Confirms the schema/arg-key fixes, non-standard (bare-object) result handling, and
cross-tool memory generalize beyond sirocco.

## Beta scope

**Verified across two providers**: discovery; read + state-mutating action tools;
no/single/multi-arg typed schemas; non-standard (bare-object) results; multi-turn
memory and cross-tool state chaining. **Coded but not yet exercised in the wild**: the
navigation/teardown fallback (the action tools tested return results inline rather than
doing a full-page submit) and multi-block / image / `isError` / `structuredContent`
results. **Still untested**: large tool sets, cross-origin (`fromOrigins`) tools, and
permission-gated tools. Ship as beta accordingly.

## Not in v0.1

Cross-session conversation persistence (in-session memory works), tool pinning,
multi-provider (Claude/OpenAI), Web Store packaging.
