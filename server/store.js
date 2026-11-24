'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWrite, readJson, uid, safeFileName } = require('./util');

class Store {
  constructor(root) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.sessionDir = path.join(this.dataDir, 'sessions');
    this.uploadDir = path.join(this.dataDir, 'uploads');
    this.workspace = path.join(root, 'workspace');
    for (const dir of [this.dataDir, this.sessionDir, this.uploadDir, this.workspace]) ensureDir(dir);
  }

  // ---------- sessions ----------

  newSession(skillId = null) {
    const now = Date.now();
    return {
      id: 's-' + uid(),
      title: '新对话',
      skillId: skillId || null,
      agentId: null,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      api: [],
      ui: [],
      usage: { input: 0, output: 0, cached: 0 },
    };
  }

  listSessions() {
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(this.sessionDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const s = readJson(path.join(this.sessionDir, name));
      if (!s || !s.id) continue;
      out.push({
        id: s.id,
        title: s.title || '新对话',
        skillId: s.skillId || null,
        agentId: s.agentId || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        pinned: Boolean(s.pinned),
        count: Array.isArray(s.ui) ? s.ui.filter((m) => m.role !== 'system').length : 0,
      });
    }
    out.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return out;
  }

  getSession(id) {
    if (!/^s-[a-f0-9]+$/.test(String(id || ''))) return null;
    return readJson(path.join(this.sessionDir, id + '.json'));
  }

  saveSession(session) {
    session.updatedAt = Date.now();
    atomicWrite(path.join(this.sessionDir, session.id + '.json'), JSON.stringify(session, null, 2));
    return session;
  }

  deleteSession(id) {
    if (!/^s-[a-f0-9]+$/.test(String(id || ''))) return false;
    try {
      fs.unlinkSync(path.join(this.sessionDir, id + '.json'));
      return true;
    } catch {
      return false;
    }
  }

  // ---------- uploads ----------

  saveUpload(buffer, originalName, mime) {
    const id = 'u-' + uid();
    const name = safeFileName(originalName);
    const attachDir = path.join(this.workspace, 'attachments');
    ensureDir(attachDir);
    const file = path.join(attachDir, id + '-' + name);
    fs.writeFileSync(file, buffer);
    const meta = {
      id,
      name,
      mime: mime || 'application/octet-stream',
      size: buffer.length,
      path: file,
      createdAt: Date.now(),
      remoteId: null,
      remotePurpose: null,
    };
    atomicWrite(path.join(this.uploadDir, id + '.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  getUpload(id) {
    if (!/^u-[a-f0-9]+$/.test(String(id || ''))) return null;
    const meta = readJson(path.join(this.uploadDir, id + '.json'));
    if (!meta) return null;
    if (!fs.existsSync(meta.path)) return null;
    return meta;
  }

  saveUploadMeta(meta) {
    atomicWrite(path.join(this.uploadDir, meta.id + '.json'), JSON.stringify(meta, null, 2));
  }

  // ---------- workspace ----------

  workspaceFile(relPath) {
    const abs = path.resolve(this.workspace, relPath);
    if (!abs.toLowerCase().startsWith(this.workspace.toLowerCase() + path.sep)) {
      throw new Error('路径超出工作区');
    }
    return abs;
  }
}

module.exports = { Store };
