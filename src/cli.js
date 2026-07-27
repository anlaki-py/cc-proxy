'use strict';

// ---------- config / CLI ----------

const { version } = require('../package.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '-b') out.base = argv[++i];
    else if (a === '--key' || a === '-k') out.key = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--model' || a === '-m') out.model = argv[++i];
    else if (a === '--image-fetch') out.imageFetch = true;
    else if (a === '--max-image-bytes') out.maxImageBytes = argv[++i];
    else if (a === '--version' || a === '-v') {
      process.stdout.write(`cc-proxy/${version} node/${process.versions.node}\n`);
      process.exit(0);
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    `Usage: cc-proxy [options]\n\nOptions:\n  -b, --base <url>           OpenAI-compatible base URL (e.g. http://localhost:11434/v1)\n  -k, --key <key>            API key sent as Bearer to upstream\n      --host <address>       IP address to listen on (default: all interfaces)\n  -p, --port <port>          Port to listen on (default 8082); bumped automatically if in use\n  -m, --model <name>         Override the model name in every request\n      --image-fetch          Fetch+base64 re-encode image URL sources server-side\n                             (use when upstream doesn't accept URL image inputs)\n      --max-image-bytes <n>  Max bytes per image when --image-fetch is on (default 20M)\n  -v, --version              Print version and exit\n  -h, --help                 Show this help\n\nWhen -b and -k are both omitted in a terminal, cc-proxy walks you through\ncreating or selecting a saved profile (~/.config/cc-proxy/profiles.json)\nwith arrow-key navigation.\n\nEnv vars: OPENAI_BASE_URL, OPENAI_API_KEY, PORT, MODEL_OVERRIDE,\n          IMAGE_FETCH=1, MAX_IMAGE_BYTES, LOG=1\n`,
  );
}

module.exports = { parseArgs, printHelp, version };
