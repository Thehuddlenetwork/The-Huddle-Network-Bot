'use strict';
// Validates every slash command against Discord's documented limits.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

db.init(':memory:');
const router = require('../src/discord/router');
for (const n of ['setup', 'members', 'games', 'league', 'economy', 'trades', 'clips', 'academy', 'network']) router.register(require(`../src/modules/${n}`));

const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

function chars(o) {
  let n = (o.name || '').length + (o.description || '').length;
  for (const c of o.choices || []) n += c.name.length + String(c.value).length;
  for (const x of o.options || []) n += chars(x);
  return n;
}

function checkOptions(opts, path) {
  assert.ok(opts.length <= 25, `${path}: more than 25 options`);
  const kinds = new Set(opts.map((o) => (o.type === 1 || o.type === 2 ? 'sub' : 'value')));
  assert.ok(kinds.size <= 1, `${path}: mixes subcommands and values`);
  let sawOptional = false;
  const names = new Set();
  for (const o of opts) {
    const p = `${path} ${o.name}`;
    assert.match(o.name, NAME, `${p}: bad name`);
    assert.strictEqual(o.name, o.name.toLowerCase(), `${p}: name must be lowercase`);
    assert.ok(!names.has(o.name), `${p}: duplicate name`);
    names.add(o.name);
    assert.ok(o.description && o.description.length >= 1 && o.description.length <= 100, `${p}: description length ${o.description && o.description.length}`);
    if (o.type === 1 || o.type === 2) { checkOptions(o.options || [], p); continue; }
    if (o.required) assert.ok(!sawOptional, `${p}: required option after optional`);
    else sawOptional = true;
    if (o.choices) {
      assert.ok(o.choices.length <= 25, `${p}: too many choices`);
      assert.ok(!o.autocomplete, `${p}: choices and autocomplete together`);
      for (const c of o.choices) {
        assert.ok(c.name.length >= 1 && c.name.length <= 100, `${p}: choice name length`);
        if (typeof c.value === 'string') assert.ok(c.value.length <= 100, `${p}: choice value length`);
      }
    }
  }
}

test('slash command definitions are valid', () => {
  const defs = router.definitions();
  assert.ok(defs.length <= 100);
  const names = new Set();
  for (const d of defs) {
    assert.match(d.name, NAME);
    assert.ok(!names.has(d.name), `duplicate command ${d.name}`);
    names.add(d.name);
    assert.ok(d.description.length >= 1 && d.description.length <= 100, `${d.name}: description`);
    checkOptions(d.options, `/${d.name}`);
    const total = chars(d);
    assert.ok(total <= 4000, `/${d.name}: ${total} characters (limit 4000)`);
  }
});

test('every component custom_id prefix has a handler', () => {
  const fs = require('fs');
  const path = require('path');
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(__dirname, '..', 'src'));
  const ids = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:button|select|modal)\(\s*[`'"]([a-z]+):([a-z]+)/g)) ids.add(`${m[1]}:${m[2]}`);
  }
  const mods = ['setup', 'members', 'games', 'league', 'economy', 'trades', 'clips', 'academy', 'network'].map((n) => require(`../src/modules/${n}`));
  const keys = new Set(mods.flatMap((m) => [...Object.keys(m.buttons || {}), ...Object.keys(m.selects || {}), ...Object.keys(m.modals || {})]));
  for (const id of ids) {
    const [prefix] = id.split(':');
    assert.ok(keys.has(id) || keys.has(prefix), `no handler for ${id}`);
  }
  assert.ok(ids.size > 20);
});
