'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./util');

// 员工（agent）放在每个技能目录下的 agents/ 里：
//   <技能目录>/agents/selection/agent.json + AGENT.md
// 这样打包时跟着 skills 一起走，不需要额外配置。
function loadAgents(dirs) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  const byId = new Map();

  for (const dir of list) {
    const root = path.join(dir, 'agents');
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // 没有 agents/ 就跳过
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const base = path.join(root, entry.name);
      let meta;
      try {
        meta = readJson(path.join(base, 'agent.json'), null);
      } catch (err) {
        console.warn('[agents] 跳过 ' + base + '：' + (err && err.message));
        continue;
      }
      if (!meta || !meta.id) continue;
      let body = '';
      try {
        body = fs.readFileSync(path.join(base, 'AGENT.md'), 'utf8');
      } catch {
        /* AGENT.md 可选 */
      }
// 头像：agents/<id>/avatar.svg|png|jpg|webp，有就用图片，没有才退回 emoji
      let avatar = '';
      for (const ext of ['svg', 'png', 'jpg', 'jpeg', 'webp']) {
        const file = path.join(base, 'avatar.' + ext);
        if (fs.existsSync(file)) {
          avatar = 'avatar.' + ext;
          break;
        }
      }

      byId.set(meta.id, {
        id: String(meta.id),
        dir: entry.name,
        source: dir,
        avatar,
        role: String(meta.role || ''),
        title: String(meta.title || meta.id),
        icon: String(meta.icon || '🧑‍💼'),
        order: Number(meta.order || 100),
        tagline: String(meta.tagline || ''),
        description: String(meta.description || ''),
        skills: Array.isArray(meta.skills) ? meta.skills.filter((s) => typeof s === 'string') : [],
        defaultSkill: String(meta.defaultSkill || ''),
        body: body.trim(),
        meta,
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh'));
}

module.exports = { loadAgents };
