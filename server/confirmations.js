'use strict';
/**
 * 待确认的动作（目前只有「运行技能」）。
 *
 * 员工发起 → 这里存一条 → 界面出确认卡 → 用户点「确认运行」→ 取出来真正执行。
 * 和 proposals.js 是一个思路：模型只提案，不直接动手。
 */
const TTL = 30 * 60 * 1000; // 30 分钟内有效
const store = new Map();

function create(item) {
  const id = 'cf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const record = Object.assign({ id, createdAt: Date.now() }, item);
  store.set(id, record);
  prune();
  return record;
}

function peek(id) {
  const item = store.get(String(id || ''));
  if (!item) return null;
  if (Date.now() - item.createdAt > TTL) {
    store.delete(item.id);
    return null;
  }
  return item;
}

function take(id) {
  const item = peek(id);
  if (item) store.delete(item.id);
  return item;
}

function prune() {
  const now = Date.now();
  for (const [id, item] of store) {
    if (now - item.createdAt > TTL) store.delete(id);
  }
}

module.exports = { create, peek, take, prune };
