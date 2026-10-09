'use strict';
const db = require('../db');
const { UserError } = require('../bus');
const credits = require('./credits');
const { SHOP_SEED } = require('../constants');

function seed() {
  if (db.one('SELECT COUNT(*) AS n FROM shop_items').n > 0) return;
  for (const i of SHOP_SEED) db.run('INSERT INTO shop_items (name, cost, description) VALUES (?,?,?)', i.name, i.cost, i.description);
}

const items = (all = false) => db.all(`SELECT * FROM shop_items ${all ? '' : 'WHERE active = 1'} ORDER BY cost`);
const item = (id) => db.one('SELECT * FROM shop_items WHERE id = ?', id);

function add({ name, cost, description, stock = -1 }) {
  const r = db.run('INSERT INTO shop_items (name, cost, description, stock, active) VALUES (?,?,?,?,1)', name, cost, description, stock);
  return item(r.lastInsertRowid);
}

function edit(id, patch) {
  const i = item(id);
  if (!i) throw new UserError('Item not found.');
  db.run('UPDATE shop_items SET name = ?, cost = ?, description = ?, stock = ?, active = ? WHERE id = ?',
    patch.name ?? i.name, patch.cost ?? i.cost, patch.description ?? i.description, patch.stock ?? i.stock, patch.active ?? i.active, id);
  return item(id);
}

function redeem(userId, itemId) {
  const i = item(itemId);
  if (!i || !i.active) throw new UserError('That item isn\'t in the shop.');
  if (i.stock === 0) throw new UserError('That item is sold out.');
  const r = credits.spend(userId, i.cost, 'redeem', `Redeemed: ${i.name}`);
  if (!r.ok) throw new UserError(`You need ${r.short} more credits for ${i.name}.`);
  if (i.stock > 0) db.run('UPDATE shop_items SET stock = stock - 1 WHERE id = ?', itemId);
  const res = db.run("INSERT INTO redemptions (user_id, item_id, item_name, cost, status, created_at) VALUES (?,?,?,?,'open',?)",
    userId, itemId, i.name, i.cost, Date.now());
  return { redemption: db.one('SELECT * FROM redemptions WHERE id = ?', res.lastInsertRowid), balance: r.balance };
}

function resolve(id, status, by) {
  const r = db.one('SELECT * FROM redemptions WHERE id = ?', id);
  if (!r) throw new UserError('Redemption not found.');
  if (r.status !== 'open') throw new UserError(`Already ${r.status}.`);
  db.run('UPDATE redemptions SET status = ?, handled_by = ? WHERE id = ?', status, by, id);
  if (status === 'refunded') {
    credits.award(r.user_id, r.cost, 'refund', `Refund: ${r.item_name}`, { ref: `redeem:${id}`, unique: true, by });
    const i = item(r.item_id);
    if (i && i.stock >= 0) db.run('UPDATE shop_items SET stock = stock + 1 WHERE id = ?', r.item_id);
  }
  return db.one('SELECT * FROM redemptions WHERE id = ?', id);
}

const openRedemptions = () => db.all("SELECT * FROM redemptions WHERE status = 'open' ORDER BY id");

module.exports = { seed, items, item, add, edit, redeem, resolve, openRedemptions };
