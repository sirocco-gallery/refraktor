// content.js — ISOLATED WORLD
// Relay between bridge.js (page / MAIN world, via postMessage) and the extension
// (service worker + side panel, via chrome.runtime).

const MSG_PREFIX = 'webmcp-agent';

// ── Page (bridge.js) → Extension ──
function pageToExtension(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.direction !== MSG_PREFIX) return;
  // Forward to the service worker (which fans out to the side panel).
  chrome.runtime.sendMessage({ source: 'content', ...data }).catch(() => {});
}

// ── Extension → Page (bridge.js) ──
function extensionToPage(message, _sender, sendResponse) {
  if (!message || message.target !== 'content') return;

  if (message.type === 'EXECUTE_TOOL') {
    window.postMessage(
      {
        direction: `${MSG_PREFIX}-command`,
        type: 'EXECUTE_TOOL',
        requestId: message.requestId,
        toolName: message.toolName,
        args: message.args,
      },
      '*',
    );
  } else if (message.type === 'DISCOVER') {
    window.postMessage({ direction: `${MSG_PREFIX}-command`, type: 'DISCOVER' }, '*');
  }

  sendResponse({ status: 'relayed' });
  return true;
}

// Injected on demand; register the relay listeners once even if re-injected (the isolated
// world persists for the document's lifetime, so the guard flag survives re-injection).
if (!window.__webmcpAgentContentLoaded) {
  window.__webmcpAgentContentLoaded = true;
  window.addEventListener('message', pageToExtension);
  chrome.runtime.onMessage.addListener(extensionToPage);
}
