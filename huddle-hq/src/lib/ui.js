'use strict';
// Raw Discord JSON builders, styled in THN black and red.
const { BRAND } = require('../constants');

const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

let logoUrl = null;
function setLogo(url) { logoUrl = url || null; }

function embed({ title, description, fields, color, footer, url, thumbnail, image, timestamp } = {}) {
  const e = { color: color ?? BRAND.red };
  if (title) e.title = clip(title, 256);
  if (url) e.url = url;
  if (description) e.description = clip(description, 4096);
  const f = (fields || []).filter((x) => x && x.name);
  if (f.length) {
    e.fields = f.slice(0, 25).map((x) => ({
      name: clip(x.name, 256),
      value: clip(x.value === undefined || x.value === null || x.value === '' ? '—' : x.value, 1024),
      inline: !!x.inline,
    }));
  }
  e.footer = { text: clip(footer ? `${BRAND.name}  |  ${footer}` : BRAND.name, 2048) };
  if (logoUrl) e.footer.icon_url = logoUrl;
  if (thumbnail) e.thumbnail = { url: thumbnail };
  if (image) e.image = { url: image };
  if (timestamp) e.timestamp = new Date(timestamp === true ? Date.now() : timestamp).toISOString();
  return e;
}

const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

function button(customId, label, style = 'secondary', opts = {}) {
  const b = { type: 2, style: STYLE[style] || 2, label: clip(label, 80) };
  if (style === 'link') b.url = opts.url || customId;
  else b.custom_id = clip(customId, 100);
  if (opts.emoji) b.emoji = { name: opts.emoji };
  if (opts.disabled) b.disabled = true;
  return b;
}

const linkButton = (url, label) => button(url, label, 'link', { url });

// Splits any number of buttons into rows of 5.
function rows(buttons) {
  const list = buttons.filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length && out.length < 5; i += 5) out.push({ type: 1, components: list.slice(i, i + 5) });
  return out;
}

function select(customId, options, { placeholder, min = 1, max = 1 } = {}) {
  const opts = options.slice(0, 25).map((o) => ({
    label: clip(o.label, 100), value: clip(o.value, 100),
    ...(o.description ? { description: clip(o.description, 100) } : {}),
    ...(o.default ? { default: true } : {}),
  }));
  return {
    type: 1,
    components: [{
      type: 3, custom_id: clip(customId, 100), options: opts,
      ...(placeholder ? { placeholder: clip(placeholder, 150) } : {}),
      min_values: Math.min(min, opts.length), max_values: Math.min(max, opts.length),
    }],
  };
}

// inputs: [{ id, label, placeholder, value, paragraph, required, max, min }]
function modal(customId, title, inputs) {
  return {
    custom_id: clip(customId, 100),
    title: clip(title, 45),
    components: inputs.slice(0, 5).map((i) => ({
      type: 1,
      components: [{
        type: 4, custom_id: i.id, label: clip(i.label, 45), style: i.paragraph ? 2 : 1,
        required: i.required !== false,
        ...(i.placeholder ? { placeholder: clip(i.placeholder, 100) } : {}),
        ...(i.value ? { value: clip(i.value, i.max || 4000) } : {}),
        ...(i.max ? { max_length: i.max } : {}),
        ...(i.min ? { min_length: i.min } : {}),
      }],
    })),
  };
}

function bar(value, max = 99, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const mention = (id) => (id ? `<@${id}>` : 'CPU');
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);
const pctText = (n, d) => (d ? `${pct(n, d)}% (${n}/${d})` : 'No games yet');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

const ok = (text, title) => embed({ title: title || undefined, description: text, color: BRAND.green });
const err = (text) => embed({ description: text, color: BRAND.red });
const info = (text, title) => embed({ title: title || undefined, description: text, color: BRAND.grey });

module.exports = {
  clip, setLogo, embed, button, linkButton, rows, select, modal, bar, mention, pct, pctText, plural, signed, ok, err, info,
};
