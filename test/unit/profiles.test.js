'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadStore,
  saveStore,
  listProfileNames,
  sanitizeName,
  resolveFromProfiles,
  selectFromList,
  profileMenuItems,
  CREATE_LABEL,
} = require('../../src/profiles.js');

function tempProfilesFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-profiles-'));
  return path.join(dir, 'profiles.json');
}

test('sanitizeName: trims and replaces spaces/slashes', () => {
  assert.equal(sanitizeName('  my ollama  '), 'my-ollama');
  assert.equal(sanitizeName('a/b\\c'), 'a-b-c');
  assert.equal(sanitizeName(''), '');
});

test('loadStore: missing file returns empty store', () => {
  const file = path.join(os.tmpdir(), 'cc-proxy-no-such-profiles-' + Date.now() + '.json');
  const store = loadStore(file);
  assert.deepEqual(store.profiles, {});
  assert.equal(store.lastUsed, null);
});

test('saveStore + loadStore: round-trip', () => {
  const file = tempProfilesFile();
  const store = {
    profiles: {
      ollama: { base: 'http://localhost:11434/v1', key: '' },
      openai: { base: 'https://api.openai.com/v1', key: 'sk-test' },
    },
    lastUsed: 'openai',
  };
  saveStore(store, file);
  const loaded = loadStore(file);
  assert.equal(loaded.lastUsed, 'openai');
  assert.equal(loaded.profiles.openai.key, 'sk-test');
  assert.equal(loaded.profiles.ollama.base, 'http://localhost:11434/v1');
  saveStore(
    {
      profiles: { x: { base: 'http://x.com/v1/', key: 'k' } },
      lastUsed: 'x',
    },
    file,
  );
  assert.equal(loadStore(file).profiles.x.base, 'http://x.com/v1');
});

test('loadStore: drops invalid entries, clears bad lastUsed', () => {
  const file = tempProfilesFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      profiles: {
        good: { base: 'http://a', key: 'k' },
        bad: { key: 'only' },
        empty: { base: '  ' },
      },
      lastUsed: 'missing',
    }),
  );
  const store = loadStore(file);
  assert.deepEqual(Object.keys(store.profiles), ['good']);
  assert.equal(store.lastUsed, null);
});

test('listProfileNames: sorted', () => {
  const names = listProfileNames({
    profiles: { zed: { base: 'x', key: '' }, alpha: { base: 'y', key: '' } },
    lastUsed: null,
  });
  assert.deepEqual(names, ['alpha', 'zed']);
});

test('profileMenuItems: ends with create row', () => {
  const store = {
    profiles: { a: { base: 'http://a', key: '' } },
    lastUsed: 'a',
  };
  const items = profileMenuItems(['a'], store);
  assert.equal(items[items.length - 1], CREATE_LABEL);
  assert.match(items[0], /last used/);
});

test('selectFromList: chooseIndex injection returns index', async () => {
  const idx = await selectFromList(['one', 'two', CREATE_LABEL], {
    initialIndex: 0,
    chooseIndex: (_items, initial) => {
      assert.equal(initial, 0);
      return 1;
    },
  });
  assert.equal(idx, 1);
});

test('selectFromList: readKey down then enter', async () => {
  const keys = ['down', 'enter'];
  const written = [];
  const stdout = {
    write(s) {
      written.push(s);
      return true;
    },
  };
  const idx = await selectFromList(['a', 'b', 'c'], {
    initialIndex: 0,
    readKey: async () => keys.shift(),
    stdout,
    stdin: { isRaw: false, setRawMode() {}, resume() {}, on() {}, removeListener() {} },
  });
  assert.equal(idx, 1);
  assert.ok(written.some((s) => String(s).includes('↑/↓')));
});

test('resolveFromProfiles: non-interactive returns null', async () => {
  const file = tempProfilesFile();
  const r = await resolveFromProfiles({ interactive: false, filePath: file });
  assert.equal(r, null);
});

test('resolveFromProfiles: empty store creates profile via prompts', async () => {
  const file = tempProfilesFile();
  const answers = ['my ollama', 'http://127.0.0.1:11434/v1', 'secret'];
  const rl = {
    question(_prompt, cb) {
      cb(answers.shift() ?? '');
    },
  };
  const r = await resolveFromProfiles({ interactive: true, filePath: file, rl });
  assert.equal(r.name, 'my-ollama');
  assert.equal(r.base, 'http://127.0.0.1:11434/v1');
  assert.equal(r.key, 'secret');
  const store = loadStore(file);
  assert.equal(store.lastUsed, 'my-ollama');
  assert.equal(store.profiles['my-ollama'].key, 'secret');
});

test('resolveFromProfiles: arrow-style pick via chooseIndex', async () => {
  const file = tempProfilesFile();
  saveStore(
    {
      profiles: {
        a: { base: 'http://a', key: 'ka' },
        b: { base: 'http://b', key: 'kb' },
      },
      lastUsed: 'a',
    },
    file,
  );
  const r = await resolveFromProfiles({
    interactive: true,
    filePath: file,
    rl: { question() {}, close() {} },
    // items: [a, b, Create] — pick b
    chooseIndex: () => 1,
  });
  assert.equal(r.name, 'b');
  assert.equal(r.base, 'http://b');
  assert.equal(r.key, 'kb');
  assert.equal(loadStore(file).lastUsed, 'b');
});

test('resolveFromProfiles: initial index is last used', async () => {
  const file = tempProfilesFile();
  saveStore(
    {
      profiles: {
        a: { base: 'http://a', key: 'ka' },
        b: { base: 'http://b', key: 'kb' },
      },
      lastUsed: 'b',
    },
    file,
  );
  let seenInitial;
  const r = await resolveFromProfiles({
    interactive: true,
    filePath: file,
    rl: { question() {}, close() {} },
    chooseIndex: (_items, initial) => {
      seenInitial = initial;
      return initial;
    },
  });
  assert.equal(seenInitial, 1); // b is second after sort: a, b
  assert.equal(r.name, 'b');
});

test('resolveFromProfiles: last menu row creates new profile', async () => {
  const file = tempProfilesFile();
  saveStore(
    {
      profiles: { old: { base: 'http://old', key: '' } },
      lastUsed: 'old',
    },
    file,
  );
  const answers = ['newone', 'http://new', 'nk'];
  const rl = {
    question(_prompt, cb) {
      cb(answers.shift() ?? '');
    },
  };
  const r = await resolveFromProfiles({
    interactive: true,
    filePath: file,
    rl,
    // [old, Create new] → pick create
    chooseIndex: (items) => items.length - 1,
  });
  assert.equal(r.name, 'newone');
  assert.equal(r.key, 'nk');
  assert.ok(loadStore(file).profiles.newone);
});
