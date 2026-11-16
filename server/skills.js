'use strict';

const fs = require('fs');
const path = require('path');
const { stripFrontmatter, parseFrontmatter, readJson } = require('./util');

function loadSkills(root) {
  const dir = path.join(root, 'skills');
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const base = path.join(dir, entry.name);
    const mdFile = path.join(base, 'SKILL.md');
    if (!fs.existsSync(mdFile)) continue;
    const md = fs.readFileSync(mdFile, 'utf8');
    const fm = parseFrontmatter(md);
    const meta = readJson(path.join(base, 'skill.json'), {}) || {};
    const id = meta.id || fm.name || entry.name;
    const body = stripFrontmatter(md);
    const h1 = (body.match(/^\s*#\s+(.+)$/m) || [])[1];
    skills.push({
      id,
      dir: entry.name,
      title: meta.title || fm.title || (h1 ? h1.trim() : id),
      icon: meta.icon || '🧩',
      group: meta.group || '其他',
      order: Number(meta.order || 100),
      tagline: meta.tagline || '',
      description: meta.description || fm.description || '',
      starters: Array.isArray(meta.starters) ? meta.starters : [],
      fields: Array.isArray(meta.fields) ? meta.fields : [],
      featured: Boolean(meta.featured),
      body,
      meta,
    });
  }
  skills.sort((a, b) => (a.order || 100) - (b.order || 100) || a.title.localeCompare(b.title, 'zh'));
  return skills;
}

module.exports = { loadSkills };
