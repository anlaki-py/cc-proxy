'use strict';

// ---------- config / CLI ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '-b') out.base = argv[++i];
    else if (a === '--key' || a === '-k') out.key = argv[++i];
    else if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--model' || a === '-m') out.model = argv[++i];
    else if (a === '--image-fetch') out.imageFetch = true;
    else if (a === '--max-image-bytes') out.maxImageBytes = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node proxy.js [options]

Options:
  -b, --base <url>           OpenAI-compatible base URL (e.g. http://localhost:11434/v1)
  -k, --key <key>            API key sent as Bearer to upstream
  -p, --port <port>          Port to listen on (default 8082)
  -m, --model <name>         Override the model name in every request
      --image-fetch          Fetch+base64 re-encode image URL sources server-side
                             (use when upstream doesn't accept URL image inputs)
      --max-image-bytes <n>  Max bytes per image when --image-fetch is on (default 20M)
  -h, --help                 Show this help

Env vars: OPENAI_BASE_URL, OPENAI_API_KEY, PORT, MODEL_OVERRIDE,
          IMAGE_FETCH=1, MAX_IMAGE_BYTES, LOG=1
`);
}

module.exports = { parseArgs, printHelp };
