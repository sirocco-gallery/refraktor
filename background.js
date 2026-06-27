// background.js — service worker: action-triggered injection, optional ambient mode,
// message hub, badge, side panel.
//
// Default permissions are minimal: activeTab + scripting, NO host_permissions and NO
// static content scripts. The relay + bridge are injected on demand into the active tab
// when the user clicks the toolbar icon (which grants activeTab for that tab).
//
// Optional ambient mode: from the side panel the user can grant the optional <all_urls>
// host permission ("Scan pages automatically"). When granted, we register dynamic content
// scripts on <all_urls> so every page auto-scans — the original v1 behaviour — but now
// gated behind an explicit, revocable, runtime grant instead of forced at install time.

const AMBIENT_IDS = ['webmcp-relay', 'webmcp-bridge'];
let ambient = false; // whether the optional <all_urls> grant is currently active

// Tabs we've injected into via activeTab (this SW lifetime). The in-page scripts also
// guard against double-init, so a re-injection is harmless.
const injected = new Set();

// Last-known serialized tool set per tab, so a freshly-opened panel can render
// immediately without waiting for a re-discovery round trip.
const tabTools = {};

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId });
  chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#8b6a3a' : '#666', tabId });
}

function toPanel(payload) {
  // The panel may not be open; swallow the "no receiver" rejection.
  chrome.runtime.sendMessage({ target: 'sidepanel', ...payload }).catch(() => {});
}

// Inject the isolated-world relay then the MAIN-world bridge. Requires either activeTab
// (granted by the action click) or the optional <all_urls> grant. Optimistically mark the
// tab injected *before* awaiting so a rapid double-click can't kick off a second inject.
async function injectInto(tabId) {
  injected.add(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['bridge.js'], world: 'MAIN' });
  } catch (err) {
    injected.delete(tabId);
    throw err;
  }
}

function reportInjectError(tabId, err) {
  toPanel({
    type: 'DISCOVERY_ERROR',
    tabId,
    error:
      'Could not access this page (' + ((err && err.message) || err) + '). ' +
      "Some pages (chrome://, the Web Store, the PDF viewer) can't be scanned.",
  });
}

function injectActiveTab() {
  // lastFocusedWindow is more reliable than currentWindow from a service worker, which
  // has no "current" window of its own.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    if (tab && tab.id != null) injectInto(tab.id).catch(() => {});
  });
}

// ── Optional ambient mode (the <all_urls> opt-in) ───────────────────────────
async function registerAmbient() {
  try {
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: AMBIENT_IDS });
    if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map((s) => s.id) });
    await chrome.scripting.registerContentScripts([
      { id: 'webmcp-relay', matches: ['<all_urls>'], js: ['content.js'], runAt: 'document_idle' },
      { id: 'webmcp-bridge', matches: ['<all_urls>'], js: ['bridge.js'], world: 'MAIN', runAt: 'document_idle' },
    ]);
  } catch (err) {
    console.warn('[webmcp] registerAmbient failed', err);
  }
}

async function unregisterAmbient() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: AMBIENT_IDS });
  } catch {
    /* nothing registered */
  }
}

// Reconcile our ambient flag + registration with the actual permission state. Run on
// startup and whenever the permission changes (from the panel toggle or chrome://extensions).
async function syncAmbient() {
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  ambient = has;
  if (has) await registerAmbient();
  else await unregisterAmbient();
}
syncAmbient();

chrome.permissions.onAdded.addListener(async () => {
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (has && !ambient) {
    ambient = true;
    await registerAmbient();
    injectActiveTab(); // make the page already in front of the user work without a reload
  }
});
chrome.permissions.onRemoved.addListener(async () => {
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (!has && ambient) {
    ambient = false;
    await unregisterAmbient();
  }
});

// ── Action click: open the side panel + scan the active tab ──
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  const tabId = tab.id;
  chrome.sidePanel.open({ tabId }).catch(() => {});
  // If a content script is already present (ambient mode or a prior inject) just
  // re-discover; otherwise inject — the click granted activeTab, which covers it.
  chrome.tabs.sendMessage(tabId, { target: 'content', type: 'DISCOVER' }).catch(() => {
    injectInto(tabId).catch((err) => reportInjectError(tabId, err));
  });
});

// Ask a tab to (re)discover, used by the panel's refresh + tab-sync. Unlike the action
// click there's no fresh activeTab grant here, so we can only inject when ambient is on.
function scan(tabId) {
  chrome.tabs.sendMessage(tabId, { target: 'content', type: 'DISCOVER' }).catch(async () => {
    // No content script yet. Inject if we have access — check the permission directly,
    // since the `ambient` flag can lag a just-granted <all_urls> by a tick (which would
    // otherwise drop the scan of the page you're already on right after enabling).
    const canInject = ambient || (await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false));
    if (canInject) injectInto(tabId).catch((err) => reportInjectError(tabId, err));
    else toPanel({ type: 'NEEDS_ACTIVATION', tabId });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  // ── From a content script (has sender.tab) ──
  if (message.source === 'content' && sender.tab) {
    const tabId = sender.tab.id;
    if (message.type === 'TOOLS_DISCOVERED') {
      tabTools[tabId] = message.tools || [];
      setBadge(tabId, tabTools[tabId].length);
      toPanel({ type: 'TOOLS_UPDATED', tools: tabTools[tabId], tabId });
    } else if (message.type === 'NO_CONTEXT') {
      tabTools[tabId] = [];
      setBadge(tabId, 0);
      toPanel({ type: 'TOOLS_UPDATED', tools: [], tabId });
    } else if (message.type === 'ERROR') {
      toPanel({ type: 'DISCOVERY_ERROR', error: message.error, tabId });
    } else if (message.type === 'TOOL_RESULT') {
      toPanel({
        type: 'TOOL_RESULT',
        requestId: message.requestId,
        result: message.result,
        error: message.error,
      });
    }
    return;
  }

  // ── From the side panel ──
  if (message.type === 'REQUEST_TOOLS' && typeof message.tabId === 'number') {
    // "scannable" = we can scan this tab without a fresh toolbar click (ambient on, or
    // we already injected it this session).
    sendResponse({ tools: tabTools[message.tabId] || [], scannable: ambient || injected.has(message.tabId) });
    return true; // keep the channel open for the response
  }

  if (message.type === 'REFRESH_TOOLS' && typeof message.tabId === 'number') {
    scan(message.tabId);
    return;
  }

  if (message.type === 'EXECUTE_TOOL_REQUEST' && typeof message.tabId === 'number') {
    chrome.tabs
      .sendMessage(message.tabId, {
        target: 'content',
        type: 'EXECUTE_TOOL',
        requestId: message.requestId,
        toolName: message.toolName,
        args: message.args,
      })
      .catch(() => {
        injected.delete(message.tabId);
        toPanel({
          type: 'TOOL_RESULT',
          requestId: message.requestId,
          error: 'This page is no longer connected — reload it (or click the toolbar icon) and try again.',
        });
      });
    return;
  }
});

// A navigation tears down injected scripts and revokes activeTab — forget the tab. (In
// ambient mode the registered content scripts re-run on the new page automatically.)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setBadge(tabId, 0);
    delete tabTools[tabId];
    injected.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabTools[tabId];
  injected.delete(tabId);
});
