'use strict';

const fs = require('fs');
const path = require('path');
const { inside } = require('./util');

const MAX_ITEMS = 200;

function skillDir(skill) {
  return path.join(skill.source, skill.dir);
}

function configFiles(skill) {
  const list = skill && skill.meta && Array.isArray(skill.meta.configFiles) ? skill.meta.configFiles : [];
  return list
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim().replace(/\\/g, '/'))
    .filter((p) => !p.includes('..'));
}

function fileInfo(skill, rel) {
  const dir = skillDir(skill);
  const abs = path.resolve(dir, rel);
  if (!inside(dir, abs)) return null;
  return { rel, abs };
}

function readConfig(skill) {
  const files = configFiles(skill);
  if (!files.length) return null;
  const out = {};
  let mtimeMs = 0;
  for (const rel of files) {
    const info = fileInfo(skill, rel);
    if (!info) continue;
    let data = null;
    let mtime = 0;
    try {
      data = JSON.parse(fs.readFileSync(info.abs, 'utf8').replace(/^\uFEFF/, ''));
      mtime = fs.statSync(info.abs).mtimeMs;
    } catch {
      data = null;
    }
    out[rel] = data;
    mtimeMs = Math.max(mtimeMs, mtime);
  }
  return { files: out, mtimeMs, paths: files };
}

function backup(abs) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = abs + '.bak-' + stamp;
  try {
    fs.copyFileSync(abs, bak);
  } catch {
    /* 文件不存在就不备份 */
  }
  return bak;
}

function writeAtomic(abs, obj) {
  const tmp = abs + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // 写前自检：解析不了就别覆盖
  fs.renameSync(tmp, abs);
}

// 目标里的键可能写成 66D50F，也可能写成 LS-66D50F
function targetKeysFor(product) {
  const keys = [];
  for (const v of [product.spu, product.id]) {
    if (!v) continue;
    const s = String(v).trim();
    if (s && !keys.includes(s)) keys.push(s);
    const bare = s.replace(/^LS-/i, '');
    if (bare && !keys.includes(bare)) keys.push(bare);
  }
  return keys;
}

function pickTarget(targets, product) {
  for (const key of targetKeysFor(product)) {
    if (targets[key] && typeof targets[key] === 'object') return { key, value: targets[key] };
  }
  return { key: String(product.spu || product.id || ''), value: {} };
}

function sanitizeProduct(raw) {
  const site = String(raw.site || 'US').trim().toUpperCase() || 'US';
  const spu = String(raw.spu || raw.id || '').trim();
  const parents = (Array.isArray(raw.parents) ? raw.parents : [])
    .map((p) => String((p && p.asin) || p || '').trim().toUpperCase())
    .filter(Boolean);
  const competitor = raw.competitor || {};
  return {
    id: String(raw.id || spu).trim(),
    spu,
    site,
    title: String(raw.title || spu + '（' + site + '）'),
    parents: parents.map((asin) => ({ asin, label: '' })),
    competitor: {
      url: String(competitor.url || '').trim(),
      asin: String(competitor.asin || '').trim().toUpperCase(),
      note: String(competitor.note || ''),
    },
    price: Number(raw.price) || 0,
    rating: Number(raw.rating) || 0,
    enabled: raw.enabled !== false,
  };
}

function sanitizeTarget(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.default_monthly !== undefined) out.default_monthly = Number(raw.default_monthly) || 0;
  if (raw.monthly && typeof raw.monthly === 'object') {
    out.monthly = {};
    for (const [month, value] of Object.entries(raw.monthly)) {
      if (/^\d{4}-\d{2}$/.test(month)) out.monthly[month] = Number(value) || 0;
    }
  }
  if (raw.target_margin !== undefined) out.target_margin = Number(raw.target_margin) || 0;
  if (raw.cost && typeof raw.cost === 'object') {
    out.cost = {};
    for (const key of ['unit_cost', 'first_leg', 'fba_fee', 'referral_rate', 'other_per_unit', 'return_handling_per_unit']) {
      if (raw.cost[key] !== undefined) out.cost[key] = Number(raw.cost[key]) || 0;
    }
  }
  if (raw.rules_note) out.rules_note = String(raw.rules_note);
  if (raw.weekly_overrides && typeof raw.weekly_overrides === 'object') {
    out.weekly_overrides = {};
    for (const [day, value] of Object.entries(raw.weekly_overrides)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.weekly_overrides[day] = Number(value) || 0;
    }
  }
  return out;
}

function saveConfig(skill, payload) {
  const files = configFiles(skill);
  if (files.length !== 2) throw Object.assign(new Error('这个技能没有声明可编辑的配置文件'), { status: 400 });

  const current = readConfig(skill);
  if (!current) throw Object.assign(new Error('读不到现有配置'), { status: 400 });
  if (payload.mtimeMs && Math.abs(Number(payload.mtimeMs) - current.mtimeMs) > 2) {
    throw Object.assign(new Error('配置刚被别处改过，关掉重开再改一次'), { status: 409 });
  }

  const incoming = Array.isArray(payload.products) ? payload.products : [];
  if (incoming.length > MAX_ITEMS) throw Object.assign(new Error('产品太多（上限 ' + MAX_ITEMS + '）'), { status: 400 });

  const products = [];
  const incomingTarget = new Map();
  for (const raw of incoming) {
    const item = sanitizeProduct(raw);
    if (!item.spu) throw Object.assign(new Error('SPU 不能为空'), { status: 400 });
    if (!item.parents.length) throw Object.assign(new Error('「' + item.spu + '」至少要有一个父体 ASIN'), { status: 400 });
    if (products.some((p) => p.spu === item.spu)) {
      throw Object.assign(new Error('SPU 重复：' + item.spu), { status: 400 });
    }
    products.push(item);
    incomingTarget.set(item.spu, raw.target);
  }

  const oldTargetsDoc = current.files[files[1]] && typeof current.files[files[1]] === 'object' ? current.files[files[1]] : {};
  const targets = {};
  if (oldTargetsDoc._说明) targets._说明 = oldTargetsDoc._说明;

  for (const item of products) {
    const existing = pickTarget(oldTargetsDoc, item);
    targets[item.spu] = sanitizeTarget({ ...(existing.value || {}), ...(incomingTarget.get(item.spu) || {}) });
  }

  // 这次被删掉的产品：它的目标键一并清掉（用户确认过「删 SPU 连 targets 一起删」）
  const oldProducts = (current.files[files[0]] && Array.isArray(current.files[files[0]].products))
    ? current.files[files[0]].products
    : [];
  const removedKeys = new Set();
  for (const old of oldProducts) {
    const stillThere = products.some((p) => p.spu === String(old.spu || old.id || '').trim());
    if (!stillThere) for (const key of targetKeysFor({ spu: old.spu, id: old.id })) removedKeys.add(key);
  }

  // 不在任何产品名下的旧键：删掉的产品的键移除，其余的保留并回报，交给用户判断
  const usedKeys = new Set();
  for (const item of products) for (const key of targetKeysFor(item)) usedKeys.add(key);
  const orphanKeys = [];
  for (const [key, value] of Object.entries(oldTargetsDoc)) {
    if (key === '_说明' || usedKeys.has(key)) continue;
    if (targets[key]) continue;
    if (removedKeys.has(key)) continue; // 产品已删，目标跟着删
    targets[key] = value;
    orphanKeys.push(key);
  }

  const productsPath = fileInfo(skill, files[0]);
  const targetsPath = fileInfo(skill, files[1]);
  const backups = [];
  for (const info of [productsPath, targetsPath]) {
    if (info && fs.existsSync(info.abs)) backups.push(backup(info.abs));
  }

  const oldProductsDoc = current.files[files[0]] && typeof current.files[files[0]] === 'object' ? current.files[files[0]] : {};
  const productsDoc = { ...oldProductsDoc, products };
  if (!productsDoc.currency) productsDoc.currency = 'USD';

  writeAtomic(productsPath.abs, productsDoc);
  writeAtomic(targetsPath.abs, targets);

  const after = readConfig(skill);
  return {
    ok: true,
    backups,
    orphanKeys,
    mtimeMs: after ? after.mtimeMs : 0,
    files: after ? after.files : {},
  };
}

module.exports = { configFiles, readConfig, saveConfig, pickTarget, targetKeysFor };
