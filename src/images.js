'use strict';

// resolveImageSource turns an Anthropic image block into an OpenAI image_url
// part. Forward-compatible 2nd arg opts { imageFetch, maxImageBytes } lets
// the server pass its config in; the old single-arg form still works (uses
// the legacy module-level IMAGE_FETCH / MAX_IMAGE_BYTES globals as defaults).
//
// The legacy globals are read lazily via the exported setters so the server
// module can override them at boot — keeping the public signature stable.

let IMAGE_FETCH = false;
let MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function configureImages({ imageFetch, maxImageBytes } = {}) {
  if (imageFetch !== undefined) IMAGE_FETCH = !!imageFetch;
  if (maxImageBytes !== undefined) MAX_IMAGE_BYTES = parseInt(maxImageBytes, 10);
}

async function resolveImageSource(source, opts = {}) {
  const imageFetch = opts.imageFetch !== undefined ? opts.imageFetch : IMAGE_FETCH;
  const maxImageBytes = opts.maxImageBytes !== undefined ? opts.maxImageBytes : MAX_IMAGE_BYTES;
  if (!source) throw new Error('image: missing source');
  if (source.type === 'base64') {
    if (!source.media_type || !source.data)
      throw new Error('image: base64 source missing media_type or data');
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  if (source.type === 'url') {
    if (!source.url) throw new Error('image: url source missing url');
    if (!imageFetch) return { type: 'image_url', image_url: { url: source.url } };
    // Server-side fetch + base64 re-encode. Use when the upstream doesn't
    // accept URL image inputs (Ollama, llama.cpp, vLLM with file refs, etc.).
    const r = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`image: fetch ${source.url} returned ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxImageBytes) {
      throw new Error(
        `image: ${buf.length} bytes from ${source.url} exceeds --max-image-bytes (${maxImageBytes})`,
      );
    }
    const ct = r.headers.get('content-type') || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${ct};base64,${buf.toString('base64')}` } };
  }
  if (source.type === 'file') {
    throw new Error('image: file source type (Anthropic Files API) is not supported by this proxy');
  }
  throw new Error(`image: unknown source type: ${source.type}`);
}

module.exports = { resolveImageSource, configureImages };
