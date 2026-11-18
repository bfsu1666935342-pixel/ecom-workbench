'use strict';

/* 待确认的配置改动。模型只能"提案"，用户点「应用」才真正写盘。 */

const TTL_MS = 30 * 60 * 1000;
const pending = new Map();
let seq = 0;

function create(item) {
  prune();
  seq += 1;
  const id = 'cfg-' + Date.now().toString(36) + '-' + seq;
  pending.set(id, { ...item, id, at: Date.now() });
  return id;
}

function take(id) {
  const item = pending.get(String(id || '')) || null;
  if (item) pending.delete(item.id);
  return item;
}

function peek(id) {
  return pending.get(String(id || '')) || null;
}

function prune() {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (now - value.at > TTL_MS) pending.delete(key);
  }
}

module.exports = { create, take, peek, prune };
