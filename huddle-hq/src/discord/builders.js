'use strict';
// Tiny helpers for slash-command JSON.

const base = (type, name, description, o = {}) => {
  const out = { type, name, description, required: !!o.required };
  if (o.choices) out.choices = o.choices.map((c) => (typeof c === 'object' ? c : { name: String(c), value: c }));
  if (o.autocomplete) out.autocomplete = true;
  if (o.min !== undefined) out[type === 3 ? 'min_length' : 'min_value'] = o.min;
  if (o.max !== undefined) out[type === 3 ? 'max_length' : 'max_value'] = o.max;
  if (o.channelTypes) out.channel_types = o.channelTypes;
  return out;
};

const str = (n, d, o) => base(3, n, d, o);
const int = (n, d, o) => base(4, n, d, o);
const bool = (n, d, o) => base(5, n, d, o);
const user = (n, d, o) => base(6, n, d, o);
const channel = (n, d, o) => base(7, n, d, o);
const role = (n, d, o) => base(8, n, d, o);
const attachment = (n, d, o) => base(11, n, d, o);

const sub = (name, description, options = []) => ({ type: 1, name, description, options });
const group = (name, description, subs) => ({ type: 2, name, description, options: subs });

// perms: 'staff' -> hidden from members (Manage Messages), 'admin' -> Administrator
function command(name, description, options = [], perms = null) {
  const c = { name, description, type: 1, options };
  if (perms === 'staff') c.default_member_permissions = String(1 << 13);
  if (perms === 'admin') c.default_member_permissions = String(1 << 3);
  return c;
}

const leagueChoices = [{ name: 'Huddle League', value: 'HL' }, { name: 'Network League', value: 'NL' }];
const tzChoices = [
  { name: 'Pacific (PT)', value: 'PT' }, { name: 'Mountain (MT)', value: 'MT' }, { name: 'Arizona (AZ)', value: 'AZ' },
  { name: 'Central (CT)', value: 'CT' }, { name: 'Eastern (ET)', value: 'ET' }, { name: 'Alaska (AK)', value: 'AK' },
  { name: 'Hawaii (HI)', value: 'HI' },
];
const dayChoices = [
  { name: 'Today', value: 'today' }, { name: 'Tomorrow', value: 'tomorrow' },
  { name: 'Monday', value: 'mon' }, { name: 'Tuesday', value: 'tue' }, { name: 'Wednesday', value: 'wed' },
  { name: 'Thursday', value: 'thu' }, { name: 'Friday', value: 'fri' }, { name: 'Saturday', value: 'sat' },
  { name: 'Sunday', value: 'sun' },
];

module.exports = { str, int, bool, user, channel, role, attachment, sub, group, command, leagueChoices, tzChoices, dayChoices };
