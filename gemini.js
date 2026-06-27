// gemini.js — Gemini API client, JSON-Schema cleaner, and WebMCP→Gemini tool converter.
// ES module, imported by sidepanel.js.

// ── Schema cleaner ──
// Gemini's functionDeclarations accept a restricted (OpenAPI-flavored) subset of
// JSON Schema. WebMCP inputSchemas can carry keys Gemini rejects (e.g. $schema,
// default, examples, additionalProperties, $ref), so we keep the supported set and
// recurse — handling nested objects, arrays, enums, numeric/length constraints,
// union types, and anyOf, so non-trivial provider schemas survive intact.
export function cleanSchemaForGemini(schema) {
  // Booleans-as-schemas degrade to a permissive string.
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'string' };
  // Unresolved $ref (Gemini can't follow refs) → permissive string, keep any description.
  if (schema.$ref && schema.type === undefined && !schema.properties && !schema.anyOf) {
    return schema.description ? { type: 'string', description: schema.description } : { type: 'string' };
  }

  const clean = {};
  // Scalar keywords Gemini supports, copied verbatim.
  const passthrough = [
    'description', 'enum', 'format', 'nullable',
    'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern',
  ];
  for (const key of passthrough) {
    if (key in schema) clean[key] = schema[key];
  }

  // Normalize a union type like ["string","null"] → type:"string" + nullable:true.
  let type = schema.type;
  if (Array.isArray(type)) {
    if (type.includes('null')) clean.nullable = true;
    type = type.find((t) => t !== 'null');
  }
  if (type) clean.type = type;

  if (schema.properties && typeof schema.properties === 'object') {
    clean.type = clean.type || 'object';
    clean.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      clean.properties[k] = cleanSchemaForGemini(v);
    }
  }
  if (Array.isArray(schema.required)) clean.required = schema.required;
  if (schema.items) {
    clean.type = clean.type || 'array';
    clean.items = cleanSchemaForGemini(schema.items);
  }
  if (Array.isArray(schema.anyOf)) {
    clean.anyOf = schema.anyOf.map(cleanSchemaForGemini);
  }

  if (!clean.type && !clean.anyOf) clean.type = 'object';
  return clean;
}

// ── Convert a discovered WebMCP tool → a Gemini function declaration ──
export function webmcpToolToGemini(tool) {
  const decl = {
    name: tool.name,
    description: tool.description || 'No description',
  };
  const params = cleanSchemaForGemini(tool.inputSchema);
  // Gemini rejects a parameters object with an empty `properties` map, so only
  // attach parameters when the tool actually takes some.
  if (params && params.properties && Object.keys(params.properties).length > 0) {
    decl.parameters = params;
  }
  return decl;
}

// ── Argument-key reconciliation ──
// Models sometimes emit a sensible-but-wrong argument name (e.g. `css` when the
// schema's field is `code`), which makes the tool see a missing required value.
// Reconcile generically: keep keys that match the schema, then remap any unknown
// provided keys onto still-missing schema keys (required ones first). No tool- or
// site-specific knowledge — purely schema-driven.
export function reconcileArgs(args, inputSchema) {
  if (!inputSchema || !inputSchema.properties || !args || typeof args !== 'object') return args || {};
  const canonical = Object.keys(inputSchema.properties);
  if (canonical.length === 0) return args;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];

  const result = {};
  const extras = [];
  for (const [k, v] of Object.entries(args)) {
    if (canonical.includes(k)) result[k] = v;
    else extras.push(k);
  }
  if (extras.length === 0) return result; // already clean (unknown junk keys dropped)

  const missing = canonical.filter((k) => !(k in result));
  const targets = [...missing.filter((k) => required.includes(k)), ...missing.filter((k) => !required.includes(k))];
  for (const extra of extras) {
    if (targets.length === 0) break;
    result[targets.shift()] = args[extra];
  }
  return result;
}

// ── Gemini generateContent call ──
export async function callGemini(apiKey, contents, tools = [], model = 'gemini-2.5-flash', systemInstruction = '') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res.json();
}
