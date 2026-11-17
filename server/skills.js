'use strict';

const fs = require('fs');
const path = require('path');
const { stripFrontmatter, parseFrontmatter, readJson } = require('./util');

// 从多个目录读技能：按数组顺序扫描，同一个 id 后面的目录覆盖前面的。
function loadSkills(dirs) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  const byId = new Map();

  for (const dir of list) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在就跳过：extraSkillsDirs 里写了没 clone 的路径不该报错
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const base = path.join(dir, entry.name);
      const mdFile = path.join(base, 'SKILL.md');
      try {
        if (!fs.existsSync(mdFile)) continue;
        const md = fs.readFileSync(mdFile, 'utf8');
        const fm = parseFrontmatter(md);
        const meta = readJson(path.join(base, 'skill.json'), {}) || {};
        // dsh-only：需要 DSH 的终端/Python 能力，独立工作台里跑不动，先隐藏。
        if (meta.status === 'dsh-only') continue;
        const id = meta.id || fm.name || entry.name;
        const body = stripFrontmatter(md);
        const h1 = (body.match(/^\s*#\s+(.+)$/m) || [])[1];
        byId.set(id, {
          id,
          dir: entry.name,
          source: dir,
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
      } catch (err) {
        console.warn('[skills] 跳过 ' + path.join(dir, entry.name) + '：' + (err && err.message));
      }
    }
  }

  const skills = [...byId.values()];
  skills.sort((a, b) => (a.order || 100) - (b.order || 100) || a.title.localeCompare(b.title, 'zh'));
  return skills;
}

module.exports = { loadSkills };
