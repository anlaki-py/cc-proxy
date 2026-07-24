'use strict';

// ---------- saved upstream profiles (interactive when -b/-k omitted) ----------
//
// Profiles live at ~/.config/cc-proxy/profiles.json so the same set is
// available regardless of cwd. Keys are stored in plain text on purpose:
// this is a local CLI convenience, not a secrets manager. Pass -b/-k (or
// set env vars in non-TTY) if you do not want credentials on disk.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const DEFAULT_BASE = 'http://localhost:11434/v1';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'cc-proxy');
const PROFILES_FILE = path.join(CONFIG_DIR, 'profiles.json');
// Pre-migration location (v1); still read once if the new path is empty.
const LEGACY_PROFILES_FILE = path.join(os.homedir(), '.cc-proxy', 'profiles.json');

const CREATE_LABEL = 'Create new profile';

function defaultStore() {
  return { profiles: {}, lastUsed: null };
}

function parseStoreJson(raw) {
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object') return defaultStore();
  const profiles = j.profiles && typeof j.profiles === 'object' ? j.profiles : {};
  const cleaned = {};
  for (const [name, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.base !== 'string' || !p.base.trim()) continue;
    cleaned[name] = {
      base: String(p.base).replace(/\/$/, ''),
      key: typeof p.key === 'string' ? p.key : '',
    };
  }
  const lastUsed = typeof j.lastUsed === 'string' && cleaned[j.lastUsed] ? j.lastUsed : null;
  return { profiles: cleaned, lastUsed };
}

function loadStore(filePath = PROFILES_FILE) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseStoreJson(raw);
  } catch {
    // fall through
  }

  // One-time migrate from ~/.cc-proxy/profiles.json when loading the
  // default path and the new file is missing.
  if (filePath === PROFILES_FILE) {
    try {
      const raw = fs.readFileSync(LEGACY_PROFILES_FILE, 'utf8');
      const store = parseStoreJson(raw);
      if (Object.keys(store.profiles).length > 0) {
        saveStore(store, PROFILES_FILE);
        process.stdout.write(
          `[profiles] migrated ${Object.keys(store.profiles).length} profile(s) to ~/.config/cc-proxy/\n`,
        );
        return store;
      }
    } catch {
      // no legacy file
    }
  }

  return defaultStore();
}

function saveStore(store, filePath = PROFILES_FILE) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  const payload = {
    profiles: store.profiles,
    lastUsed: store.lastUsed,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore mode; best-effort.
  }
}

function listProfileNames(store) {
  return Object.keys(store.profiles).sort((a, b) => a.localeCompare(b));
}

function isInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

function sanitizeName(raw) {
  return String(raw || '')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, '-');
}

function profileMenuItems(names, store) {
  const items = names.map((name) => {
    const p = store.profiles[name];
    const mark = name === store.lastUsed ? ' (last used)' : '';
    return `${name}  ${p.base}${mark}`;
  });
  items.push(CREATE_LABEL);
  return items;
}

/**
 * Arrow-key list picker. ↑/↓ move, Enter confirms, Ctrl+C aborts.
 * `items` is an array of display strings; returns the selected index.
 *
 * Inject `chooseIndex` in tests, or pass a custom `readKey` that yields
 * 'up' | 'down' | 'enter' | 'abort' for scripted selection.
 */
async function selectFromList(items, options = {}) {
  if (!items.length) throw new Error('selectFromList: empty items');

  if (typeof options.chooseIndex === 'function') {
    return options.chooseIndex(items, options.initialIndex || 0);
  }

  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  let index = Math.min(Math.max(options.initialIndex || 0, 0), items.length - 1);

  const hideCursor = '\x1b[?25l';
  const showCursor = '\x1b[?25h';
  const clearLine = '\x1b[2K';

  function draw(first) {
    if (!first) {
      // Move cursor to the top of the menu block we already printed.
      stdout.write(`\x1b[${items.length}A`);
    }
    for (let i = 0; i < items.length; i++) {
      const selected = i === index;
      const pointer = selected ? '❯ ' : '  ';
      const body = selected ? `\x1b[36m${pointer}${items[i]}\x1b[0m` : `${pointer}${items[i]}`;
      stdout.write(`\r${clearLine}${body}\n`);
    }
  }

  stdout.write('\nSelect a profile (↑/↓, Enter):\n');
  stdout.write(hideCursor);
  draw(true);

  const wasRaw = stdin.isRaw;
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  if (typeof stdin.resume === 'function') stdin.resume();

  try {
    for (;;) {
      const key = options.readKey ? await options.readKey() : await readArrowKey(stdin);

      if (key === 'abort') {
        stdout.write(showCursor);
        stdout.write('\n');
        process.exit(130);
      }
      if (key === 'up') {
        index = (index - 1 + items.length) % items.length;
        draw(false);
      } else if (key === 'down') {
        index = (index + 1) % items.length;
        draw(false);
      } else if (key === 'enter') {
        stdout.write(showCursor);
        return index;
      }
    }
  } finally {
    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(!!wasRaw);
    }
    stdout.write(showCursor);
  }
}

function readArrowKey(stdin) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);

    function onData(chunk) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      const s = buf.toString('utf8');

      // Ctrl+C
      if (s.includes('\u0003')) {
        cleanup();
        resolve('abort');
        return;
      }
      // Enter
      if (s.includes('\r') || s.includes('\n')) {
        cleanup();
        resolve('enter');
        return;
      }
      // ESC [ A/B  or  ESC O A/B  (application cursor keys)
      if (s.includes('\u001b[A') || s.includes('\u001bOA')) {
        cleanup();
        resolve('up');
        return;
      }
      if (s.includes('\u001b[B') || s.includes('\u001bOB')) {
        cleanup();
        resolve('down');
        return;
      }
      // Incomplete escape sequence — wait for more bytes.
      if (s === '\u001b' || s === '\u001b[' || s === '\u001bO') {
        return;
      }
      // Ignore other keys (including leftover noise); reset buffer.
      buf = Buffer.alloc(0);
    }

    function cleanup() {
      stdin.removeListener('data', onData);
    }

    stdin.on('data', onData);
  });
}

async function promptCreateProfile(rl, store, filePath = PROFILES_FILE) {
  process.stdout.write('\nCreate a new upstream profile.\n');
  process.stdout.write('(API keys are stored in plain text under ~/.config/cc-proxy/)\n\n');

  let name = '';
  while (!name) {
    const raw = await question(rl, 'Profile name: ');
    name = sanitizeName(raw);
    if (!name) {
      process.stdout.write('  Name is required.\n');
      continue;
    }
    if (store.profiles[name]) {
      const overwrite = await question(
        rl,
        `  Profile "${name}" already exists. Overwrite? [y/N]: `,
      );
      if (!/^\s*y(es)?\s*$/i.test(overwrite)) {
        name = '';
      }
    }
  }

  const baseRaw = await question(rl, `Base URL [${DEFAULT_BASE}]: `);
  const base = (baseRaw.trim() || DEFAULT_BASE).replace(/\/$/, '');
  const key = (await question(rl, 'API key (leave empty if none): ')).trim();

  store.profiles[name] = { base, key };
  store.lastUsed = name;
  saveStore(store, filePath);

  process.stdout.write(`\nSaved profile "${name}".\n`);
  return { name, base, key };
}

async function withRl(options, fn) {
  // Prefer an injected mock rl (tests). Otherwise open readline only for
  // the create-profile text prompts so it never steals keys during the
  // raw-mode arrow picker.
  if (options.rl) return fn(options.rl);

  const rl = createRl();
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

async function promptSelectProfile(store, filePath = PROFILES_FILE, selectOpts = {}) {
  const names = listProfileNames(store);
  if (names.length === 0) {
    return withRl(selectOpts, (rl) => promptCreateProfile(rl, store, filePath));
  }

  const items = profileMenuItems(names, store);
  const initialIndex =
    store.lastUsed && names.includes(store.lastUsed) ? names.indexOf(store.lastUsed) : 0;

  const picked = await selectFromList(items, {
    initialIndex,
    chooseIndex: selectOpts.chooseIndex,
    readKey: selectOpts.readKey,
    stdin: selectOpts.stdin,
    stdout: selectOpts.stdout,
  });

  // Last row is always "Create new profile".
  if (picked === names.length) {
    return withRl(selectOpts, (rl) => promptCreateProfile(rl, store, filePath));
  }

  const name = names[picked];
  const p = store.profiles[name];
  store.lastUsed = name;
  saveStore(store, filePath);
  process.stdout.write(`Using profile "${name}".\n`);
  return { name, base: p.base, key: p.key };
}

/**
 * Resolve base + key when the user did not pass -b / -k.
 * Interactive TTY: create or pick a saved profile.
 * Non-TTY: return null so the caller falls back to env/defaults.
 */
async function resolveFromProfiles(options = {}) {
  const filePath = options.filePath || PROFILES_FILE;
  const interactive = options.interactive != null ? options.interactive : isInteractive();

  if (!interactive) return null;

  const store = loadStore(filePath);
  return promptSelectProfile(store, filePath, {
    rl: options.rl,
    chooseIndex: options.chooseIndex,
    readKey: options.readKey,
    stdin: options.stdin,
    stdout: options.stdout,
  });
}

module.exports = {
  CONFIG_DIR,
  PROFILES_FILE,
  LEGACY_PROFILES_FILE,
  DEFAULT_BASE,
  CREATE_LABEL,
  loadStore,
  saveStore,
  listProfileNames,
  sanitizeName,
  isInteractive,
  selectFromList,
  resolveFromProfiles,
  promptCreateProfile,
  promptSelectProfile,
  profileMenuItems,
};
