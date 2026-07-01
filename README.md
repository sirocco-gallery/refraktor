# Refraktor

Refraktor is a general-purpose Chrome extension that discovers the [WebMCP](https://github.com/webmachinelearning/webmcp)
tools a page registers and lets you drive them from a Gemini-powered chat in the side
panel. Point it at any WebMCP-enabled site; it reads whatever tools that page exposes —
nothing here is hard-coded to one site. 

[Refraktor](https://chromewebstore.google.com/detail/refraktor/nkafbaaanaamfjdljndmieichdgkhgii) is available via the Chrome Web Store.

## How it works

```
page (MAIN world)        extension
  bridge.js  ──postMessage──▶ content.js ──chrome.runtime──▶ background.js ──▶ side panel
  reads modelContext           (isolated relay)                (message hub)      (chat + Gemini loop)
```


## Try it (against sirocco.gallery)

Visit `https://sirocco.gallery/session`. The badge should show **5**. Then ask:

- "What palettes do you have?" → `list_instruments`
- "Recommend something for a dark financial dashboard" → `recommend_instrument`
- "Check this CSS: `.card { background: #1a1a1a; border-radius: 8px; }` against
  instrument 002" → `check_design_drift`

The agent chains calls on its own and summarizes the result.

## Constraints (v0.1)

- **BYO Gemini key** — the extension ships no key.
- **General-purpose** — tool names, schemas, and behavior are all discovered at
  runtime; the extension knows nothing site-specific.
- **Chrome flag required** — WebMCP is still behind a flag (see Install).
- **`activeTab` by default, not `<all_urls>`** — out of the box the extension only
  touches a page when you click its toolbar icon; it has no standing access to your
  browsing. Trade-off: a navigated page needs another click to re-scan. Flip on
  **"Scan pages automatically"** (optional `<all_urls>` grant) to get auto-scan on every
  page back.

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


