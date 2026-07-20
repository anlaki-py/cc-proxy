'use strict';

// Clean an Anthropic JSON Schema so it's safe to send to the OpenAI Chat
// Completions endpoint. Two things go wrong otherwise:
//   1. OpenAI rejects `format: "uri"` and the schema-level `strict: true`.
//   2. Anthropic (and Claude Code) mark every parameter as required, which
//      causes OpenAI to reject the call when the model omits an optional
//      argument. We re-derive `required` to only the params that are truly
//      required: present in the original `required`, no default, not nullable,
//      not a boolean (flags are almost always optional), and the description
//      doesn't contain "optional"-style phrases.
function cleanupSchemaForChatCompletions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = JSON.parse(JSON.stringify(schema));
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.format === 'uri') delete node.format;
    delete node.strict;
    if (node.properties && typeof node.properties === 'object') {
      const originalRequired = new Set(Array.isArray(node.required) ? node.required : []);
      const truly = [];
      for (const [name, prop] of Object.entries(node.properties)) {
        if (!originalRequired.has(name)) continue;
        if (typeof prop !== 'object' || !prop) continue;
        if ('default' in prop) continue;
        if (prop.nullable === true) continue;
        if (prop.type === 'boolean') continue;
        const desc = (prop.description || '').toLowerCase();
        if (
          desc.includes('optional') ||
          desc.includes('(optional)') ||
          desc.includes('if not specified') ||
          desc.includes('defaults to') ||
          desc.includes('set to true to') ||
          desc.includes('set to false to') ||
          desc.includes('if provided') ||
          desc.includes('when provided') ||
          desc.includes('can be omitted') ||
          desc.includes('not required') ||
          desc.includes('only provide if')
        )
          continue;
        truly.push(name);
      }
      if (truly.length) node.required = truly;
      else delete node.required;
      for (const v of Object.values(node.properties)) visit(v);
    }
    if (node.items && typeof node.items === 'object') visit(node.items);
  };
  visit(out);
  return out;
}

module.exports = { cleanupSchemaForChatCompletions };
