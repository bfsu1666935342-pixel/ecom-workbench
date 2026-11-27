'use strict';
/**
 * 知识库：我们自己的口径/经验，不是网上能搜到的东西。
 *
 * 存储：data/knowledge.json（唯一数据源）
 * 导出：data/knowledge.md（自动生成，给人看 / 给 git diff，不要手改）
 *
 * 每条：{ id, category, content, note, effective, expires, source, createdAt, updatedAt, deleted }
 */
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['选品', 'Listing', '广告', '仓储备货', '售后', '工作流', '其他'];

// 老分类 → 新分类（数据里可能还有旧值）
const LEGACY = { 评论: 'Listing', 运营: '工作流', 仓储: '仓储备货', 备货: '仓储备货' };
const SOURCES = ['手写', '对话总结', '报告摘录'];

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

class Knowledge {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'knowledge.json');
    this.md = path.join(dataDir, 'knowledge.md');
  }

  read() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(doc.items) ? doc : { items: [] };
    } catch {
      return { items: [] };
    }
  }

  write(doc) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(doc, null, 2), 'utf8');
    this.exportMd(doc);
    return doc;
  }

  /** 列表：默认不含已删除、不含未生效、不含已过期 */
  list({ q = '', category = '', includeDeleted = false, includeFuture = true } = {}) {
    const doc = this.read();
    const now = today();
    const kw = String(q || '').trim().toLowerCase();
    return doc.items
      .map((it) => (CATEGORIES.includes(it.category) ? it : Object.assign({}, it, { category: LEGACY[it.category] || "其他" })))
      .filter((it) => (includeDeleted ? true : !it.deleted))
      .filter((it) => (category ? it.category === category : true))
      .filter((it) => (includeFuture ? true : !it.effective || it.effective <= now))
      .filter((it) => {
        if (!kw) return true;
        return (it.content + ' ' + (it.note || '') + ' ' + (it.category || '')).toLowerCase().includes(kw);
      })
      .sort((a, b) => String(b.effective || '').localeCompare(String(a.effective || '')) || b.createdAt - a.createdAt);
  }

  add(input) {
    const content = String((input && input.content) || '').trim();
    if (!content) throw Object.assign(new Error('内容不能为空'), { status: 400 });
    if (content.length > 2000) throw Object.assign(new Error('一条最多 2000 字'), { status: 400 });
    const category = CATEGORIES.includes(input.category) ? input.category : '其他';
    const effective = isDate(input.effective) ? input.effective : today();
    const expires = isDate(input.expires) ? input.expires : '';
    if (expires && expires < effective) throw Object.assign(new Error('失效时间不能早于生效时间'), { status: 400 });
    const doc = this.read();
    const item = {
      id: 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      category,
      content,
      note: String(input.note || '').trim(),
      effective,
      expires,
      source: SOURCES.includes(input.source) ? input.source : '手写',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deleted: false,
    };
    doc.items.push(item);
    this.write(doc);
    return item;
  }

  update(id, patch) {
    const doc = this.read();
    const item = doc.items.find((x) => x.id === id);
    if (!item) throw Object.assign(new Error('找不到这条知识'), { status: 404 });
    if (patch.content !== undefined) {
      const content = String(patch.content).trim();
      if (!content) throw Object.assign(new Error('内容不能为空'), { status: 400 });
      item.content = content;
    }
    if (patch.note !== undefined) item.note = String(patch.note || '').trim();
    if (patch.category !== undefined && CATEGORIES.includes(patch.category)) item.category = patch.category;
    if (patch.effective !== undefined && isDate(patch.effective)) item.effective = patch.effective;
    if (patch.expires !== undefined) item.expires = isDate(patch.expires) ? patch.expires : '';
    if (item.expires && item.effective && item.expires < item.effective) {
      throw Object.assign(new Error('失效时间不能早于生效时间'), { status: 400 });
    }
    if (patch.deleted !== undefined) item.deleted = Boolean(patch.deleted);
    item.updatedAt = Date.now();
    this.write(doc);
    return item;
  }

  remove(id) {
    return this.update(id, { deleted: true });
  }

  /** 给员工用：只返回当下有效、且相关的几条 */
  search(query, { category = '', limit = 5 } = {}) {
    const now = today();
    const doc = this.read();
    const words = String(query || '')
      .toLowerCase()
      .split(/[\s,，、。;；/]+/)
      .filter((w) => w.length >= 2);
    return doc.items
      .filter((it) => !it.deleted)
      .filter((it) => !it.effective || it.effective <= now)
      .filter((it) => !it.expires || it.expires >= now)
      .filter((it) => (category ? it.category === category : true))
      .map((it) => {
        const hay = (it.content + ' ' + (it.note || '')).toLowerCase();
        let score = 0;
        for (const w of words) if (hay.includes(w)) score += 1;
        return { it, score };
      })
      .filter((x) => (words.length ? x.score > 0 : true))
      .sort((a, b) => b.score - a.score || b.it.updatedAt - a.it.updatedAt)
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map((x) => x.it);
  }

  exportMd(doc) {
    const items = (doc || this.read()).items.filter((x) => !x.deleted);
    const lines = ['# 知识库', '', '> 由工作台自动生成，请勿手改（改了会被覆盖）。数据源：data/knowledge.json', ''];
    for (const cat of CATEGORIES) {
      const list = items.filter((x) => x.category === cat);
      if (!list.length) continue;
      lines.push('## ' + cat, '');
      for (const it of list.sort((a, b) => String(b.effective).localeCompare(String(a.effective)))) {
        lines.push('### ' + it.content.split('\n')[0].slice(0, 40));
        lines.push('- 生效：' + (it.effective || '-') + (it.expires ? '　失效：' + it.expires : ''));
        if (it.note) lines.push('- 备注：' + it.note);
        lines.push('- 来源：' + (it.source || '手写'));
        lines.push('');
        lines.push(it.content);
        lines.push('');
      }
    }
    fs.writeFileSync(this.md, lines.join('\n'), 'utf8');
  }
}

module.exports = { Knowledge, CATEGORIES, SOURCES, today };
