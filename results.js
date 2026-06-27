// results.js — pure helpers that flatten a WebMCP/MCP tool result into display text.
//
// No DOM and no chrome.* dependencies, so these are unit-testable in isolation (see the
// dev tests). They cover the result shapes the spec allows but that the live providers
// we've tested didn't all exercise: multi-block content, image/audio/resource blocks,
// structuredContent, isError, and bare string/object results.

// Render one content block to text. Handles text, image/audio, resource links, and
// anything else as JSON — so a tool returning richer content still produces something
// sane for both the model (which only sees text) and the transcript.
export function blockToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'image') return `[image${c.mimeType ? ' ' + c.mimeType : ''}]`;
  if (c.type === 'audio') return `[audio${c.mimeType ? ' ' + c.mimeType : ''}]`;
  if (c.type === 'resource' || c.type === 'resource_link') {
    const r = c.resource || c;
    return `[resource${r.uri ? ' ' + r.uri : ''}]`;
  }
  return JSON.stringify(c);
}

// WebMCP/MCP results are usually { content: [...], isError?, structuredContent? }, but
// tools may also return a bare string or object. Flatten any of these to text.
export function textFromResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = [];
  if (Array.isArray(result.content)) {
    const text = result.content.map(blockToText).filter((t) => t !== '').join('\n');
    if (text) parts.push(text);
  }
  if (result.structuredContent !== undefined) {
    parts.push('structuredContent: ' + JSON.stringify(result.structuredContent));
  }
  if (parts.length === 0) return JSON.stringify(result);
  return parts.join('\n');
}

// A tool can signal failure structurally (isError) without throwing.
export function resultIsError(result) {
  return !!(result && typeof result === 'object' && result.isError === true);
}
