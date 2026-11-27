'use strict';

(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const LS = {
    key: 'ecom.key',
    settings: 'ecom.settings',
  };

  const state = {
    cfg: null,
    skills: [],
    agents: [],
    agent: null,
    sessions: [],
    session: null,
    messages: [],
    skill: null,
    skillOrder: new Map(),
    attachments: [],
    streaming: false,
    controller: null,
    abortedByUser: false,
    live: null,
    view: 'chat',
    mcp: { servers: [], connected: 0, toolCount: 0 },
    skillFilter: { q: '', group: '全部' },
    outputFilter: { q: '', group: '全部', onlyDocs: true },
    outputs: { items: [], total: 0, loaded: false },
    chatStick: true,
    shops: { items: [], loaded: false },
    settings: {
      key: '',
      model: '',
      thinking: false,
      search: false,
      theme: 'light',
    },
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    loadSettings();
    applyTheme();
    bindEvents();
    try {
      const resp = await fetch('/api/bootstrap');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      state.cfg = data;
      state.skills = data.skills || [];
      state.agents = data.agents || [];
      state.sessions = data.sessions || [];
      state.mcp = data.mcp || { servers: [], connected: 0, toolCount: 0 };
      buildSkillOrder();
      if (!state.settings.model) state.settings.model = data.model || 'deepseek-flash';
      renderBrand();
      renderNavCounts();
      renderSessions();
      renderSkillFilters();
      updateToggles();
      updateModelTag();
      updateSkillUI();
      toggleWelcome();
      setTimeout(() => checkUpdateSilently(), 2500);
      showView('chat');
      placeNavGlass(false);
      window.addEventListener('resize', () => scheduleNavGlass(false));
      if (!state.settings.key) showOnboarding();
    } catch (err) {
      document.body.innerHTML =
        '<div style="padding:60px;font-family:sans-serif;color:#333"><h2>工作台没有启动成功</h2><p>请关闭窗口，重新双击「启动.bat」。如果仍然失败，检查端口是否被占用。</p><p style="color:#999">' +
        esc(err.message) +
        '</p></div>';
    }
  }

  /* ================= 设置 ================= */

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS.settings) || '{}');
      Object.assign(state.settings, saved || {});
    } catch {
      /* ignore */
    }
    try {
      state.settings.key = localStorage.getItem(LS.key) || '';
    } catch {
      /* ignore */
    }
    if (!['light', 'dark', 'auto'].includes(state.settings.theme)) state.settings.theme = 'light';
  }

  function saveSettings() {
    const { key, ...rest } = state.settings;
    localStorage.setItem(LS.key, key || '');
    localStorage.setItem(LS.settings, JSON.stringify(rest));
  }

  function applyTheme() {
    const mode = state.settings.theme;
    const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const btn = $('#themeBtn');
    if (btn) btn.title = dark ? '切换到浅色' : '切换到深色';
  }

  function updateToggles() {
    $('#searchBtn').classList.toggle('on', Boolean(state.settings.search));
    $('#thinkBtn').classList.toggle('on', Boolean(state.settings.thinking));
  }

  function updateModelTag() {
    const m = state.settings.model || (state.cfg && state.cfg.model) || 'deepseek-flash';
    $('#modelTag').textContent = /pro/i.test(m) ? 'V4 Pro' : 'Flash';
  }

  /* ================= 侧栏 ================= */

  function renderBrand() {
    if (!state.cfg) return;
    document.title = state.cfg.brand + ' · ' + state.cfg.brandEn;
    $('#brandName').textContent = state.cfg.brand;
    $('#brandSub').textContent = state.cfg.brandEn + (state.cfg.version ? ' · v' + state.cfg.version : '');
  }

  function buildSkillOrder() {
    state.skillOrder = new Map();
    const groups = new Map();
    for (const s of state.skills) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    for (const [group, items] of groups) {
      items.forEach((s, i) => {
        state.skillOrder.set(s.id, { no: String(i + 1).padStart(2, '0'), group });
      });
    }
  }

  function skillNo(skill) {
    const item = state.skillOrder.get(skill.id);
    return item ? item.no : '01';
  }

  function skillGroupLabel(skill) {
    const group = (state.skillOrder.get(skill.id) || {}).group || skill.group || '技能';
    return group
      .replace('与内容', '')
      .replace('与流量', '')
      .replace('与供应链', '')
      .replace('与客服', '')
      .replace('与市场', '');
  }

  function renderNavCounts() {
    const skillCount = $('#navSkillCount');
    if (skillCount) skillCount.textContent = state.skills.length;
    const mcpCount = $('#navMcpCount');
    if (mcpCount) mcpCount.textContent = state.mcp && state.mcp.connected ? state.mcp.connected : 0;
    const pageCount = $('#skillsPageCount');
    if (pageCount) pageCount.textContent = state.skills.length;
    const agentCount = $('#navAgentCount');
    if (agentCount) agentCount.textContent = state.agents.length;
    const agentsPage = $('#agentsPageCount');
    if (agentsPage) agentsPage.textContent = state.agents.length;
  }

  function renderSkillFilters() {
    const box = $('#skillFilters');
    if (!box) return;
    const groups = [];
    for (const s of state.skills) {
      if (!groups.includes(s.group)) groups.push(s.group);
    }
    box.innerHTML = '';
    for (const name of ['全部', ...groups]) {
      const btn = document.createElement('button');
      btn.className = 'filter' + (state.skillFilter.group === name ? ' active' : '');
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        state.skillFilter.group = name;
        renderSkillFilters();
        renderSkillsPage();
      });
      box.append(btn);
    }
  }

  async function loadOutputs(force) {
    if (state.outputs.loaded && !force) return;
    try {
      const resp = await fetch('/api/outputs');
      const data = await resp.json();
      state.outputs.items = Array.isArray(data.items) ? data.items : [];
      state.outputs.total = Number(data.total) || state.outputs.items.length;
      state.outputs.loaded = true;
    } catch {
      state.outputs.items = [];
      state.outputs.total = 0;
    }
    const badge = $('#navOutputCount');
    if (badge) badge.textContent = String(state.outputs.total);
    renderOutputFilters();
    renderOutputsPage();
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function fmtWhen(ms) {
    const d = new Date(Number(ms) || 0);
    if (!d.getTime()) return '';
    const pad = (x) => String(x).padStart(2, '0');
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderOutputFilters() {
    const box = $('#outputFilters');
    if (!box) return;
    const groups = [];
    for (const item of state.outputs.items) {
      if (!groups.includes(item.group)) groups.push(item.group);
    }
    box.innerHTML = '';
    for (const name of ['全部', ...groups]) {
      const btn = document.createElement('button');
      btn.className = 'filter' + (state.outputFilter.group === name ? ' active' : '');
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        state.outputFilter.group = name;
        renderOutputFilters();
        renderOutputsPage();
      });
      box.append(btn);
    }
  }

  function renderOutputsPage() {
    const box = $('#outputList');
    if (!box) return;
    const q = state.outputFilter.q.trim().toLowerCase();
    const group = state.outputFilter.group;
    const groups = new Map();
    const DOC_EXT = new Set(['html', 'htm', 'md', 'docx', 'doc', 'pdf', 'xlsx', 'xls', 'csv', 'txt', 'png', 'jpg', 'jpeg']);
    const RANK = { html: 0, md: 1, docx: 2, pdf: 3, xlsx: 4, csv: 5, png: 6, jpg: 6, jpeg: 6, txt: 7 };
    for (const item of state.outputs.items) {
      if (state.outputFilter.onlyDocs && !DOC_EXT.has(item.ext)) continue;
      if (group !== '全部' && item.group !== group) continue;
      if (q) {
        const hay = (item.name + ' ' + item.rel + ' ' + item.group).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const ra = RANK[a.ext] === undefined ? 99 : RANK[a.ext];
        const rb = RANK[b.ext] === undefined ? 99 : RANK[b.ext];
        if (ra !== rb) return ra - rb;
        return b.mtime - a.mtime;
      });
    }
    box.innerHTML = '';
    if (!groups.size) {
      const empty = document.createElement('div');
      empty.className = 'skill-empty';
      empty.textContent = state.outputs.loaded
        ? (state.outputFilter.onlyDocs ? '没有报告类产出。点「全部文件」看原始数据。' : '还没有产出。跑一次技能（比如周报）后，文件会出现在这里。')
        : '正在读取工作区……';
      box.append(empty);
      return;
    }
    for (const [name, items] of groups) {
      const section = document.createElement('section');
      section.className = 'index-group';
      const head = document.createElement('div');
      head.className = 'index-head';
      head.innerHTML = '<span>' + esc(name) + '</span><span class="index-count">' + items.length + '</span>';
      section.append(head);
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'output-row';

        const main = document.createElement('button');
        main.className = 'output-main';
        main.type = 'button';
        main.title = item.rel;
        main.innerHTML =
          '<span class="output-name">' + esc(item.name) + '</span>' +
          '<span class="output-meta">' + fmtSize(item.size) + ' · ' + fmtWhen(item.mtime) + '</span>';
        main.addEventListener('click', () => {
          window.open('/api/file?path=' + encodeURIComponent(item.rel), '_blank', 'noopener');
        });

        const actions = document.createElement('span');
        actions.className = 'output-actions';

        const dl = document.createElement('button');
        dl.type = 'button';
        dl.textContent = '下载';
        dl.addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = '/api/file?download=1&path=' + encodeURIComponent(item.rel);
          a.download = item.name;
          a.click();
        });

        const locate = document.createElement('button');
        locate.type = 'button';
        locate.textContent = '位置';
        locate.addEventListener('click', async () => {
          try {
            await fetch('/api/open', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: item.rel }),
            });
          } catch {
            toast('打不开文件夹');
          }
        });

        actions.append(dl, locate);
        row.append(main, actions);
        section.append(row);
      }
      box.append(section);
    }
  }

  function renderSkillsPage() {
    const box = $('#skillIndex');
    if (!box) return;
    const q = state.skillFilter.q.trim().toLowerCase();
    const groupFilter = state.skillFilter.group;
    const groups = new Map();
    for (const s of state.skills) {
      if (groupFilter !== '全部' && s.group !== groupFilter) continue;
      if (q) {
        const hay = (s.title + ' ' + (s.tagline || '') + ' ' + (s.description || '') + ' ' + s.group).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    box.innerHTML = '';
    if (!groups.size) {
      const empty = document.createElement('div');
      empty.className = 'skill-empty';
      empty.textContent = '没有匹配的技能';
      box.append(empty);
      return;
    }
    for (const [group, items] of groups) {
      const section = document.createElement('section');
      section.className = 'index-group';
      const head = document.createElement('div');
      head.className = 'index-head';
      head.innerHTML = '<span>' + esc(group) + '</span><span class="index-count">' + items.length + '</span>';
      section.append(head);
      for (const skill of items) {
        const row = document.createElement('button');
        row.className = 'index-row';
        row.type = 'button';
        row.innerHTML =
          '<span class="idx-no">' + skillNo(skill) + '</span>' +
          '<span class="idx-title">' + esc(skill.title) + '</span>' +
          '<span class="idx-desc">' + esc(skill.tagline || skill.description || '') + '</span>' +
          '<span class="idx-go" aria-hidden="true">→</span>';
        row.addEventListener('click', () => openSkill(skill));
        section.append(row);
      }
      box.append(section);
    }
  }


  // ---------------- 员工 ----------------

  function agentSkills(agent) {
    return (agent.skills || []).map((id) => state.skills.find((s) => s.id === id)).filter(Boolean);
  }

  function agentAvatarInner(agent) {
    if (agent.avatar) {
      return '<img class="agent-avatar" alt="" src="/api/agent/avatar?id=' + encodeURIComponent(agent.id) + '">';
    }
    return '<span class="agent-emoji">' + esc(agent.icon || '🧑‍💼') + '</span>';
  }

  function agentAvatar(agent, cls) {
    return '<div class="' + cls + '">' + agentAvatarInner(agent) + '</div>';
  }
  function renderAgentsPage() {
    const box = $('#agentGrid');
    if (!box) return;
    box.innerHTML = '';
    if (!state.agents.length) {
      box.innerHTML = '<p class="run-hint">还没有员工。往技能库的 agents/ 目录里加一个 agent.json 就有了。</p>';
      return;
    }
    for (const agent of state.agents) {
      const skills = agentSkills(agent);
      const el = document.createElement('button');
      el.className = 'agent-card';
      el.type = 'button';
      el.innerHTML =
        agentAvatar(agent, 'agent-icon') +
        '<div class="agent-body"><div class="agent-role">' + esc(agent.role || '') + '</div>' +
        '<div class="agent-title">' + esc(agent.title) + '</div>' +
        '<div class="agent-tagline">' + esc(agent.tagline || '') + '</div>' +
        '<div class="agent-skills">' +
        skills.map((s) => '<span class="agent-skill">' + esc(s.title) + '</span>').join('') +
        (skills.length ? '' : '<span class="run-hint">还没有技能</span>') +
        '</div></div>';
      el.addEventListener('click', () => openAgent(agent));
      box.append(el);
    }
  }

  async function saveAgentSkills(agent, nextSkills) {
    const resp = await fetch('/api/agent/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, skills: nextSkills }),
    });
    const data = await resp.json();
    if (!data.ok) {
      alert('保存失败：' + (data.error || '未知原因'));
      return false;
    }
    agent.skills = nextSkills;
    if (state.agent && state.agent.id === agent.id) state.agent = agent;
    return true;
  }

  function openAgent(agent) {
    const skills = agentSkills(agent);
    const rest = state.skills.filter((s) => !(agent.skills || []).includes(s.id));

    const render = () => {
      const owned = agentSkills(agent);
      const left = state.skills.filter((s) => !(agent.skills || []).includes(s.id));
      return (
        '<div class="modal-head"><div class="skill-hero"><div class="skill-no">' + agentAvatarInner(agent) + '</div>' +
        '<div><div class="skill-group-tag">' + esc(agent.role ? agent.role + ' · 员工' : '员工') + '</div><h2>' + esc(agent.title) + '</h2>' +
        '<div class="tag">' + esc(agent.tagline || '') + '</div></div></div>' +
        '<button class="modal-close" data-close type="button">×</button></div>' +
        '<p class="skill-desc">' + esc(agent.description || '') + '</p>' +
        '<h3>岗位技能（' + owned.length + '）</h3>' +
        '<div class="agent-skill-list">' +
        (owned.length
          ? owned
              .map(
                (s) =>
                  '<span class="agent-skill editable">' + esc(s.title) +
                  '<button type="button" data-remove="' + esc(s.id) + '" title="移除">×</button></span>'
              )
              .join('')
          : '<span class="run-hint">还没有技能</span>') +
        '</div>' +
        (left.length
          ? '<h3>给它加一个技能</h3><div class="agent-add"><select id="agentAddSkill">' +
            left.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.title) + '</option>').join('') +
            '</select><button class="btn small" type="button" data-add-skill>添加</button></div>'
          : '') +
        '<div class="modal-actions"><button class="btn ghost" data-close type="button">取消</button>' +
        '<button class="btn primary" data-start-agent type="button">用这名员工开始</button></div>'
      );
    };

    let closeFn = null;
    const mount = () => {
      if (closeFn) closeFn();
      closeFn = showModal(render(), { wide: true });
      const modal = closeFn.modal;
      const refresh = () => {
        mount();
        renderAgentsPage();
      };
      modal.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.remove;
          if (await saveAgentSkills(agent, (agent.skills || []).filter((x) => x !== id))) refresh();
        });
      });
      const addBtn = modal.querySelector('[data-add-skill]');
      if (addBtn) {
        addBtn.addEventListener('click', async () => {
          const sel = modal.querySelector('#agentAddSkill');
          if (!sel || !sel.value) return;
          if (await saveAgentSkills(agent, [...(agent.skills || []), sel.value])) refresh();
        });
      }
      modal.querySelector('[data-start-agent]').addEventListener('click', () => {
        closeFn();
        startAgent(agent);
      });
    };
    mount();
    void skills;
    void rest;
  }

  function startAgent(agent) {
    newChat();
    state.agent = agent;
    state.skill = null;
    showView('chat');
    updateSkillUI();
    const input = $('#input');
    if (input) input.focus();
  }

  // ---------------- 输入框里 @ 员工 ----------------

  function atQuery() {
    const input = $('#input');
    if (!input) return null;
    const upto = input.value.slice(0, input.selectionStart || 0);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return m[1].toLowerCase();
  }

  function renderAtMenu(query) {
    const menu = $('#atMenu');
    if (!menu) return;
    const list = state.agents.filter((a) => {
      if (!query) return true;
      const hay = (a.title + ' ' + (a.role || '') + ' ' + (a.tagline || '')).toLowerCase();
      return hay.indexOf(query) >= 0;
    });
    if (!list.length) {
      closeAtMenu();
      return;
    }
    menu.innerHTML =
      '<div class="at-title">和谁对话</div>' +
      list
        .map(
          (a) =>
            '<button class="at-item" type="button" data-at="' + esc(a.id) + '">' +
            (a.avatar
              ? '<img src="/api/agent/avatar?id=' + encodeURIComponent(a.id) + '" alt="">'
              : '<span class="at-emoji">' + esc(a.icon || '') + '</span>') +
            '<span class="at-main"><b>' + esc(a.title) + '</b><small>' + esc(a.tagline || '') + '</small></span>' +
            '</button>'
        )
        .join('');
    menu.classList.remove('hidden');
    menu.querySelectorAll('[data-at]').forEach((btn) => {
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pickAgent(btn.dataset.at);
      });
    });
    setAtActive(0);
  }

  function openSkillPicker() {
    const menu = $('#atMenu');
    if (!menu) return;
    const groups = [];
    for (const skill of state.skills) {
      if (!groups.includes(skill.group)) groups.push(skill.group);
    }
    let html = '<div class="at-title">用哪个技能</div>';
    for (const g of groups) {
      html += '<div class="at-group">' + esc(g) + '</div>';
      for (const skill of state.skills.filter((x) => x.group === g)) {
        html +=
          '<button class="at-item" type="button" data-skill="' + esc(skill.id) + '">' +
          '<span class="at-emoji">◇</span>' +
          '<span class="at-main"><b>' + esc(skill.title) + '</b><small>' +
          esc(skill.tagline || skill.description || '') + '</small></span></button>';
      }
    }
    menu.innerHTML = html;
    menu.classList.remove('hidden');
    menu.querySelectorAll('[data-skill]').forEach((btn) => {
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        const skill = state.skills.find((x) => x.id === btn.dataset.skill);
        if (!skill) return;
        state.skill = skill;
        closeAtMenu();
        updateSkillUI();
      });
    });
    setAtActive(0);
  }

  // @ 菜单的键盘选中项
  let atActive = 0;

  function atItems() {
    const menu = $('#atMenu');
    if (!menu || menu.classList.contains('hidden')) return [];
    return [...menu.querySelectorAll('.at-item')];
  }

  function setAtActive(index) {
    const items = atItems();
    if (!items.length) return;
    atActive = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((el, i) => el.classList.toggle('active', i === atActive));
    const cur = items[atActive];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function pickAtActive() {
    const items = atItems();
    if (!items.length) return false;
    const el = items[Math.max(0, Math.min(items.length - 1, atActive))];
    if (!el) return false;
    // 两个菜单都是监听 mousedown 触发的
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  }

  function closeAtMenu() {
    const menu = $('#atMenu');
    if (menu) menu.classList.add('hidden');
    atActive = 0;
  }

  function pickAgent(id) {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return;
    const input = $('#input');
    if (input) {
      const upto = input.value.slice(0, input.selectionStart || 0);
      const rest = input.value.slice(input.selectionStart || 0);
      const before = upto.replace(/(^|\s)@([^\s@]*)$/, '$1');
      input.value = before + rest;
      input.selectionStart = input.selectionEnd = before.length;
    }
    state.agent = agent;
    closeAtMenu();
    updateSkillUI();
    if (input) input.focus();
  }
  // ---------------- 导航玻璃胶囊 ----------------

  const navGlassState = { last: null, raf: 0 };

  function navGlassPrefersReduced() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function placeNavGlass(animate) {
    const el = document.getElementById('navGlass');
    const nav = document.getElementById('sideNav');
    if (!el || !nav) return;
    const active = nav.querySelector('.nav-item.active');
    if (!active) {
      el.classList.remove('ready');
      navGlassState.last = null;
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const next = {
      x: Math.round(rect.left - navRect.left),
      y: Math.round(rect.top - navRect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
    const last = navGlassState.last;

    el.style.width = next.w + 'px';
    el.style.height = next.h + 'px';
    el.style.transform = 'translate3d(' + next.x + 'px, ' + next.y + 'px, 0)';
    el.classList.add('ready');

    if (animate && last && (last.x !== next.x || last.y !== next.y) && !navGlassPrefersReduced()) {
      const dx = next.x - last.x;
      const dy = next.y - last.y;
      const vertical = Math.abs(dy) >= Math.abs(dx);
      const dist = vertical ? Math.abs(dy) : Math.abs(dx);
      const size = vertical ? last.h : last.w;
      const stretch = 1 + Math.min(0.28, (dist / Math.max(40, size)) * 0.28);

      // 锚在出发那一侧：往下走钉住上边，往右走钉住左边
      el.style.transformOrigin = vertical
        ? dy > 0
          ? '50% 0%'
          : '50% 100%'
        : dx > 0
          ? '0% 50%'
          : '100% 50%';

      const sx = vertical ? 1 : stretch;
      const sy = vertical ? stretch : 1;
      const frames = [
        {
          transform: 'translate3d(' + last.x + 'px, ' + last.y + 'px, 0) scale(1, 1)',
          width: last.w + 'px',
          height: last.h + 'px',
          offset: 0,
        },
        {
          transform: 'translate3d(' + next.x + 'px, ' + next.y + 'px, 0) scale(' + sx + ', ' + sy + ')',
          width: next.w + 'px',
          height: next.h + 'px',
          offset: 0.62,
        },
        {
          transform:
            'translate3d(' +
            next.x +
            'px, ' +
            next.y +
            'px, 0) scale(' +
            (vertical ? 1 : 0.965) +
            ', ' +
            (vertical ? 0.965 : 1) +
            ')',
          width: next.w + 'px',
          height: next.h + 'px',
          offset: 0.82,
        },
        {
          transform: 'translate3d(' + next.x + 'px, ' + next.y + 'px, 0) scale(1, 1)',
          width: next.w + 'px',
          height: next.h + 'px',
          offset: 1,
        },
      ];
      try {
        const anim = el.animate(frames, { duration: 470, easing: 'cubic-bezier(.22,.9,.32,1)' });
        anim.onfinish = () => {
          el.style.transformOrigin = '';
        };
      } catch {
        /* 不支持 WAAPI 就直接落位 */
      }
    }

    navGlassState.last = next;
  }

  function scheduleNavGlass(animate = true) {
    if (navGlassState.raf) cancelAnimationFrame(navGlassState.raf);
    navGlassState.raf = requestAnimationFrame(() => {
      navGlassState.raf = 0;
      placeNavGlass(animate);
    });
  }

  function showView(view) {
    state.view = view;
    $('#chatView').classList.toggle('hidden', view !== 'chat');
    $('#skillsView').classList.toggle('hidden', view !== 'skills');
    $('#agentsView').classList.toggle('hidden', view !== 'agents');
    $('#mcpView').classList.toggle('hidden', view !== 'mcp');
    $('#outputsView').classList.toggle('hidden', view !== 'outputs');
    const kbv = $('#knowledgeView');
    if (kbv) kbv.classList.toggle('hidden', view !== 'knowledge');
    $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
    scheduleNavGlass();
    if (view === 'chat') {
      $('#chatTitle').textContent = state.session && state.session.title ? state.session.title : '新对话';
      updateSkillUI();
    } else if (view === 'skills') {
      $('#chatTitle').textContent = '技能库';
      updateSkillUI();
      renderSkillFilters();
      renderSkillsPage();
    } else if (view === 'agents') {
      $('#chatTitle').textContent = '员工';
      renderAgentsPage();
      updateSkillUI();
      renderSkillFilters();
      renderSkillsPage();
    } else if (view === 'knowledge') {
      $('#chatTitle').textContent = '知识库';
      bindKnowledge();
      loadKnowledge();
    } else if (view === 'mcp') {
      $('#chatTitle').textContent = '数据源';
      updateSkillUI();
      renderMcpPage();
    } else {
      $('#chatTitle').textContent = '内容产出';
      updateSkillUI();
      renderOutputsPage();
      loadOutputs();
    }
    closeSidebar();
  }

  function mcpHost(url) {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  function applyMcpSummary(summary) {
    if (summary) state.mcp = summary;
    renderNavCounts();
    if (state.view === 'mcp') renderMcpPage();
  }

  async function apiMcpSave(payload) {
    const resp = await fetch('/api/mcp/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || '保存失败');
    applyMcpSummary(data.summary);
    return data.server;
  }

  async function apiMcpTest(id) {
    const resp = await fetch('/api/mcp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await resp.json();
    applyMcpSummary(data.summary);
    if (!data.ok) throw new Error(data.error || '连接失败');
    return data.server;
  }

  function renderMcpPage() {
    const box = $('#mcpList');
    if (!box) return;
    const servers = (state.mcp && state.mcp.servers) || [];
    box.innerHTML = '';
    if (!servers.length) {
      const empty = document.createElement('div');
      empty.className = 'skill-empty';
      empty.textContent = '还没有数据源';
      box.append(empty);
      return;
    }
    for (const s of servers) {
      const card = document.createElement('div');
      card.className = 'mcp-card';
      let statusText = '未测试';
      let statusClass = '';
      if (s.status === 'ok') {
        statusText = s.enabled ? '已连接' : '已连接 · 已停用';
        statusClass = 'ok';
      } else if (s.status === 'error') {
        statusText = '连接失败';
        statusClass = 'error';
      }
      const host = s.url ? mcpHost(s.url) : '未配置地址';
      const toolCount = Array.isArray(s.tools) ? s.tools.length : 0;
      card.innerHTML =
        '<div class="mcp-card-head"><span class="mcp-mark">' + esc(s.mark || 'MCP') + '</span>' +
        '<div class="mcp-title"><b>' + esc(s.name) + '</b><small>' + esc(s.note || '自定义 MCP 服务') + '</small></div>' +
        '<span class="mcp-status ' + statusClass + '">' + esc(statusText) + '</span></div>' +
        '<div class="mcp-meta"><span>' + esc(host) + '</span><span>' + toolCount + ' 个工具</span></div>' +
        (s.lastError ? '<div class="mcp-error">' + esc(s.lastError) + '</div>' : '') +
        '<div class="mcp-actions"><button class="btn" data-act="config" type="button">配置</button>' +
        '<button class="btn" data-act="test" type="button"' + (s.url ? '' : ' disabled') + '>测试连接</button>' +
        (s.preset === 'lingxing' ? '<button class="link-btn" data-act="help" type="button">帮助</button>' : '') +
        '<span class="spacer"></span><label class="mcp-toggle"><input type="checkbox" data-act="enabled"' + (s.enabled ? ' checked' : '') + '> 启用</label></div>';

      card.querySelector('[data-act="config"]').addEventListener('click', () => openMcpModal(s));
      const helpBtn = card.querySelector('[data-act="help"]');
      if (helpBtn) helpBtn.addEventListener('click', () => openLingxingHelp(false));
      card.querySelector('[data-act="test"]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '测试中…';
        try {
          await apiMcpTest(s.id);
          toast('连接成功，已读取工具列表');
        } catch (err) {
          toast(err.message, true);
        } finally {
          btn.disabled = false;
          btn.textContent = old;
          renderMcpPage();
        }
      });
      card.querySelector('[data-act="enabled"]').addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        try {
          await apiMcpSave({ id: s.id, enabled });
          renderMcpPage();
        } catch (err) {
          e.target.checked = !enabled;
          toast(err.message, true);
        }
      });
      box.append(card);
    }
  }

  function openMcpModal(server) {
    const isNew = !server;
    const s = server || {
      id: '',
      preset: 'custom',
      name: '自定义 MCP',
      mark: 'MCP',
      note: '自定义 MCP 服务',
      url: '',
      authMode: 'bearer',
      token: '',
      keyParam: 'key',
      headers: {},
      enabled: true,
      status: 'untested',
      tools: [],
    };
    const html =
      '<div class="modal-head"><div><h2>' + (isNew ? '添加数据源' : '配置 ' + esc(s.name)) + '</h2>' +
      '<p>填写服务商提供的 MCP 地址和 Key。保存后点「保存并测试」读取工具列表。<br><span class="mcp-form-help">每个数据源的地址和 Key 各不相同；浏览器有时会自动填入上一个数据源的内容，填之前核对一下。</span></p></div>' +
      '<div class="modal-head-actions">' +
      (s.preset === 'lingxing' ? '<button class="link-btn" id="mcpHelp" type="button">帮助</button>' : '') +
      '<button class="modal-close" data-close type="button">×</button></div></div>' +
      '<div class="field"><label>名称</label><input type="text" id="mcpName" value="' + esc(s.name) + '" placeholder="例如：领星 ERP" autocomplete="off" data-lpignore="true"></div>' +
      '<div class="field"><label>MCP 地址</label><input type="text" id="mcpUrl" value="' + esc(s.url || '') + '" placeholder="https://mcp.example.com 或 https://...?secret-key=xxx" spellcheck="false" autocomplete="off" autocorrect="off" data-lpignore="true" data-1p-ignore>' +
      '<div class="mcp-form-help" id="mcpUrlHint">带密钥的整段网址可以直接粘进来，会自动拆出来。</div></div>' +
      '<div class="field"><label>密钥</label><input type="password" id="mcpToken" value="' + esc(s.token || '') + '" placeholder="服务商给的那串字符" autocomplete="new-password" data-lpignore="true" data-1p-ignore data-form-type="other">' +
      '<div class="mcp-form-help" id="mcpTokenHint">地址里已经带密钥的，这里留空即可。</div></div>' +
      '<details class="mcp-advanced"><summary>高级（一般不用动）</summary>' +
      '<div class="form-grid">' +
      '<div class="field"><label>认证方式</label><select id="mcpAuth">' +
      '<option value="bearer"' + (s.authMode === 'bearer' ? ' selected' : '') + '>钥匙在密钥框里（Bearer）</option>' +
      '<option value="query"' + (s.authMode === 'query' ? ' selected' : '') + '>钥匙在网址里（URL 参数）</option>' +
      '<option value="headers"' + (s.authMode === 'headers' ? ' selected' : '') + '>钥匙在自定义 Headers 里</option>' +
      '</select></div>' +
      '<div class="field" id="mcpKeyParamField"><label>URL 参数名</label><input type="text" id="mcpKeyParam" value="' + esc(s.keyParam || 'key') + '" placeholder="key"></div>' +
      '</div>' +
      '<div class="field"><label>附加 Headers（JSON）</label><textarea id="mcpHeaders" rows="2" spellcheck="false">' + esc(JSON.stringify(s.headers || {}, null, 2)) + '</textarea><div class="mcp-form-help">只有服务商要求特殊请求头时才用，一般留 {}。</div></div>' +
      '</details>' +
      '<label class="switch"><input type="checkbox" id="mcpEnabled"' + (s.enabled ? ' checked' : '') + '> 启用这个数据源</label>' +
      '<div class="mcp-test-state" id="mcpTestState"></div>' +
      '<div class="mcp-tools" id="mcpTools"></div>' +
      '<div class="modal-actions"><span class="left">' +
      (!isNew ? '<button class="btn danger" id="mcpDelete" type="button">' + (s.preset && s.preset !== 'custom' ? '清除配置' : '删除') + '</button>' : '') +
      '</span><button class="btn ghost" data-close type="button">取消</button>' +
      '<button class="btn" id="mcpSave" type="button">保存</button>' +
      '<button class="btn primary" id="mcpSaveTest" type="button">保存并测试</button></div>';

    const close = showModal(html, { wide: true });
    const modal = close.modal;

    // 浏览器（Chrome 密码管理器 / 表单历史）会按"网站"自动填充，不区分是哪个数据源，
    // 同一个 127.0.0.1:7861 下就会把 SIF 的 Key 填到卖家精灵的表单里。
    // 这里在挂载后把我们自己的值再写一遍，覆盖掉自动填充。
    setTimeout(() => {
      const urlEl = modal.querySelector('#mcpUrl');
      const tokenEl = modal.querySelector('#mcpToken');
      if (urlEl) urlEl.value = s.url || '';
      if (tokenEl) tokenEl.value = s.token || '';
    }, 0);
    // ---- 地址里带密钥的（SIF / Sorftime），自动拆出来 ----
    const KEY_PARAMS = ['secret-key', 'secret_key', 'key', 'token', 'api_key', 'apikey'];
    const splitKeyFromUrl = (value) => {
      let u;
      try {
        u = new URL(value);
      } catch {
        return null;
      }
      for (const name of KEY_PARAMS) {
        const v = u.searchParams.get(name);
        if (v) {
          u.searchParams.delete(name);
          return { key: v, param: name, cleanUrl: u.toString() };
        }
      }
      return null;
    };
    const urlEl = modal.querySelector('#mcpUrl');
    const tokenEl = modal.querySelector('#mcpToken');
    const authEl = modal.querySelector('#mcpAuth');
    const keyParamEl = modal.querySelector('#mcpKeyParam');
    const paramField = modal.querySelector('#mcpKeyParamField');
    const urlHint = modal.querySelector('#mcpUrlHint');
    const tokenHint = modal.querySelector('#mcpTokenHint');
    let userTouchedAuth = false;

    const refreshHints = () => {
      const split = splitKeyFromUrl(urlEl.value.trim());
      // 网址里带密钥 → 立刻回填密钥框（用户自己改过就不动）
      if (split && (!tokenEl.value.trim() || tokenEl.dataset.autoKey === '1')) {
        tokenEl.value = split.key;
        tokenEl.dataset.autoKey = '1';
      }
      if (!split && tokenEl.dataset.autoKey === '1') {
        tokenEl.value = '';
        delete tokenEl.dataset.autoKey;
      }
      if (urlHint) {
        urlHint.textContent = split
          ? '已从地址里识别到密钥（参数名 ' + split.param + '），不用再填密钥框'
          : '带密钥的整段网址可以直接粘进来，会自动拆出来。';
      }
      if (tokenHint) {
        tokenHint.textContent = split
          ? '地址里已经带密钥，这里留空即可'
          : '只填服务商给的那串字符：不要带 Bearer、引号、空格。';
      }
      if (split && !userTouchedAuth) {
        authEl.value = 'query';
        keyParamEl.value = split.param;
      }
      paramField.classList.toggle('hidden', authEl.value !== 'query');
    };

    tokenEl.addEventListener('input', () => {
      delete tokenEl.dataset.autoKey;
    });
    urlEl.addEventListener('input', refreshHints);
    urlEl.addEventListener('blur', () => {
      refreshHints();
    });
    authEl.addEventListener('change', () => {
      userTouchedAuth = true;
      paramField.classList.toggle('hidden', authEl.value !== 'query');
    });
    refreshHints();

    const helpBtn = modal.querySelector('#mcpHelp');
    if (helpBtn) helpBtn.addEventListener('click', () => openLingxingHelp(true));
    const renderTools = (tools) => {
      const box = modal.querySelector('#mcpTools');
      if (!tools || !tools.length) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = tools.map((t) => '<div class="mcp-tool"><b>' + esc(t.name) + '</b><span>' + esc((t.description || '').slice(0, 80)) + '</span></div>').join('');
    };
    renderTools(s.tools);

    const payload = () => {
      const headersText = modal.querySelector('#mcpHeaders').value.trim();
      let headers = {};
      if (headersText) {
        try {
          headers = JSON.parse(headersText);
        } catch {
          throw new Error('附加 Headers 不是合法 JSON');
        }
      }
      let url = modal.querySelector('#mcpUrl').value.trim();
      let token = modal.querySelector('#mcpToken').value.trim();
      let authMode = modal.querySelector('#mcpAuth').value;
      let keyParam = modal.querySelector('#mcpKeyParam').value.trim() || 'key';

      // 地址里带密钥 → 拆成「干净地址 + 密钥」，统一存一份
      const split = splitKeyFromUrl(url);
      if (split && !userTouchedAuth) {
        url = split.cleanUrl;
        keyParam = split.param;
        if (!token) token = split.key;
        authMode = 'query';
      }
      // 没拆到、又填了密钥 → 按「密钥在框里」处理
      if (!split && token && authMode === 'query') {
        authMode = 'bearer';
      }
      if (!url) throw new Error('MCP 地址不能为空');
      if (!token && authMode !== 'query') throw new Error('密钥不能为空');

      return {
        id: s.id || undefined,
        preset: s.preset || 'custom',
        name: modal.querySelector('#mcpName').value.trim() || 'MCP',
        url,
        authMode,
        token,
        keyParam,
        headers,
        enabled: modal.querySelector('#mcpEnabled').checked,
      };
    };

    const setState = (text, kind) => {
      const el = modal.querySelector('#mcpTestState');
      el.className = 'mcp-test-state' + (kind ? ' ' + kind : '');
      el.textContent = text || '';
    };

    modal.querySelector('#mcpSave').addEventListener('click', async () => {
      try {
        await apiMcpSave(payload());
        close();
        toast('数据源已保存');
      } catch (err) {
        setState(err.message, 'err');
      }
    });
    modal.querySelector('#mcpSaveTest').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      setState('正在连接…', '');
      try {
        const saved = await apiMcpSave(payload());
        const tested = await apiMcpTest(saved.id);
        renderTools(tested.tools);
        setState('连接成功，读取到 ' + tested.tools.length + ' 个工具', 'ok');
        toast('连接成功');
      } catch (err) {
        setState(err.message, 'err');
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
    const del = modal.querySelector('#mcpDelete');
    if (del) {
      del.addEventListener('click', async () => {
        const ok = await confirmDialog(del.textContent + '？', '会清除这个数据源的地址和 Key，不影响已生成的对话。', true);
        if (!ok) return;
        try {
          await fetch('/api/mcp/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id }),
          });
          const refreshed = await fetch('/api/mcp').then((r) => r.json());
          applyMcpSummary(refreshed);
          close();
          toast('已清除');
        } catch (err) {
          setState(err.message, 'err');
        }
      });
    }
  }

  function openLingxingHelp(fromConfig) {
    const url = 'https://openmcp.lingxing.com/mcp-servers/lingxing-mcp';
    const html =
      '<div class="modal-head"><div><h2>领星怎么填</h2><p>两个格子，粘完点「保存并测试」。</p></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      '<div class="mcp-help">' +
      '<div class="mcp-help-row"><div class="mcp-help-k">MCP 地址</div><div class="mcp-help-v">' +
      '<code id="lingxingHelpUrl">' + esc(url) + '</code>' +
      '<button class="link-btn" data-copy-target="lingxingHelpUrl" type="button">复制</button>' +
      '<small>原样粘贴，末尾别自己加 /mcp。</small></div></div>' +
      '<div class="mcp-help-row"><div class="mcp-help-k">密钥</div><div class="mcp-help-v">' +
      '<code>粘贴领星给你的那串字符</code>' +
      '<small>只填那串字符本身：<b>不要带 Bearer、引号、空格</b>，也不要把「访问密钥：」这种标签一起粘进来。</small></div></div>' +
      '</div>' +
      '<div class="mcp-help-note"><b>成功的样子：</b>弹窗底部出现「连接成功，读取到 4 个工具」，卡片变「已连接」。<br>' +
      '<b>返回「MCP Key无效」：</b>密钥不完整，重新复制一次（64 位）。<br>' +
      '<b>其他服务商：</b>如果给你的是一条<b>带密钥的网址</b>（形如 <code>...?key=xxx</code>），直接把整条粘进「MCP 地址」就行，密钥框留空——会自动拆出来。</div>' +
      '<div class="modal-actions">' +
      (fromConfig ? '' : '<button class="btn" id="lingxingGo" type="button">去配置</button>') +
      '<button class="btn primary" data-close type="button">知道了</button></div>';

    const close = showModal(html, { wide: true });
    const modal = close.modal;
    modal.querySelectorAll('[data-copy-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = modal.querySelector('#' + btn.dataset.copyTarget);
        if (!el) return;
        copyText(el.textContent);
      });
    });
    const go = modal.querySelector('#lingxingGo');
    if (go) {
      go.addEventListener('click', () => {
        close();
        const server = (state.mcp.servers || []).find((x) => x.preset === 'lingxing');
        if (server) openMcpModal(server);
      });
    }
  }

  function renderSessions() {
    const box = $('#sessionList');
    box.innerHTML = '';
    if (!state.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-hint';
      empty.textContent = '还没有对话';
      box.append(empty);
      return;
    }
    for (const s of state.sessions.slice(0, 40)) {
      const item = document.createElement('div');
      item.className = 'session-item';
      if (state.session && state.session.id === s.id) item.classList.add('active');
      const title = document.createElement('span');
      title.className = 't';
      title.textContent = s.title || '新对话';
      title.title = (s.title || '') + ' · ' + timeAgo(s.updatedAt);
      if (s.pinned) {
        const pin = document.createElement('span');
        pin.className = 'session-pin';
        pin.title = '已置顶';
        pin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 4h6l-1 6 3.5 3.5H6.5L10 10 9 4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M12 13.5V21" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
        item.append(pin);
      }
      const more = document.createElement('button');
      more.className = 'more';
      more.type = 'button';
      more.title = '更多';
      more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        openSessionMenu(more, s);
      });
      item.append(title, more);
      item.addEventListener('click', () => openSession(s.id));
      box.append(item);
    }
  }

  let sessionMenuEl = null;

  function closeSessionMenu() {
    if (sessionMenuEl) {
      sessionMenuEl.remove();
      sessionMenuEl = null;
    }
  }

  function openSessionMenu(anchorEl, s) {
    closeSessionMenu();
    const menu = document.createElement('div');
    menu.className = 'session-menu';
    const icon = {
      edit: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M13.5 5.5 18 10" stroke="currentColor" stroke-width="1.5"/></svg>',
      pin: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 4h6l-1 6 3.5 3.5H6.5L10 10 9 4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 13.5V21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      del: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    };
    menu.innerHTML =
      '<button type="button" data-act="rename">' + icon.edit + '编辑标题</button>' +
      '<button type="button" data-act="pin">' + icon.pin + (s.pinned ? '取消置顶' : '置顶') + '</button>' +
      '<button type="button" data-act="del" class="danger">' + icon.del + '删除</button>';
    document.body.append(menu);
    sessionMenuEl = menu;

    const rect = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth || 148;
    const mh = menu.offsetHeight || 120;
    let left = rect.right - mw;
    let top = rect.bottom + 6;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
    menu.style.left = left + 'px';
    menu.style.top = Math.max(8, top) + 'px';

    const close = (e) => {
      if (e && menu.contains(e.target)) return;
      closeSessionMenu();
      document.removeEventListener('mousedown', close);
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);

    menu.querySelector('[data-act="rename"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      close(null);
      const name = await promptDialog('编辑标题', s.title || '');
      if (name === null) return;
      const clean = name.trim().slice(0, 80);
      if (!clean || clean === s.title) return;
      await fetch('/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, title: clean }),
      });
      s.title = clean;
      if (state.session && state.session.id === s.id) state.session.title = clean;
      if (state.view === 'chat') $('#chatTitle').textContent = state.session && state.session.id === s.id ? clean : $('#chatTitle').textContent;
      renderSessions();
      toast('标题已改');
    });

    menu.querySelector('[data-act="pin"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      close(null);
      const next = !s.pinned;
      await fetch('/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, pinned: next }),
      });
      s.pinned = next;
      sortSessions();
      renderSessions();
      toast(next ? '已置顶' : '已取消置顶');
    });

    menu.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      close(null);
      const ok = await confirmDialog('删除这个对话？', '对话记录会从本机删除，已生成的文件不受影响。', true);
      if (!ok) return;
      await fetch('/api/session?id=' + encodeURIComponent(s.id), { method: 'DELETE' });
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      if (state.session && state.session.id === s.id) newChat();
      renderSessions();
      toast('已删除');
    });
  }

  function sortSessions() {
    state.sessions.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  function promptDialog(title, value) {
    return new Promise((resolve) => {
      const html =
        '<div class="modal-head"><div><h2>' + esc(title) + '</h2></div></div>' +
        '<div class="cfg-form"><input type="text" id="pdInput" value="' + esc(value || '') + '" maxlength="80" spellcheck="false"></div>' +
        '<div class="modal-actions"><button class="btn ghost" data-close type="button">取消</button>' +
        '<button class="btn primary" data-ok type="button">保存</button></div>';
      const close = showModal(html, { narrow: true });
      const modal = close.modal;
      const input = modal.querySelector('#pdInput');
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      setTimeout(() => {
        input.focus();
        input.select();
      }, 30);
      modal.querySelector('[data-ok]').addEventListener('click', () => {
        const v = input.value;
        close();
        done(v);
      });
      modal.querySelector('[data-close]').addEventListener('click', () => {
        close();
        done(null);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value;
          close();
          done(v);
        }
        if (e.key === 'Escape') {
          close();
          done(null);
        }
      });
      close.overlay.addEventListener('click', (e) => {
        if (e.target === close.overlay) {
          close();
          done(null);
        }
      });
    });
  }

  function upsertSession(session, title) {
    if (!session || !session.id) return;
    const now = Date.now();
    let item = state.sessions.find((s) => s.id === session.id);
    if (!item) {
      item = { id: session.id, createdAt: now, updatedAt: now, skillId: session.skillId || null };
      state.sessions.unshift(item);
    }
    if (title) item.title = title;
    item.updatedAt = now;
    state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    renderSessions();
  }

  /* ================= 会话 ================= */

  function newChat(keepSkill) {
    if (state.streaming) {
      toast('正在生成，先点停止');
      return;
    }
    state.session = null;
    state.messages = [];
    state.skill = keepSkill ? state.skill : null;
    state.agent = keepSkill ? state.agent : null;
    state.live = null;
    $('#messages').innerHTML = '';
    showView('chat');
    $('#chatTitle').textContent = '新对话';
    $('#input').value = '';
    autoGrow();
    updateSkillUI();
    toggleWelcome();
    renderSessions();
    closeSidebar();
    setTimeout(() => $('#input').focus(), 30);
    $('#chat').scrollTop = 0;
  }

  async function openSession(id) {
    if (state.streaming) {
      toast('正在生成，先点停止');
      return;
    }
    try {
      const resp = await fetch('/api/session?id=' + encodeURIComponent(id));
      if (!resp.ok) throw new Error('加载失败');
      const session = await resp.json();
      state.session = session;
      state.messages = Array.isArray(session.ui) ? session.ui : [];
      state.skill = session.skillId ? state.skills.find((s) => s.id === session.skillId) || null : null;
    state.agent = session.agentId ? state.agents.find((a) => a.id === session.agentId) || null : null;
      $('#messages').innerHTML = '';
      state.live = null;
      for (const msg of state.messages) appendMessage(msg, false);
      showView('chat');
      $('#chatTitle').textContent = session.title || '新对话';
      updateSkillUI();
      toggleWelcome();
      renderSessions();
      closeSidebar();
      scrollToBottom(true);
    } catch (err) {
      toast(err.message || '加载失败', true);
    }
  }

  function toggleWelcome() {
    const empty = state.messages.length === 0;
    $('#welcome').classList.toggle('hidden', !empty);
  }

  /* ================= 消息渲染 ================= */

  function appendMessage(msg, live) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (msg.role === 'user' ? 'user' : 'assistant');
    wrap.dataset.id = msg.id || '';

    const avatar = document.createElement('div');
    avatar.className = 'avatar ' + (msg.role === 'user' ? 'me' : 'bot');
    if (msg.role === 'user') {
      avatar.textContent = '你';
    } else if (state.agent && state.agent.avatar) {
      avatar.classList.add('has-img');
      avatar.innerHTML = '<img src="/api/agent/avatar?id=' + encodeURIComponent(state.agent.id) + '" alt="">';
    } else {
      avatar.innerHTML = '<svg viewBox="0 0 32 32" fill="none"><path d="M9.5 20.5 15.2 12l3.2 4.2 2.1-2.6 3.9 6.9H9.5Z" fill="currentColor"/></svg>';
    }

    const body = document.createElement('div');
    body.className = 'msg-body';

    const refs = { wrap, body, streaming: Boolean(live) };

    if (msg.role === 'user') {
      const text = document.createElement('div');
      text.className = 'user-text';
      text.textContent = msg.text || '';
      body.append(text);
      if (Array.isArray(msg.files) && msg.files.length) {
        const files = document.createElement('div');
        files.className = 'attach-inline';
        for (const f of msg.files) {
          const sp = document.createElement('span');
          sp.textContent = '附件 · ' + f.name;
          files.append(sp);
        }
        body.append(files);
      }
      wrap.append(avatar, body);
      $('#messages').append(wrap);
      return refs;
    }

    const head = document.createElement('div');
    head.className = 'msg-head';
    if (msg.role !== 'user' && state.agent) {
      head.innerHTML =
        '<b>' + esc(state.agent.title) + '</b><span>· ' + esc(state.agent.role || '') + '</span>' +
        (state.skill ? '<span>· ' + esc(state.skill.title) + '</span>' : '');
    } else {
      head.innerHTML =
        '<b>' + esc(state.cfg ? state.cfg.brand : '跨境 AI 工作台') + '</b>' +
        (state.skill && live ? '<span>· ' + esc(state.skill.title) + '</span>' : '');
    }
    body.append(head);

    if (live) {
      const status = document.createElement('div');
      status.className = 'live-status';
      status.innerHTML = '<span class="spinner"></span><span class="ls-text">正在思考…</span>';
      body.append(status);
      refs.statusEl = status;
    }

    if (msg.reasoning) {
      refs.think = createThink(msg.reasoning, live);
      body.append(refs.think.el);
    }

    refs.toolsEl = document.createElement('div');
    refs.toolsEl.className = 'tool-steps';
    refs.toolsEl.style.display = 'none';
    body.append(refs.toolsEl);
    if (Array.isArray(msg.tools) && msg.tools.length) {
      refs.toolsEl.style.display = '';
      for (const t of msg.tools) {
        const row = document.createElement('div');
        row.className = 'tool-step ' + (t.status === 'error' ? 'err' : 'ok');
        row.innerHTML =
          '<span class="ts-ico">' + (t.status === 'error' ? '!' : '✓') + '</span>' +
          '<span class="ts-label"></span><span class="ts-ms"></span>';
        row.querySelector('.ts-label').textContent = t.summary || t.name;
        if (t.ms) row.querySelector('.ts-ms').textContent = t.ms < 1000 ? t.ms + 'ms' : (t.ms / 1000).toFixed(1) + 's';
        refs.toolsEl.append(row);
      }
    }

    if (msg.card && msg.card.kind === 'confirm') {
      const wrap = document.createElement('div');
      addRunConfirm({ filesEl: wrap }, msg.card);
      body.append(wrap);
    } else if (msg.card && msg.card.kind !== 'text') {
      body.append(runResultCardEl(msg.card));
    }

    const content = document.createElement('div');
    content.className = 'md' + (live ? ' streaming' : '');
    content.innerHTML = msg.text ? MD.render(msg.text) : '';
    if (!msg.text && !live) content.style.display = 'none';    body.append(content);
    refs.contentEl = content;

    refs.sourcesEl = document.createElement('div');
    refs.sourcesEl.className = 'sources';
    refs.sourcesEl.style.display = 'none';
    body.append(refs.sourcesEl);
    if (msg.sources && msg.sources.length) {
      for (const s of msg.sources) addSource(refs, s);
    }

    refs.filesEl = document.createElement('div');
    refs.filesEl.className = 'file-cards';
    refs.filesEl.style.display = 'none';
    body.append(refs.filesEl);
    if (msg.files && msg.files.length) {
      for (const f of msg.files) addFile(refs, f);
    }

    refs.metaEl = document.createElement('div');
    refs.metaEl.className = 'usage-line';
    if (msg.usage) refs.metaEl.textContent = usageText(msg.usage);
    body.append(refs.metaEl);

    if (msg.stopped) {
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = '这条回答被中断，未完整保存';
      body.insertBefore(n, refs.metaEl);
    }

    if (msg.text) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制';
      copy.addEventListener('click', () => copyText(msg.text));
      actions.append(copy);
      body.append(actions);
    }

    wrap.append(avatar, body);
    $('#messages').append(wrap);
    return refs;
  }

  function createThink(text, live) {
    const details = document.createElement('details');
    details.className = 'think' + (live ? ' live' : '');
    if (live) details.open = true;
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.className = 't-label';
    label.textContent = live ? '思考中…' : '思考过程';
    summary.append(label);
    const body = document.createElement('div');
    body.className = 'think-body';
    body.textContent = text || '';
    // 思考框自身有 340px 上限和滚动条：默认粘底，用户手动往上翻才停
    body.dataset.stick = '1';
    body.addEventListener(
      'scroll',
      () => {
        const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.dataset.stick = nearBottom ? '1' : '0';
      },
      { passive: true }
    );
    details.append(summary, body);
    return { el: details, body, label };
  }

  function ensureThink(refs, live) {
    if (!refs.think) {
      refs.think = createThink('', live);
      refs.body.insertBefore(refs.think.el, refs.toolsEl);
    }
    return refs.think;
  }

  function addTool(refs, ev) {
    refs.toolsEl.style.display = '';
    let row = refs.runningTool;
    if (!row) {
      row = document.createElement('div');
      row.className = 'tool-step';
      row.innerHTML =
        '<span class="ts-ico"><span class="spinner"></span></span>' +
        '<span class="ts-label"></span>' +
        '<span class="ts-ms"></span>';
      row.querySelector('.ts-label').textContent = ev.summary || ev.name;
      refs.toolsEl.append(row);
      if (ev.status === 'start') {
        refs.runningTool = row;
        return row;
      }
    }
    row.classList.add(ev.status === 'ok' ? 'ok' : 'err');
    const ico = row.querySelector('.ts-ico');
    ico.innerHTML = ev.status === 'ok' ? '✓' : '!';
    if (ev.ms) row.querySelector('.ts-ms').textContent = ev.ms < 1000 ? ev.ms + 'ms' : (ev.ms / 1000).toFixed(1) + 's';
    refs.runningTool = null;
    return row;
  }

  function addSource(refs, item) {
    if (!item || !item.url) return;
    const existing = Array.from(refs.sourcesEl.querySelectorAll('a')).some((a) => a.href === item.url);
    if (existing) return;
    refs.sourcesEl.dataset.pending = '1';
    if (!refs.streaming) refs.sourcesEl.style.display = '';
    if (!refs.sourcesEl.dataset.titled) {
      const title = document.createElement('div');
      title.className = 'sources-title';
      title.textContent = '参考来源';
      title.style.gridColumn = '1 / -1';
      title.style.margin = '0 0 2px';
      refs.sourcesEl.prepend(title);
      refs.sourcesEl.dataset.titled = '1';
    }
    const a = document.createElement('a');
    a.className = 'source';
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const site = item.site || hostOf(item.url);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = (site || '?').slice(0, 2).toUpperCase();
    const body = document.createElement('span');
    body.className = 's-body';
    const title = document.createElement('span');
    title.className = 's-title';
    title.textContent = item.title || item.url;
    const s = document.createElement('span');
    s.className = 's-site';
    s.textContent = site;
    body.append(title, s);
    a.append(dot, body);
    refs.sourcesEl.append(a);
  }

  function addFile(refs, file) {
    if (!file || !file.path) return;
    if (Array.from(refs.filesEl.querySelectorAll('.file-card')).some((n) => n.dataset.path === file.path)) return;
    refs.filesEl.dataset.pending = '1';
    if (!refs.streaming) refs.filesEl.style.display = '';
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.path = file.path;
    const ext = (file.name || file.path).split('.').pop().slice(0, 4).toUpperCase();
    const url = '/api/file?path=' + encodeURIComponent(file.path);
    card.innerHTML =
      '<span class="ext">' + esc(ext) + '</span>' +
      '<span class="f-meta"><span class="f-name"></span>' +
      '<span class="f-size">' + esc(formatSize(file.size)) + '</span>' +
      '<span class="f-actions"><a target="_blank" rel="noopener" href="' + url + '">打开</a>' +
      '<a href="' + url + '&download=1">下载</a></span></span>';
    card.querySelector('.f-name').textContent = file.name || file.path;
    refs.filesEl.append(card);
  }

  /** run.js 返回的 files 是相对路径字符串数组，统一成 {path,name} */
function toFileRef(f) {
  if (!f) return null;
  if (typeof f === 'string') return { path: f, name: f.split('/').pop() };
  const p = f.path || f.rel || '';
  return { path: p, name: f.name || p.split('/').pop() };
}

function runFileUrl(rel, download) {
  return '/api/file?' + (download ? 'download=1&' : '') + 'path=' + encodeURIComponent(rel);
}

function fmtDuration(ms) {
  const secs = Math.round((Number(ms) || 0) / 1000);
  if (secs < 60) return secs + ' 秒';
  const min = Math.floor(secs / 60);
  return min + ' 分 ' + (secs % 60) + ' 秒';
}

function notifyDone(title, body) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, { body: body, silent: false });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* 通知失败就算了 */
  }
}

function askNotifyPermission() {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
  } catch {
    /* 忽略 */
  }
}

/** 结果卡（历史里恢复时也用它） */
function runResultCardEl(card) {
  const el = document.createElement('div');
  el.className = 'run-card ' + (card.ok ? 'ok' : 'bad');
  const files = Array.isArray(card.files) ? card.files : [];
  const links = files.length
    ? '<div class="rc-files">' +
      files
        .map(
          (f) =>
            '<a class="rc-file" href="' + runFileUrl(f.path, false) + '" target="_blank" rel="noopener">' +
            esc(f.name || f.path) +
            '</a>'
        )
        .join('') +
      '</div>'
    : '';
  el.innerHTML =
    '<div class="rc-head"><span class="rc-tag' + (card.ok ? ' ok' : ' bad') + '">' +
    (card.ok ? '已完成' : '没跑成') +
    '</span><span class="rc-title">' +
    esc(card.skillTitle || card.skillId || '') +
    ' · ' +
    esc(card.label || '') +
    '</span>' +
    (card.ms ? '<span class="rc-ms">' + fmtDuration(card.ms) + '</span>' : '') +
    '</div>' +
    (card.error ? '<div class="rc-note bad">' + esc(card.error) + '</div>' : '') +
    links;
  return el;
}

/** 对话里弹出的「确认运行」卡：点了才真跑，跑的过程和结果都在这张卡里 */
function addRunConfirm(refs, ev) {
  if (!refs || !refs.filesEl) return;
  const card = document.createElement('div');
  card.className = 'run-card confirm';
  card.innerHTML =
    '<div class="rc-head"><span class="rc-tag">待确认</span>' +
    '<span class="rc-title">' + esc(ev.skillTitle || ev.skillId || '') + ' · ' + esc(ev.label || '运行') + '</span></div>' +
    (ev.reason ? '<div class="rc-note">' + esc(ev.reason) + '</div>' : '') +
    '<div class="rc-note dim">跑起来会花几分钟，期间可以切走；跑完这里会变成结果卡，也会发系统通知。</div>' +
    '<div class="rc-actions"><button class="btn small primary" type="button" data-run>确认运行</button>' +
    '<button class="btn small ghost" type="button" data-skip>取消</button></div>';
  refs.filesEl.style.display = '';
  refs.filesEl.append(card);

  const finish = (text, ok) => {
    card.className = 'run-card ' + (ok ? 'ok' : 'bad');
    card.innerHTML =
      '<div class="rc-head"><span class="rc-tag' + (ok ? ' ok' : ' bad') + '">' +
      (ok ? '已提交' : '已取消') +
      '</span><span class="rc-title">' + esc(ev.skillTitle || '') + ' · ' + esc(ev.label || '') + '</span></div>' +
      '<div class="rc-note">' + esc(text) + '</div>';
  };

  card.querySelector('[data-skip]').addEventListener('click', () => finish('没有运行，什么都没改。', false));

  card.querySelector('[data-run]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '启动中…';
    askNotifyPermission();
    try {
      const resp = await fetch('/api/skill/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmId: ev.id,
          sessionId: state.session ? state.session.id : null,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        finish('没跑起来：' + (data.error || '未知错误'), false);
        return;
      }
      runCardLive(card, ev, data);
    } catch (err) {
      finish('没跑起来：' + err.message, false);
    }
  });
}

/** 轮询托管的运行，把进度写进卡里 */
async function runCardLive(card, ev, started) {
  const runId = started.runId;
  const label = started.label || ev.label || '运行';
  const title = started.skillTitle || ev.skillTitle || '';
  let cursor = 0;
  const t0 = Date.now();
  const lines = [];

  const paint = () => {
    card.className = 'run-card running';
    card.innerHTML =
      '<div class="rc-head"><span class="rc-tag live">运行中</span>' +
      '<span class="rc-title">' + esc(title) + ' · ' + esc(label) + '</span>' +
      '<span class="rc-ms">' + fmtDuration(Date.now() - t0) + '</span></div>' +
      '<pre class="rc-log">' + esc(lines.slice(-5).join('\n')) + '</pre>' +
      '<div class="rc-actions"><button class="btn small ghost" type="button" data-cancel>取消运行</button></div>';
    card.querySelector('[data-cancel]').addEventListener('click', async () => {
      try {
        await fetch('/api/skill/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: runId }),
        });
      } catch {
        /* 忽略 */
      }
    });
  };
  paint();

  const poll = async () => {
    let st;
    try {
      const resp = await fetch('/api/skill/runstate?id=' + encodeURIComponent(runId) + '&cursor=' + cursor);
      st = await resp.json();
    } catch {
      st = null;
    }
    if (!st || !st.ok) {
      setTimeout(poll, 2000);
      return;
    }
    cursor = st.cursor || cursor;
    for (const line of st.lines || []) lines.push(line.text);
    if (st.status === 'running') {
      paint();
      setTimeout(poll, 1500);
      return;
    }

    // 收尾
    const ms = Date.now() - t0;
    const ok = st.status === 'done';
    const files = (st.files || []).map(toFileRef).filter(Boolean);
    const payload = {
      ok,
      skillId: st.skillId,
      skillTitle: title,
      label,
      ms,
      error: st.error || null,
      files,
    };
    const el = runResultCardEl(payload);
    card.className = 'run-card ' + (ok ? 'ok' : 'bad');
    card.innerHTML = '';
    card.append(el);
    if (!ok && lines.length) {
      const log = document.createElement('pre');
      log.className = 'rc-log';
      log.textContent = lines.slice(-12).join('\n');
      card.append(log);
    }

    if (document.hidden) {
      notifyDone(title + (ok ? ' 跑完了' : ' 没跑成'), (files[0] && files[0].name) || label);
    }

    // 落到会话历史里，刷新后还在
    if (state.session && state.session.id) {
      fetch('/api/session/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.session.id,
          message: {
            role: 'assistant',
            text: '',
            card: payload,
          },
        }),
      }).catch(() => {});
      if (Array.isArray(state.session.messages)) {
        state.session.messages.push({ role: 'assistant', text: '', card: payload, ts: Date.now() });
      }
    }
  };
  setTimeout(poll, 1200);
}

function addConfigProposal(refs, ev) {
    if (!refs || !refs.filesEl) return;
    const card = document.createElement('div');
    card.className = 'cfg-proposal';
    const lines = Array.isArray(ev.diff) ? ev.diff : [];
    card.innerHTML =
      '<div class="cp-head"><span class="cp-tag">配置改动</span>' +
      '<span class="cp-skill">' + esc(ev.skillTitle || ev.skillId || '') + '</span></div>' +
      (ev.note ? '<div class="cp-note">' + esc(ev.note) + '</div>' : '') +
      (lines.length
        ? '<ul class="cp-list">' + lines.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
        : '<div class="cp-note">和当前配置没有差异</div>') +
      '<div class="cp-actions"><button class="btn small primary" type="button" data-apply>应用</button>' +
      '<button class="btn small ghost" type="button" data-cancel>取消</button></div>';
    refs.filesEl.style.display = '';
    refs.filesEl.append(card);

    const done = (text, ok) => {
      card.innerHTML = '<div class="cp-head"><span class="cp-tag' + (ok ? ' ok' : ' bad') + '">配置' + (ok ? '已写入' : '未应用') + '</span>' +
        '<span class="cp-skill">' + esc(ev.skillTitle || ev.skillId || '') + '</span></div>' +
        '<div class="cp-note">' + esc(text) + '</div>';
    };

    card.querySelector('[data-cancel]').addEventListener('click', () => done('已取消，配置没有改动。', false));
    card.querySelector('[data-apply]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '写入中…';
      try {
        const resp = await fetch('/api/skill/config/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposalId: ev.id }),
        });
        const data = await resp.json();
        if (!data.ok) {
          done('没写进去：' + (data.error || '未知错误') + '。可以让助手重新提交一次。', false);
          return;
        }
        done('已写入。点技能里的「① 生成本周周报」重新出报告即生效。', true);
      } catch (err) {
        done('没写进去：' + err.message, false);
      }
    });
  }

  function usageText(u) {
    const parts = [];
    if (u.input) parts.push('输入 ' + fmtNum(u.input));
    if (u.output) parts.push('输出 ' + fmtNum(u.output));
    if (u.cached) parts.push('缓存 ' + fmtNum(u.cached));
    return parts.length ? '本次用量：' + parts.join(' · ') : '';
  }

  /* ================= 发送 ================= */

  async function send() {
    if (state.streaming) return;
    const input = $('#input');
    const text = input.value.trim();
    const files = state.attachments.filter((a) => a.id && a.status === 'ready').map((a) => ({ id: a.id }));
    if (!text && !files.length) {
      input.focus();
      return;
    }
    if (!state.settings.key) {
      showOnboarding();
      return;
    }

    const skill = state.skill;
    const userMsg = {
      id: 'local-' + Date.now(),
      role: 'user',
      text,
      files: state.attachments.filter((a) => a.id && a.status === 'ready').map((a) => ({ name: a.name, size: a.size })),
      createdAt: Date.now(),
    };
    const assistantMsg = {
      id: 'local-a-' + Date.now(),
      role: 'assistant',
      text: '',
      reasoning: '',
      tools: [],
      sources: [],
      files: [],
      createdAt: Date.now(),
    };

    const savedAttachments = state.attachments.slice();
    if (state.attachments.some((a) => a.status === 'uploading')) {
      toast('附件还在上传，稍等一下再发', true);
      return;
    }
    state.messages.push(userMsg, assistantMsg);
    toggleWelcome();
    appendMessage(userMsg, false);
    const refs = appendMessage(assistantMsg, true);

    input.value = '';
    autoGrow();
    state.attachments = [];
    renderAttachments();
    scrollToBottom();
    setStreaming(true);

    const live = {
      msg: assistantMsg,
      refs,
      renderScheduled: false,
      startedAt: Date.now(),
      firstText: false,
      thinkStartedAt: 0,
    };
    state.live = live;

    const controller = new AbortController();
    state.controller = controller;
    state.abortedByUser = false;

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': state.settings.key },
        body: JSON.stringify({
          sessionId: state.session ? state.session.id : null,
          text,
          files,
          skillId: skill ? skill.id : null,
          agentId: state.agent ? state.agent.id : null,
          options: { thinking: Boolean(state.settings.thinking), search: Boolean(state.settings.search) },
          model: state.settings.model,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        let message = '请求失败（HTTP ' + resp.status + '）';
        try {
          const j = await resp.json();
          message = j.error || message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      if (!resp.body) throw new Error('没有收到服务器的数据');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          handleEvent(ev, live);
        }
      }
    } catch (err) {
      if (state.abortedByUser || (err && err.name === 'AbortError')) {
        finishAborted(live);
      } else {
        rollback(userMsg, assistantMsg, savedAttachments, err);
      }
    } finally {
      if (state.streaming) {
        setStreaming(false);
      }
      state.live = null;
    }
  }

  function handleEvent(ev, live) {
    const refs = live.refs;
    switch (ev.t) {
      case 'session': {
        if (!state.session) {
          state.session = { id: ev.id, title: ev.title, skillId: ev.skillId, ui: [] };
        } else {
          state.session.id = ev.id;
        }
        if (ev.title) {
          state.session.title = ev.title;
          if (state.view === 'chat') $('#chatTitle').textContent = ev.title;
        }
        break;
      }
      case 'step': {
        setStatus(live, '正在思考…');
        break;
      }
      case 'reasoning': {
        if (!live.thinkStartedAt) live.thinkStartedAt = Date.now();
        const t = ensureThink(refs, true);
        t.body.textContent += ev.d;
        if (t.body.dataset.stick !== '0') t.body.scrollTop = t.body.scrollHeight;
        live.msg.reasoning += ev.d;
        if (!refs.think.el.open) refs.think.el.open = true;
        scrollMaybe();
        break;
      }
      case 'text': {
        if (!live.firstText) {
          live.firstText = true;
          if (refs.statusEl) refs.statusEl.style.display = 'none';
          if (refs.think) {
            refs.think.el.classList.remove('live');
            refs.think.el.open = false;
            const secs = Math.max(1, Math.round((Date.now() - live.thinkStartedAt) / 1000));
            const label = refs.think.label;
            if (label) label.textContent = '思考过程 · ' + secs + 's';
          }
        }
        live.msg.text += ev.d;
        scheduleRender(live);
        break;
      }
      case 'tool': {
        if (ev.status === 'start') {
          setStatus(live, '正在' + toolVerb(ev.name) + '…');
          addTool(refs, ev);
          live.msg.tools.push({ name: ev.name, summary: ev.summary, status: 'running' });
        } else {
          addTool(refs, ev);
          const last = live.msg.tools[live.msg.tools.length - 1];
          if (last) {
            last.status = ev.status;
            last.ms = ev.ms;
          }
          setStatus(live, '正在思考…');
        }
        scrollMaybe();
        break;
      }
      case 'config': {
        addConfigProposal(refs, ev);
        scrollMaybe();
        break;
      }
      case 'confirm': {
        addRunConfirm(refs, ev);
        scrollMaybe();
        break;
      }
      case 'sources': {
        for (const item of ev.items || []) {
          addSource(refs, item);
          if (!live.msg.sources.some((s) => s.url === item.url)) live.msg.sources.push(item);
        }
        scrollMaybe();
        break;
      }
      case 'file': {
        addFile(refs, ev);
        if (!live.msg.files.some((f) => f.path === ev.path)) live.msg.files.push({ path: ev.path, name: ev.name, size: ev.size });
        scrollMaybe();
        break;
      }
      case 'upload': {
        if (ev.status === 'start') setStatus(live, '正在解析附件「' + ev.name + '」…');
        if (ev.status === 'ok') setStatus(live, '附件解析完成，继续处理…');
        if (ev.status === 'error') toast('附件解析失败：' + (ev.message || ev.name), true);
        break;
      }
      case 'usage': {
        live.msg.usage = ev.usage;
        refs.metaEl.textContent = usageText(ev.usage);
        break;
      }
      case 'title': {
        if (state.session) state.session.title = ev.title;
        if (state.view === 'chat') $('#chatTitle').textContent = ev.title;
        if (state.session) upsertSession(state.session, ev.title);
        break;
      }
      case 'notice': {
        const n = document.createElement('div');
        n.className = 'notice';
        n.textContent = ev.message;
        refs.body.insertBefore(n, refs.metaEl);
        break;
      }
      case 'done': {
        finalize(live, ev);
        break;
      }
      case 'aborted': {
        finishAborted(live);
        break;
      }
      case 'error': {
        throw new Error(ev.message || '生成失败');
      }
      default:
        break;
    }
  }

  function scheduleRender(live) {
    if (live.renderTimer) return;
    live.renderTimer = setTimeout(() => {
      live.renderTimer = null;
      if (!live.refs.contentEl) return;
      live.refs.contentEl.innerHTML = MD.render(live.msg.text);
      scrollMaybe();
    }, 60);
  }

  function setStatus(live, text) {
    if (!live.refs.statusEl) return;
    live.refs.statusEl.style.display = '';
    const t = live.refs.statusEl.querySelector('.ls-text');
    if (t) t.textContent = text;
  }

  function finalize(live, ev) {
    if (live.finished) return;
    live.finished = true;
    const refs = live.refs;
    if (refs.statusEl) refs.statusEl.style.display = 'none';
    if (refs.contentEl) {
      refs.contentEl.classList.remove('streaming');
      refs.contentEl.innerHTML = MD.render(live.msg.text || '');
      if (!live.msg.text) refs.contentEl.style.display = 'none';
    }
    refs.streaming = false;
    if (refs.sourcesEl && refs.sourcesEl.dataset.pending) refs.sourcesEl.style.display = '';
    if (refs.filesEl && refs.filesEl.dataset.pending) refs.filesEl.style.display = '';
    if (refs.think) {
      refs.think.el.classList.remove('live');
      refs.think.el.open = false;
    }
    if (state.session && ev.title) {
      state.session.title = ev.title;
      if (state.view === 'chat') $('#chatTitle').textContent = ev.title;
    }
    if (state.session) {
      upsertSession(state.session, state.session.title);
      state.session.ui = state.messages;
    }
    if (live.msg.text && !refs.body.querySelector('.msg-actions')) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '复制';
      copy.addEventListener('click', () => copyText(live.msg.text));
      actions.append(copy);
      refs.body.append(actions);
    }
    setStreaming(false);
    scrollMaybe(true);
    $('#input').focus();
  }

  function finishAborted(live) {
    if (live.finished) return;
    live.finished = true;
    const refs = live.refs;
    if (refs.statusEl) refs.statusEl.style.display = 'none';
    if (refs.contentEl) refs.contentEl.classList.remove('streaming');
    if (refs.think) {
      refs.think.el.classList.remove('live');
      refs.think.el.open = false;
    }
    const n = document.createElement('div');
    n.className = 'notice';
    n.textContent = '已停止生成';
    refs.body.insertBefore(n, refs.metaEl);
    if (state.session) {
      upsertSession(state.session, state.session.title);
      state.session.ui = state.messages;
    }
    setStreaming(false);
  }

  function rollback(userMsg, assistantMsg, attachments, err) {
    state.messages = state.messages.filter((m) => m !== userMsg && m !== assistantMsg);
    if (!state.messages.length) {
      state.session = null;
      $('#chatTitle').textContent = '新对话';
    }
    $('#messages').innerHTML = '';
    for (const m of state.messages) appendMessage(m, false);
    toggleWelcome();
    const input = $('#input');
    input.value = userMsg.text || input.value;
    autoGrow();
    state.attachments = attachments.filter((a) => a.status === 'ready');
    renderAttachments();
    setStreaming(false);
    toast(err.message || '发送失败', true);
    input.focus();
  }

  function setStreaming(on) {
    state.streaming = on;
    const btn = $('#sendBtn');
    if (on) {
      btn.classList.add('stop');
      btn.disabled = false;
      btn.title = '停止生成';
      btn.innerHTML = '<span style="width:10px;height:10px;border-radius:2px;background:currentColor;display:block"></span>';
    } else {
      state.controller = null;
      btn.classList.remove('stop');
      btn.disabled = false;
      btn.title = '发送（Enter）';
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    $('#attachBtn').disabled = on;
  }

  /* ================= 附件 ================= */

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.attachments.length >= 6) {
        toast('一次最多 6 个附件', true);
        break;
      }
      if (file.size > 32 * 1024 * 1024) {
        toast('「' + file.name + '」超过 32MB，请压缩后再传', true);
        continue;
      }
      const item = { id: null, name: file.name, size: file.size, status: 'uploading' };
      state.attachments.push(item);
      renderAttachments();
      try {
        const buf = await file.arrayBuffer();
        const resp = await fetch('/api/upload?name=' + encodeURIComponent(file.name) + '&mime=' + encodeURIComponent(file.type || 'application/octet-stream'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '上传失败');
        item.id = data.file.id;
        item.status = 'ready';
      } catch (err) {
        item.status = 'error';
        toast('「' + file.name + '」上传失败：' + err.message, true);
      }
      renderAttachments();
    }
  }

  function renderAttachments() {
    const box = $('#attachments');
    box.innerHTML = '';
    box.classList.toggle('hidden', state.attachments.length === 0);
    for (const att of state.attachments) {
      const chip = document.createElement('div');
      chip.className = 'att-chip' + (att.status === 'uploading' ? ' uploading' : '') + (att.status === 'error' ? ' error' : '');
      const name = document.createElement('span');
      name.className = 'a-name';
      name.textContent = att.name;
      const size = document.createElement('span');
      size.className = 'a-size';
      size.textContent = att.status === 'uploading' ? '上传中…' : formatSize(att.size);
      const x = document.createElement('button');
      x.className = 'a-x';
      x.type = 'button';
      x.textContent = '×';
      x.title = '移除';
      x.addEventListener('click', () => {
        state.attachments = state.attachments.filter((a) => a !== att);
        renderAttachments();
      });
      chip.append(name, size, x);
      box.append(chip);
    }
  }

  /* ================= 技能 ================= */

  /** 上一整周的周一（ISO），日期选择器的默认值 */
  function lastMondayISO() {
    const now = new Date();
    const dow = now.getDay() || 7;
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - dow);
    const monday = new Date(sunday);
    monday.setDate(sunday.getDate() - 6);
    const pad = (n) => String(n).padStart(2, '0');
    return monday.getFullYear() + '-' + pad(monday.getMonth() + 1) + '-' + pad(monday.getDate());
  }

  /** 任意一天 → 它所在那一周（周一~周日）的区间文案 */
  function weekRangeOf(iso) {
    const d = iso ? new Date(iso + 'T00:00:00') : new Date();
    const dow = d.getDay() || 7;                 // 1=周一 … 7=周日
    const mon = new Date(d);
    mon.setDate(d.getDate() - (dow - 1));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const f = (x) => x.getMonth() + 1 + '-' + String(x.getDate()).padStart(2, '0');
    return f(mon) + ' ~ ' + f(sun);
  }

  /** 上一整周（周一~周日）的区间文案 */
  function lastWeekLabel() {
    const now = new Date();
    const dow = now.getDay() || 7;                 // 1=周一 … 7=周日
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - dow);           // 上周日
    const monday = new Date(sunday);
    monday.setDate(sunday.getDate() - 6);
    const f = (d) => d.getMonth() + 1 + '-' + String(d.getDate()).padStart(2, '0');
    return f(monday) + ' ~ ' + f(sunday) + '（上周）';
  }

  /** 技能卡片：产出框架 / 怎么用 / 配置与运行 */
  function openSkill(skill) {
    closeSidebar();
    const cmds = Array.isArray(skill.commands) ? skill.commands : [];
    const hasCfg = Array.isArray(skill.configFiles) && skill.configFiles.length > 0;
    const fields = Array.isArray(skill.fields) ? skill.fields : [];

    // ① 产出框架
    const sections = Array.isArray(skill.sections) ? skill.sections : [];
    const secHtml = sections.length
      ? '<h3>产出框架</h3><div class="skill-sections">' +
        sections
          .map(
            (row) =>
              '<div class="ss-row"><b>' + esc(row[0] || '') + '</b><span>' + esc(row[1] || '') + '</span></div>'
          )
          .join('') +
        '</div>'
      : '';

    // ② 怎么用
    const howto = Array.isArray(skill.howto) && skill.howto.length
      ? skill.howto
      : ['填店铺和产品 —— 只需一次', '勾选这次要跑的产品', '点运行，或者直接跟员工说'];
    const howHtml =
      '<h3>怎么用</h3><ol class="skill-howto">' +
      howto.map((x) => '<li>' + esc(x) + '</li>').join('') +
      '</ol>' +
      '<p class="howto-note">两种方式等价：在下面改，或者直接跟员工聊。</p>';

    // ③ 配置 + 运行
    // 有配置的技能才显示「配置 + 运行」；没有配置的直接去对话里跑，卡片上不放按钮
    const runHtml = cmds.length && hasCfg
      ? '<div class="skill-run" data-runbox><div class="sr-loading">正在读取配置…</div></div>' +
        '<details class="skill-adv"><summary>高级：单独运行命令</summary><div class="run-list">' +
        cmds
          .map((c, i) => {
            const need = Array.isArray(c.params) && c.params.length > 0;
            return (
              '<div class="run-item"><div class="run-main"><b>' + esc(c.label) + '</b>' +
              (c.desc ? '<div class="run-desc">' + esc(c.desc) + '</div>' : '') +
              '</div><button class="btn small ghost" type="button" data-run="' + i + '">' +
              (need ? '填参数' : '运行') + '</button></div>'
            );
          })
          .join('') +
        '</div><div class="run-panel hidden" data-runpanel></div></details>'
      : '';

    const fieldsHtml = fields.length
      ? '<h3>按需填几项（不填也能开始）</h3><div class="form-grid">' +
        fields
          .map((f) => {
            const req = f.required ? ' <b>*</b>' : '';
            const control =
              f.type === 'textarea'
                ? '<textarea data-field="' + esc(f.key) + '" rows="2" placeholder="' + esc(f.placeholder || '') + '"></textarea>'
                : '<input type="text" data-field="' + esc(f.key) + '" placeholder="' + esc(f.placeholder || '') + '">';
            return '<div class="field"' + (f.type === 'textarea' ? ' style="grid-column:1 / -1"' : '') + '><label>' + esc(f.label || f.key) + req + '</label>' + control + '</div>';
          })
          .join('') +
        '</div>'
      : '';

    const html =
      '<div class="modal-head"><div class="skill-hero"><div class="skill-no">' + skillNo(skill) + '</div>' +
      '<div><div class="skill-group-tag">' + esc(skill.group || '技能') + '</div><h2>' + esc(skill.title) + '</h2>' +
      '<div class="tag">' + esc(skill.tagline || '') + '</div></div></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      secHtml +
      howHtml +
      runHtml +
      fieldsHtml +
      '<div class="lastrun" data-lastrun></div>' +
      '<div class="modal-actions"><button class="btn ghost" data-close type="button">取消</button>' +
      '<button class="btn primary" data-start type="button">用这个技能开始</button></div>';

    const close = showModal(html, { wide: true });
    const modal = close.modal;

    // 高级里的单独命令
    modal.querySelectorAll('[data-run]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = cmds[Number(btn.dataset.run)];
        if (!cmd) return;
        const panel = modal.querySelector('[data-runpanel]');
        panel.classList.remove('hidden');
        panel.innerHTML =
          '<div class="run-cmd-head">将要执行 <code>' + esc((cmd.run || []).join(' ')) + '</code></div>' +
          (cmd.params || [])
            .map(
              (p) =>
                '<div class="field"><label>' + esc(p.label) + (p.required ? ' <b>*</b>' : '') + '</label>' +
                '<input type="text" data-param="' + esc(p.key) + '" placeholder="' + esc(p.placeholder || '') + '"></div>'
            )
            .join('') +
          '<div class="run-act"><button class="btn primary" type="button" data-gorun>开始运行</button>' +
          '<span class="run-hint">最长 ' + Math.round((cmd.timeoutMs || 180000) / 1000) + ' 秒，结果会存到工作区</span></div>' +
          '<div data-runresult></div>';
        panel.querySelector('[data-gorun]').addEventListener('click', () => doRunSkill(modal, skill, cmd, panel));
      });
    });

    if (hasCfg && cmds.length) loadSkillRunBox(modal, skill, cmds);


    // 上次产出
    fetch('/api/outputs')
      .then((r) => r.json())
      .then((data) => {
        const items = (data.items || []).filter(
          (it) => it.group === skill.id && ['html', 'md', 'xlsx', 'csv', 'pdf'].includes(it.ext)
        );
        if (!items.length) return;
        const order = { html: 0, xlsx: 1, md: 2, csv: 3, pdf: 4 };
        items.sort((x, y) => (order[x.ext] || 9) - (order[y.ext] || 9) || y.mtime - x.mtime);
        const top = items.find((x) => x.ext === 'html') || items[0];
        const when = new Date(top.mtime);
        const el = modal.querySelector('[data-lastrun]');
        if (!el) return;
        el.innerHTML =
          '<span class="lr-k">上次产出</span>' +
          '<span class="lr-when">' + String(when.getMonth() + 1) + '-' + String(when.getDate()).padStart(2, '0') + ' ' +
          String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') + '</span>' +
          '<a class="lr-open" href="/api/file?path=' + encodeURIComponent(top.rel) + '" target="_blank" rel="noopener">' +
          esc(top.name) + ' →</a>';
      })
      .catch(() => {});

    modal.querySelector('[data-start]').addEventListener('click', () => {
      const values = {};
      modal.querySelectorAll('[data-field]').forEach((el) => {
        if (el.value.trim()) values[el.dataset.field] = el.value.trim();
      });
      close();
      applySkill(skill, values, '');
    });
    setTimeout(() => {
      const first = modal.querySelector('[data-field]');
      if (first) first.focus();
    }, 60);
  }

  /** 卡片里的配置区：店铺 / 产品勾选 / 周区间 / 成本提醒 / 保存 + 运行 */
  async function loadSkillRunBox(modal, skill, cmds) {
    const box = modal.querySelector('[data-runbox]');
    if (!box) return;
    let cfg = null;
    try {
      cfg = await (await fetch('/api/skill/config?id=' + encodeURIComponent(skill.id))).json();
    } catch {
      cfg = null;
    }
    if (!cfg || !cfg.ok) {
      box.innerHTML = '<div class="sr-line"><span class="sr-v">读不到配置</span>' +
        '<button class="btn small ghost" type="button" data-productcfg>打开配置</button></div>';
      const b = box.querySelector('[data-productcfg]');
      if (b) b.addEventListener('click', () => openProductConfig(skill));
      return;
    }
    const doc = (cfg.files && cfg.files['config/products.json']) || {};
    const products = Array.isArray(doc.products) ? doc.products : [];
    if (!products.length) {
      box.innerHTML = '<div class="sr-line"><span class="sr-v">还没有登记产品</span>' +
        '<button class="btn small primary" type="button" data-productcfg>去登记</button></div>';
      const b = box.querySelector('[data-productcfg]');
      if (b) b.addEventListener('click', () => openProductConfig(skill));
      return;
    }

    const stores = [...new Set(products.map((p) => (p.store && p.store.alias) || '').filter(Boolean))];
    const costMissing = products.filter(
      (p) => p.enabled !== false && !Number(p.unit_cost) && !Number(p.first_leg) && !Number(p.fba_fee)
    );

    box.innerHTML =
      '<div class="sr-line"><span class="sr-k">产品管理</span>' +
      '<span class="sr-v">' + (stores.length ? esc(stores.join(' / ')) : '还没登记店铺') + '</span>' +
      '<button class="btn small ghost" type="button" data-productcfg>管理</button></div>' +
      '<div class="sr-line"><span class="sr-k">跑哪些产品</span><span class="sr-v sr-chips">' +
      products
        .map(
          (p) =>
            '<label class="sr-chip"><input type="checkbox" data-spu="' + esc(p.spu) + '"' +
            (p.enabled !== false ? ' checked' : '') + '> ' + esc(p.spu) + '</label>'
        )
        .join('') +
      '</span><span class="sr-count" data-count></span></div>' +
      '<div class="sr-line"><span class="sr-k">周区间</span><span class="sr-v sr-week">' +
      '<input type="date" class="sr-date" data-week value="' + lastMondayISO() + '">' +
      '<span class="sr-hint">将跑 <b data-week-hint>' + esc(weekRangeOf(lastMondayISO())) + '</b></span>' +
      '</span></div>' +
      '<div class="sr-tip">选哪一天都按它所在那一周算（周一到周日）；不改默认上一整周，跨周后自动跟着变。</div>' +
      (costMissing.length
        ? '<div class="sr-warn">⚠ ' + esc(costMissing.map((p) => p.spu).join('、')) +
          ' 成本四项未填，利润率不可信 <button class="btn small ghost" type="button" data-productcfg>去填</button></div>'
        : '') +
      '<div class="sr-actions"><button class="btn primary" type="button" data-saverun>保存并运行</button>' +
      '<button class="btn ghost" type="button" data-saveonly>只保存</button></div>' +
      '<div class="run-panel hidden" data-runpanel><button type="button" data-gorun hidden></button><div data-runresult></div></div>';

    box.querySelectorAll('[data-productcfg]').forEach((b) =>
      b.addEventListener('click', () => openProductConfig(skill))
    );

    // 已选数量实时更新：报告里"几个 SPU"不该写死
    // 产品配置保存后，重新拉一次，把新加的产品渲染出来
    const onCfgSaved = (e) => {
      if (!document.body.contains(box)) {
        window.removeEventListener('skillcfg:saved', onCfgSaved);
        return;
      }
      if (e && e.detail && e.detail.skillId && e.detail.skillId !== skill.id) return;
      loadSkillRunBox(modal, skill, cmds);
    };
    window.addEventListener('skillcfg:saved', onCfgSaved);

    const weekEl0 = box.querySelector('[data-week]');
    const weekHint = box.querySelector('[data-week-hint]');
    if (weekEl0 && weekHint) {
      weekEl0.addEventListener('change', () => {
        weekHint.textContent = weekEl0.value ? weekRangeOf(weekEl0.value) : weekRangeOf(lastMondayISO());
      });
    }

    const countEl = box.querySelector('[data-count]');
    const refreshCount = () => {
      const all = box.querySelectorAll('[data-spu]');
      const on = [...all].filter((el) => el.checked).length;
      if (countEl) {
        countEl.textContent = '已选 ' + on + ' / ' + all.length;
        countEl.classList.toggle('zero', on === 0);
      }
    };
    box.querySelectorAll('[data-spu]').forEach((el) => el.addEventListener('change', refreshCount));
    refreshCount();

    const save = async (notify) => {
      const picked = new Set(
        [...box.querySelectorAll('[data-spu]')]
          .filter((el) => el.checked)
          .map((el) => el.dataset.spu)
      );
      const next = products.map((p) => Object.assign({}, p, { enabled: picked.has(p.spu) }));
      const resp = await fetch('/api/skill/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: skill.id, products: next, mtimeMs: cfg.mtimeMs }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || '保存失败');
      if (notify) toast('已保存：启用 ' + picked.size + ' / ' + products.length + ' 个产品');
      return picked.size;
    };

    box.querySelector('[data-saveonly]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        await save(true);
      } catch (err) {
        toast('没保存：' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '只保存';
      }
    });

    box.querySelector('[data-saverun]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        const n = await save(false);
        if (!n) {
          toast('至少要勾一个产品', true);
          btn.disabled = false;
          btn.textContent = '保存并运行';
          return;
        }
        toast('已保存，开始运行');
        const panel = box.querySelector('[data-runpanel]');
        panel.classList.remove('hidden');
        const weekEl = box.querySelector('[data-week]');
        const extra = weekEl && weekEl.value ? { week: weekEl.value } : {};
        await doRunSkill(modal, skill, cmds[0], panel, extra);
      } catch (err) {
        toast('没跑起来：' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = '保存并运行';
      }
    });
  }

  async function doRunSkill(modal, skill, cmd, panel, extraParams) {
    const btn = panel.querySelector('[data-gorun]');
    const box = panel.querySelector('[data-runresult]');
    const params = Object.assign({}, extraParams || {});
    panel.querySelectorAll('[data-param]').forEach((el) => {
      const v = el.value.trim();
      if (v) params[el.dataset.param] = v;
    });
    const limit = Math.round((cmd.timeoutMs || 180000) / 1000);
    btn.disabled = true;
    btn.textContent = '运行中…';
    box.innerHTML =
      '<div class="run-live"><span class="spinner"></span><span data-elapsed>0:00</span>' +
      '<span class="run-live-note">正在运行，最长 ' + limit + ' 秒</span></div>' +
      '<pre class="run-out" data-preview>等待输出…</pre>';

    // 秒表：让人知道它没死
    const startedAt = Date.now();
    const elapsedEl = box.querySelector('[data-elapsed]');
    const ticker = setInterval(() => {
      if (!elapsedEl) return;
      const total = Math.floor((Date.now() - startedAt) / 1000);
      elapsedEl.textContent = Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
    }, 1000);

    // 请求最多等「命令上限 + 90 秒」，超时就当服务没了，别让按钮永远转
    const controller = new AbortController();
    const hardTimer = setTimeout(() => controller.abort(), (limit + 90) * 1000);

    try {
      const resp = await fetch('/api/skill/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ skillId: skill.id, index: cmd.index, params }),
      });
      const ctype = String(resp.headers.get('content-type') || '');
      const data = ctype.indexOf('ndjson') >= 0 ? await readRunStream(resp, box) : await resp.json();
      const secs = data.ms ? Math.round(data.ms / 1000) : 0;
      let html = '';
      if (data.ok) {
        html =
          '<pre class="run-out">' + esc(data.output || '（没有输出）') + '</pre>' +
          '<div class="run-hint" style="margin-top:6px">✅ 完成，用时 ' + secs + ' 秒</div>';
      } else {
        html =
          '<pre class="run-out">' + esc((data.error ? data.error + '\n\n' : '') + (data.output || '')) + '</pre>' +
          '<div class="run-hint" style="margin-top:6px;color:var(--danger)">❌ 没有成功' +
          (data.code !== undefined && data.code !== null ? '（退出码 ' + data.code + '）' : '') + '</div>';
      }
      if (Array.isArray(data.injected)) {
        html +=
          '<div class="run-hint" style="margin-top:6px">数据源凭据：' +
          (data.injected.length
            ? esc(data.injected.join('、'))
            : '没有注入（数据源里没有填 Key，或那条数据源被删了）') +
          '</div>';
      }
      if (Array.isArray(data.files) && data.files.length) {
        const files = data.files.map(String);
        const pattern = skill.primaryOutput ? new RegExp(skill.primaryOutput, 'i') : /\.html?$/i;
        let primary = files.find((f) => pattern.test(f));
        if (!primary) primary = files.find((f) => /\.(md|xlsx?|csv|pdf)$/i.test(f));
        if (!primary) primary = files[0];
        const rest = files.filter((f) => f !== primary);
        const fileUrl = (f) => '/api/file?path=' + encodeURIComponent(f);
        const baseName = (f) => String(f).split('/').pop();

        html +=
          '<div class="run-primary">' +
          '<div class="rp-tag">这份是你要的结果</div>' +
          '<div class="rp-name">' + esc(baseName(primary)) + '</div>' +
          '<div class="rp-actions">' +
          '<a class="btn primary" target="_blank" rel="noopener" href="' + fileUrl(primary) + '">打开报告</a>' +
          '<a class="btn ghost" href="' + fileUrl(primary) + '&download=1">下载</a>' +
          '</div></div>';

        if (rest.length) {
          html +=
            '<details class="run-rest"><summary>另有 ' + rest.length + ' 个过程文件（取数缓存，一般不用打开）</summary>' +
            '<div class="run-files">' +
            rest
              .map(
                (f) =>
                  '<a class="run-file" target="_blank" rel="noopener" href="' + fileUrl(f) + '">' + esc(baseName(f)) + '</a>'
              )
              .join('') +
            '</div></details>';
        }
        html += '<div class="run-hint" style="margin-top:6px">结果已复制到工作区「技能产出」</div>';
      }
      box.innerHTML = html;
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
      box.innerHTML =
        '<pre class="run-out">' +
        esc(
          aborted
            ? '等太久没响应，已经放弃。多半是工作台服务被关掉或卡住了——刷新页面，重新点一次「运行」。'
            : '请求失败：' + (err && err.message ? err.message : String(err))
        ) +
        '</pre>';
    } finally {
      clearInterval(ticker);
      clearTimeout(hardTimer);
      btn.disabled = false;
      btn.textContent = '重新运行';
    }
  }

  /**
   * 读取 /api/skill/run 的 NDJSON 流：
   *   {"type":"start"} / {"type":"out","text":"..."} / {"type":"done","result":{...}}
   * 跑的过程中把输出实时刷到面板上，最后返回 done 里的结果。
   */
  async function readRunStream(resp, box) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let live = '';
    let done = null;
    const paint = () => {
      const el = box.querySelector('[data-preview]');
      if (!el) return;
      const text = live.length > 8000 ? '…（前略）\n' + live.slice(-8000) : live;
      el.textContent = text || '等待输出…';
      el.scrollTop = el.scrollHeight;
      el.classList.add('is-live');
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          let evt = null;
          try {
            evt = JSON.parse(line);
          } catch {
            /* 半行，忽略 */
          }
          if (evt && evt.type === 'out') {
            live += String(evt.text || '');
            paint();
          } else if (evt && evt.type === 'done') {
            done = evt.result || null;
          }
        }
        nl = buffer.indexOf('\n');
      }
    }
    if (!done) {
      return { ok: false, error: '连接中断，没收到结果。刷新页面再点一次运行。', files: [], output: live };
    }
    return done;
  }

  function applySkill(skill, values, starter) {
    closeSidebar();
    const hasHistory = state.messages.length > 0;
    if (hasHistory) newChat(true);
    state.skill = skill;
    if (state.session) state.session.skillId = skill.id;
    showView('chat');
    updateSkillUI();

    const lines = [];
    if (starter) {
      lines.push(starter);
    } else {
      lines.push('请用「' + skill.title + '」技能完成下面这件事。');
    }
    const entries = Object.entries(values);
    if (entries.length) {
      lines.push('');
      for (const [k, v] of entries) {
        const field = (skill.fields || []).find((f) => f.key === k);
        lines.push('- ' + (field ? field.label : k) + '：' + v);
      }
    }
    lines.push('');
    lines.push('如果缺少关键信息，先问我；能直接产出的话，按技能要求写成文件并说明路径。');
    const input = $('#input');
    input.value = lines.join('\n');
    autoGrow();
    input.focus();
    $('#chat').scrollTop = $('#chat').scrollHeight;
    toast('已选好技能，按 Enter 发送');
  }

  function updateSkillUI() {
    // 顶部不再挂 chip，上下文统一显示在输入框上方
    const agentChip = $('#agentChip');
    if (agentChip) agentChip.classList.add('hidden');
    const skillChip = $('#skillChip');
    if (skillChip) skillChip.classList.add('hidden');

    const banner = $('#skillBanner');
    if (banner) banner.classList.add('hidden');

    const bar = $('#ctxBar');
    if (!bar) return;
    const parts = [];
    if (state.agent) {
      const img = state.agent.avatar
        ? '<img src="/api/agent/avatar?id=' + encodeURIComponent(state.agent.id) + '" alt="">'
        : '<span class="ctx-emoji">' + esc(state.agent.icon || '') + '</span>';
      parts.push(
        '<span class="ctx-chip agent">' + img +
        '<b>' + esc(state.agent.title) + '</b>' +
        '<span class="ctx-role">' + esc(state.agent.role || '员工') + '</span>' +
        '<button type="button" data-ctx-clear="agent" title="取消员工">×</button></span>'
      );
    }
    if (state.skill) {
      parts.push(
        '<span class="ctx-chip skill"><b>' + esc(state.skill.title) + '</b>' +
        '<button type="button" data-ctx-clear="skill" title="取消技能">×</button></span>'
      );
    }
    bar.classList.remove('hidden');
    if (!parts.length) {
      bar.innerHTML = '<span class="ctx-hint">空白对话 · 输入 <kbd>@</kbd> 选员工，或到技能库选技能</span>';
      return;
    }
    bar.innerHTML = parts.join('');
    bar.querySelectorAll('[data-ctx-clear]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.ctxClear === 'agent') clearAgent();
        else clearSkill();
      });
    });
  }

  function clearAgent() {
    state.agent = null;
    if (state.session) state.session.agentId = null;
    closeAtMenu();
    updateSkillUI();
  }
  function clearSkill() {
    state.skill = null;
    if (state.session) state.session.skillId = null;
    updateSkillUI();
  }

  /* ================= 弹层 ================= */

  // ---------------- 技能配置面板（周报：产品 / 竞品 / 目标） ----------------

  const CFG_PRODUCTS = 'config/products.json';
  const CFG_TARGETS = 'config/targets.json';

  function pctToNum(v) {
    const n = Number(String(v).replace('%', '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  async function openProductConfig(skill) {
    let data;
    try {
      const resp = await fetch('/api/skill/config?id=' + encodeURIComponent(skill.id));
      data = await resp.json();
    } catch (err) {
      alert('读不到配置：' + err.message);
      return;
    }
    if (!data.ok) {
      alert('读不到配置：' + (data.error || '未知错误'));
      return;
    }
    const productsDoc = data.files[CFG_PRODUCTS] || {};
    const targetsDoc = data.files[CFG_TARGETS] || {};
    const products = (productsDoc.products || []).map((p) => {
      const bare = String(p.spu || '').replace(/^LS-/, '');
      return { ...p, target: targetsDoc[p.spu] || targetsDoc[bare] || {} };
    });
    const state = { skill, products, mtimeMs: data.mtimeMs, closer: null, editing: -1 };
    renderProductConfig(state);
  }

  function cfgModal(state, html) {
    if (state.closer) state.closer();
    state.closer = showModal(html, { wide: true });
    return state.closer.modal;
  }

  function money(v) {
    const n = Number(v) || 0;
    return n ? n.toLocaleString('en-US') : '—';
  }

  async function loadShops(force) {
    if (state.shops.loaded && !force) return state.shops.items;
    try {
      const resp = await fetch('/api/shops');
      const data = await resp.json();
      state.shops.items = Array.isArray(data.shops) ? data.shops : [];
      state.shops.loaded = true;
      state.shops.error = data.ok ? '' : data.error || '';
    } catch {
      state.shops.items = [];
      state.shops.error = '读取店铺列表失败';
    }
    return state.shops.items;
  }

  async function fillStoreSelect(modal, current) {
    const sel = modal.querySelector('#cfStore');
    if (!sel) return;
    const paint = () => {
      const opts = ['<option value="">自动（该站点全部店铺）</option>'];
      const curSid = current && current.sid ? String(current.sid) : '';
      const curAlias = (current && current.alias) || '';
      const siteCode = String((modal.querySelector('#cfSite') || {}).value || 'US').trim().toUpperCase();
      const pool = state.shops.items.filter((s) => !s.country || s.country === siteCode);
      for (const s of (pool.length ? pool : state.shops.items)) {
        const picked = curSid && String(s.sid) === curSid;
        opts.push(
          '<option value="' + esc(String(s.sid) + '|' + s.alias) + '"' + (picked ? ' selected' : '') + '>' +
            esc(s.alias) + (s.country ? '（' + esc(s.country) + '）' : '') +
          '</option>'
        );
      }
      if (curAlias && !state.shops.items.some((s) => s.alias === curAlias)) {
        opts.push('<option value="' + esc(String(curSid) + '|' + curAlias) + '" selected>' + esc(curAlias) + '（已保存）</option>');
      }
      sel.innerHTML = opts.join('');
    };
    paint();
    if (!state.shops.loaded) {
      await loadShops();
      paint();
      if (state.shops.error) toast(state.shops.error);
    }
  }

  function renderProductConfig(state) {
    const rows = state.products
      .map((p, i) => {
        const parents = (p.parents || []).map((x) => x.asin).join(' / ') || '—';
        const comp = (p.competitor && p.competitor.asin) || '—';
        const t = p.target || {};
        const margin = t.target_margin ? Math.round(Number(t.target_margin) * 100) + '%' : '—';
        return (
          '<tr class="cfg-row" data-row="' + i + '">' +
          '<td><b>' + esc(p.spu) + '</b>' + (p.enabled === false ? '<span class="cfg-off">停用</span>' : '') + '</td>' +
          '<td>' + esc(p.site || 'US') + '</td>' +
          '<td class="cfg-store">' + esc((p.store && p.store.alias) || '自动') + '</td>' +
          '<td class="cfg-mono">' + esc(parents) + '</td>' +
          '<td class="cfg-mono">' + esc(comp) + '</td>' +
          '<td class="cfg-num">' + money(t.default_monthly) + '</td>' +
          '<td class="cfg-num">' + esc(margin) + '</td>' +
          '<td class="cfg-go">编辑 ›</td>' +
          '</tr>'
        );
      })
      .join('');

    const html =
      '<div class="modal-head"><div class="skill-hero"><div class="skill-no">⚙</div>' +
      '<div><div class="skill-group-tag">' + esc(state.skill.group || '技能') + '</div>' +
      '<h2>' + esc(state.skill.title) + ' · 配置</h2>' +
      '<div class="tag">改完保存，再点「① 生成本周周报」才会生效</div></div></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      (state.products.length
        ? '<table class="cfg-table"><thead><tr><th>SPU</th><th>站点</th><th>店铺</th><th>父体 ASIN</th><th>竞品</th><th>月目标</th><th>利润率</th><th></th></tr></thead><tbody>' +
          rows +
          '</tbody></table>'
        : '<div class="run-hint" style="padding:18px 2px;line-height:1.9">还没有产品。<br>点下面「+ 新增产品」→ 选店铺 → 我直接把这家店的产品列出来，你点一个就好。</div>') +
      '<div class="cfg-estimate" id="cfgEstimate"></div>' +
      '<div class="modal-actions"><button class="btn ghost" data-close type="button">关闭</button>' +
      '<button class="btn" type="button" data-add>+ 新增产品</button></div>';

    const modal = cfgModal(state, html);
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => state.closer()));
    modal.querySelector('[data-add]').addEventListener('click', () => openSpuPicker(state));
    const est = modal.querySelector('#cfgEstimate');
    if (est) {
      const enabled = (state.products || []).filter((p) => p.enabled !== false);
      const n = enabled.length;
      if (!n) {
        est.textContent = '';
      } else {
        const mins = n * 2;
        const warn = n > 5 ? ' 建议先跑 3 个看看效果，剩下的下次再跑。' : '';
        est.innerHTML =
          '已登记 <b>' + n + '</b> 个产品 · 跑一份大约 <b>' + mins + ' 分钟</b>' + warn + '';
        if (n > 5) est.classList.add('warn');
      }
    }
    modal.querySelectorAll('[data-row]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const index = Number(tr.dataset.row);
        state.editing = index;
        renderProductEditor(state, JSON.parse(JSON.stringify(state.products[index])), false);
      });
    });
  }

  async function openSpuPicker(state) {
    const html =
      '<div class="modal-head"><div class="skill-hero"><div class="skill-no">＋</div>' +
      '<div><div class="skill-group-tag">新增产品</div>' +
      '<h2>先选店铺</h2>' +
      '<div class="tag">选好店铺，我把这家店在卖的产品列出来，你点一个就行</div></div></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      '<div class="cfg-form">' +
      '<div class="cfg-grid">' +
      '<label>店铺<select id="spShop"><option value="">读取中…</option></select></label>' +
      '<label>搜索<input type="text" id="spSearch" placeholder="SPU 或标题关键字" spellcheck="false"></label>' +
      '</div>' +
      '<div class="sp-list" id="spList"><p class="run-hint">选一个店铺开始</p></div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn ghost" data-close type="button">取消</button>' +
      '<button class="btn ghost" data-manual type="button">手动填写</button></div>';

    const modal = cfgModal(state, html);
    const sel = modal.querySelector('#spShop');
    const list = modal.querySelector('#spList');
    const search = modal.querySelector('#spSearch');
    let items = [];
    let site = 'US';
    let shop = null;

    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => state.closer()));
    modal.querySelector('[data-manual]').addEventListener('click', () => {
      state.editing = -1;
      renderProductEditor(state, {
        spu: '',
        site: 'US',
        parents: [{ asin: '' }],
        competitor: { asin: '', url: '' },
        price: 0,
        rating: 0,
        enabled: true,
        target: {},
      }, true);
    });

    const shops = await loadShops();
    const us = shops.filter((x) => !x.country || x.country === 'US');
    const pool = us.length ? us : shops;
    sel.innerHTML = pool.map((x) => '<option value="' + esc(x.sid) + '">' + esc(x.alias) + '</option>').join('');

    const paint = () => {
      const q = String(search.value || '').trim().toLowerCase();
      const rows = items.filter((it) => {
        if (!q) return true;
        return (it.spu + ' ' + it.title).toLowerCase().includes(q);
      });
      if (!rows.length) {
        list.innerHTML = '<p class="run-hint">这个店铺近 30 天没有在卖的产品</p>';
        return;
      }
      const have = new Set((state.products || []).map((p) => p.spu));
      list.innerHTML = rows
        .map((it) => {
          const added = have.has(it.spu);
          return (
            '<button class="sp-row' + (added ? ' added' : '') + '" type="button" data-spu="' + esc(it.spu) + '"' + (added ? ' disabled' : '') + '>' +
            '<span class="sp-spu">' + esc(it.spu) + '</span>' +
            '<span class="sp-title">' + esc(it.title || '（无标题）') + '</span>' +
            '<span class="sp-meta">' + it.parents.length + ' 个父体 · 近30天 ' + Math.round(it.volume) + ' 件' + (added ? ' · 已添加' : '') + '</span>' +
            '</button>'
          );
        })
        .join('');
      list.querySelectorAll('[data-spu]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const it = items.find((x) => x.spu === btn.dataset.spu);
          if (!it) return;
          state.editing = -1;
          renderProductEditor(state, {
            spu: it.spu,
            site,
            title: it.title,
            store: shop ? { alias: shop.alias, sid: shop.sid, profile_id: shop.profileId || '' } : null,
            parents: (it.parents.length ? it.parents : ['']).map((a) => ({ asin: a, label: '' })),
            competitor: { asin: '', url: '' },
            price: 0,
            rating: 0,
            enabled: true,
            target: {},
          }, true);
        });
      });
    };

    const load = async () => {
      shop = shopPool();
      if (!shop) return;
      site = shop.country || 'US';
      list.innerHTML = '<p class="run-hint"><span class="spinner"></span> 正在从领星读取产品…</p>';
      try {
        const resp = await fetch('/api/lingxing/spus?sid=' + encodeURIComponent(shop.sid));
        const data = await resp.json();
        if (!data.ok) {
          list.innerHTML = '<p class="run-hint" style="color:var(--danger)">' + esc(data.error || '读取失败') + '</p>';
          return;
        }
        items = data.spus || [];
        paint();
      } catch (err) {
        list.innerHTML = '<p class="run-hint" style="color:var(--danger)">读取失败：' + esc(err.message || '') + '</p>';
      }
    };

    let shopPool = () => pool.find((x) => String(x.sid) === String(sel.value)) || pool[0];
    sel.addEventListener('change', load);
    search.addEventListener('input', paint);
    await load();
  }

  function renderProductEditor(state, draft, isNew) {
    draft.parents = draft.parents && draft.parents.length ? draft.parents : [{ asin: '' }];
    draft.competitor = draft.competitor || { asin: '', url: '' };
    draft.target = draft.target || {};
    const cost = draft.target.cost || {};

    const parentRows = draft.parents
      .map(
        (p, i) =>
          '<div class="cfg-parent-row"><input type="text" data-parent="' + i + '" value="' + esc(p.asin || '') + '" placeholder="B0XXXXXXXX" spellcheck="false">' +
          (draft.parents.length > 1 ? '<button type="button" class="btn small ghost" data-rmparent="' + i + '">移除</button>' : '') +
          '</div>'
      )
      .join('');

    const html =
      '<div class="modal-head"><div class="skill-hero"><div class="skill-no">' + (isNew ? '+' : '✎') + '</div>' +
      '<div><div class="skill-group-tag">' + (isNew ? '新增 SPU' : '编辑 SPU') + '</div>' +
      '<h2>' + esc(draft.spu || '新 SPU') + '</h2>' +
      '<div class="tag">父体 ASIN 决定关键词按谁抓；竞品配一个就行</div></div></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      '<div class="cfg-form">' +
      '<div class="cfg-grid">' +
      '<label>SPU 编码<input type="text" id="cfSpu" value="' + esc(draft.spu || '') + '" placeholder="LS-66D38" spellcheck="false"' + (isNew ? '' : ' readonly') + '></label>' +
      '<label>站点<input type="text" id="cfSite" value="' + esc(draft.site || 'US') + '" spellcheck="false"></label>' +
      '<label>店铺<select id="cfStore"><option value="">自动（该站点全部店铺）</option></select></label>' +
      '<label>售价（USD）<input type="number" step="0.01" id="cfPrice" value="' + (Number(draft.price) || '') + '"></label>' +
      '<label>评分<input type="number" step="0.1" min="0" max="5" id="cfRating" value="' + (Number(draft.rating) || '') + '"></label>' +
      '</div>' +
      '<h3>父体 ASIN（一个 SPU 可以挂多个）</h3>' +
      '<div class="cfg-parents" id="cfParents">' + parentRows + '</div>' +
      '<button type="button" class="btn small ghost" id="cfAddParent">+ 加一个父体</button>' +
      '<h3>对标竞品（可跳过，不填就不出竞品那一段）</h3>' +
      '<div class="cfg-grid">' +
      '<label>竞品 ASIN<input type="text" id="cfCompAsin" value="' + esc(draft.competitor.asin || '') + '" placeholder="B0XXXXXXXX" spellcheck="false"></label>' +
      '<label>竞品链接<input type="text" id="cfCompUrl" value="' + esc(draft.competitor.url || '') + '" placeholder="https://www.amazon.com/dp/..." spellcheck="false"></label>' +
      '</div>' +
      '<h3>目标与成本</h3>' +
      '<div class="cfg-grid">' +
      '<label>月销售目标（USD）<input type="number" step="1" id="cfMonthly" value="' + (Number(draft.target.default_monthly) || '') + '"></label>' +
      '<label>目标利润率（%）<input type="number" step="0.1" id="cfMargin" value="' + (draft.target.target_margin ? Math.round(Number(draft.target.target_margin) * 1000) / 10 : '') + '"></label>' +
      '<label>采购成本<input type="number" step="0.01" id="cfUnitCost" value="' + (Number(cost.unit_cost) || '') + '"></label>' +
      '<label>头程<input type="number" step="0.01" id="cfFirstLeg" value="' + (Number(cost.first_leg) || '') + '"></label>' +
      '<label>尾程配送费（FBA / FBM 都填这里）<input type="number" step="0.01" id="cfFba" value="' + (Number(cost.fba_fee) || '') + '"></label>' +
                    '<label>仓储费（% × 销售额）<input type="number" step="0.1" id="cfStorage" value="' + (cost.storage_rate !== undefined && Number(cost.storage_rate) ? Math.round(Number(cost.storage_rate) * 1000) / 10 : '') + '" placeholder="例如 1.5"></label>' +
      '<label>佣金率（%）<input type="number" step="0.1" id="cfReferral" value="' + (cost.referral_rate !== undefined ? Math.round(Number(cost.referral_rate) * 1000) / 10 : '') + '"></label>' +
      '</div>' +
      '<label class="cfg-check"><input type="checkbox" id="cfEnabled"' + (draft.enabled === false ? '' : ' checked') + '> 参与周报（取消勾选＝停用，不删配置）</label>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn ghost" type="button" data-back>返回列表</button>' +
      (isNew ? '' : '<button class="btn danger" type="button" data-del>删除</button>') +
      '<button class="btn primary" type="button" data-save>保存</button></div>';

    const modal = cfgModal(state, html);
    fillStoreSelect(modal, draft.store || null);
    const collect = () => {
      const parents = [];
      modal.querySelectorAll('[data-parent]').forEach((input) => {
        const v = String(input.value || '').trim().toUpperCase();
        if (v) parents.push({ asin: v, label: '' });
      });
      const target = {
        ...draft.target,
        default_monthly: Number(modal.querySelector('#cfMonthly').value) || 0,
        target_margin: pctToNum(modal.querySelector('#cfMargin').value) / 100,
        cost: {
          ...(draft.target.cost || {}),
          unit_cost: Number(modal.querySelector('#cfUnitCost').value) || 0,
          first_leg: Number(modal.querySelector('#cfFirstLeg').value) || 0,
          fba_fee: Number(modal.querySelector('#cfFba').value) || 0,
        storage_rate: pctToNum(modal.querySelector('#cfStorage').value) / 100,
          referral_rate: pctToNum(modal.querySelector('#cfReferral').value) / 100,
        },
      };
      const monthly = target.default_monthly;
      if (monthly) {
        const month = new Date().toISOString().slice(0, 7);
        target.monthly = { ...(draft.target.monthly || {}), [month]: monthly };
      }
      return {
        id: String(modal.querySelector('#cfSpu').value || '').trim(),
        spu: String(modal.querySelector('#cfSpu').value || '').trim(),
        site: String(modal.querySelector('#cfSite').value || 'US').trim().toUpperCase(),
        store: (() => {
          const sel = modal.querySelector('#cfStore');
          const v = sel ? String(sel.value || '') : '';
          if (!v) return null;
          const [sid, alias] = v.split('|');
          const prev = draft.store || {};
          const sameSid = String(prev.sid || '') === String(sid);
          return { alias, sid: Number(sid) || 0, profile_id: sameSid ? String(prev.profile_id || '') : '' };
        })(),
        parents,
        competitor: {
          asin: String(modal.querySelector('#cfCompAsin').value || '').trim().toUpperCase(),
          url: String(modal.querySelector('#cfCompUrl').value || '').trim(),
          note: (draft.competitor && draft.competitor.note) || '',
        },
        price: Number(modal.querySelector('#cfPrice').value) || 0,
        rating: Number(modal.querySelector('#cfRating').value) || 0,
        enabled: modal.querySelector('#cfEnabled').checked,
        target,
      };
    };

    modal.querySelector('#cfAddParent').addEventListener('click', () => {
      const next = collect();
      state.draft = next;
      next.parents.push({ asin: '' });
      renderProductEditor(state, next, isNew);
    });
    modal.querySelectorAll('[data-rmparent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = collect();
        next.parents.splice(Number(btn.dataset.rmparent), 1);
        renderProductEditor(state, next, isNew);
      });
    });
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => state.closer()));
    modal.querySelector('[data-back]').addEventListener('click', () => renderProductConfig(state));
    modal.querySelector('[data-save]').addEventListener('click', async () => {
      const item = collect();
      if (!item.spu) {
        toast('SPU 不能为空');
        return;
      }
      if (!item.parents.length) {
        toast('至少填一个父体 ASIN');
        return;
      }
      const next = state.products.slice();
      if (isNew) {
        if (next.some((p) => p.spu === item.spu)) {
          toast('这个 SPU 已经登记过了');
          return;
        }
        next.push(item);
      } else {
        next[state.editing] = item;
      }
      if (await saveProductConfig(state, next)) {
        toast('已保存');
        renderProductConfig(state);
      }
    });
    const delBtn = modal.querySelector('[data-del]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const item = state.products[state.editing];
        const ok = confirm('删除「' + item.spu + '」？\n它的目标与成本也会一起删掉（配置文件有备份）。');
        if (!ok) return;
        const next = state.products.filter((_, i) => i !== state.editing);
        if (await saveProductConfig(state, next)) {
          toast('已删除');
          renderProductConfig(state);
        }
      });
    }
  }

  async function saveProductConfig(state, next) {
    try {
      const resp = await fetch('/api/skill/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: state.skill.id, mtimeMs: state.mtimeMs, products: next }),
      });
      const data = await resp.json();
      if (!data.ok) {
        alert('保存失败：' + (data.error || '未知错误'));
        return false;
      }
      state.mtimeMs = data.mtimeMs;
      const pd = data.files[CFG_PRODUCTS] || {};
      const td = data.files[CFG_TARGETS] || {};
      state.products = (pd.products || []).map((p) => {
        const bare = String(p.spu || '').replace(/^LS-/, '');
        return { ...p, target: td[p.spu] || td[bare] || {} };
      });
      // 通知技能卡片：产品变了，重新渲染勾选列表
      try {
        window.dispatchEvent(new CustomEvent('skillcfg:saved', { detail: { skillId: state.skill.id } }));
      } catch {
        /* 忽略 */
      }
      return true;
    } catch (err) {
      alert('保存失败：' + err.message);
      return false;
    }
  }

  function showModal(html, opts) {
    const root = $('#modalRoot');
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const modal = document.createElement('div');
    modal.className = 'modal' + (opts && opts.narrow ? ' narrow' : '');
    modal.innerHTML = html;
    overlay.append(modal);
    root.append(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    close.overlay = overlay;
    close.modal = modal;
    const onKey = (e) => {
      if (e.key === 'Escape' && root.lastElementChild === overlay) close();
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    return close;
  }

  function confirmDialog(title, text, danger) {
    return new Promise((resolve) => {
      const html =
        '<div class="modal-head"><div><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div></div>' +
        '<div class="modal-actions"><button class="btn ghost" data-close type="button">取消</button>' +
        '<button class="btn ' + (danger ? 'danger' : 'primary') + '" data-ok type="button">确定</button></div>';
      const close = showModal(html, { narrow: true });
      const modal = close.modal;
      modal.querySelector('[data-ok]').addEventListener('click', () => {
        close();
        resolve(true);
      });
      modal.querySelector('[data-close]').addEventListener('click', () => resolve(false));
      close.overlay.addEventListener('click', (e) => {
        if (e.target === close.overlay) resolve(false);
      });
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Escape') resolve(false);
        },
        { once: true }
      );
    });
  }

  function showSettings() {
    const key = state.settings.key || '';
    const html =
      '<div class="modal-head"><div><h2>设置</h2><p>Key 与偏好只保存在这台电脑的浏览器里。</p></div><button class="modal-close" data-close type="button">×</button></div>' +
      '<div class="setting-row"><div><div class="s-label">DeepSeek API Key</div><div class="s-help">在 platform.deepseek.com 创建，按量计费。不会上传到我们的服务器。</div>' +
      '<div class="key-actions"><button class="btn" id="testKey" type="button">测试连接</button><span class="key-state" id="keyState"></span></div></div>' +
      '<div class="s-control"><div class="key-wrap"><input type="password" id="setKey" value="' + esc(key) + '" placeholder="sk-..." autocomplete="off">' +
      '<button class="key-eye" id="eyeBtn" type="button" title="显示 Key">' + EYE_SVG + '</button></div></div></div>' +
      '<div class="setting-row"><div><div class="s-label">默认模型</div><div class="s-help">Flash 响应快，适合大多数运营任务；V4 Pro 更慢，复杂分析更稳。</div></div>' +
      '<div class="s-control"><select id="setModel"><option value="deepseek-flash">deepseek-flash</option><option value="deepseek-v4-pro">deepseek-v4-pro</option></select></div></div>' +
      '<div class="setting-row"><div><div class="s-label">配色</div><div class="s-help">界面主题，跟随系统或手动指定。</div></div>' +
      '<div class="s-control"><select id="setTheme"><option value="auto">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div></div>' +
      '<div class="setting-row"><div><div class="s-label">新对话默认开启</div><div class="s-help">联网按次计费；深度思考更慢，但复杂任务更稳。</div></div>' +
      '<div class="s-control"><label class="switch"><input type="checkbox" id="setSearch"> 联网</label><label class="switch"><input type="checkbox" id="setThink"> 深度思考</label></div></div>' +
      '<div class="setting-row"><div><div class="s-label">工作文件夹</div><div class="s-help">AI 生成的文件都保存在这里，可以直接打开查看。</div></div>' +
      '<div class="s-control"><button class="btn" id="openWs" type="button">打开文件夹</button></div></div>' +
      '<div class="setting-row"><div><div class="s-label">数据</div><div class="s-help">导出全部对话为 JSON；清空只删除本机对话记录。</div></div>' +
      '<div class="s-control"><button class="btn" id="exportBtn" type="button">导出</button><button class="btn danger" id="clearBtn" type="button">清空</button></div></div>' +
      '<div class="setting-row"><div><div class="s-label">版本与更新</div>' +
      '<div class="s-help">当前 v' + esc(state.cfg ? state.cfg.version : '?') + '。检查到新版本可以在应用内直接下载、自动重启。</div>' +
      '<div class="upd-state" id="updState"></div></div>' +
      '<div class="s-control"><button class="btn" id="updCheck" type="button">检查更新</button>' +
      '<button class="btn primary hidden" id="updApply" type="button">下载并更新</button>' +
      '<button class="btn ghost" id="updRestart" type="button">重启生效</button></div></div>' +
      '<div class="upd-progress hidden" id="updProgress"><div class="upd-bar"><span id="updBar"></span></div><div class="upd-msg" id="updMsg"></div></div>' +
      '<div class="modal-actions"><span class="left" style="font-size:10.5px;color:var(--faint);align-self:center">' + esc(state.cfg ? state.cfg.brand + ' v' + state.cfg.version : '') + '</span>' +
      '<button class="btn ghost" data-close type="button">取消</button><button class="btn primary" id="saveSet" type="button">保存</button></div>';

    const close = showModal(html, { wide: true });
    // ---- 重启生效（更新完版本没变时用） ----
    const restartBtn = document.getElementById('updRestart');
    if (restartBtn) {
      restartBtn.addEventListener('click', async () => {
        restartBtn.disabled = true;
        restartBtn.textContent = '重启中…';
        try {
          await fetch('/api/restart', { method: 'POST' });
          toast('已发出重启，6 秒后自动刷新');
          setTimeout(() => location.reload(), 6000);
        } catch (err) {
          toast('重启失败：' + err.message, true);
          restartBtn.disabled = false;
          restartBtn.textContent = '重启生效';
        }
      });
    }
    // ---- 版本与更新 ----
    const updState = $('#updState');
    const updApply = $('#updApply');
    const updProgress = $('#updProgress');
    const updBar = $('#updBar');
    const updMsg = $('#updMsg');
    let updTimer = null;

    const showProgress = (percent, message) => {
      if (!updProgress) return;
      updProgress.classList.remove('hidden');
      if (updBar) updBar.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
      if (updMsg) updMsg.textContent = message || '';
    };

    const pollUpdate = () => {
      clearInterval(updTimer);
      updTimer = setInterval(async () => {
        let st = null;
        try {
          st = await fetch('/api/update/status').then((r) => r.json());
        } catch {
          showProgress(100, '正在重启，页面稍后自动刷新…');
          clearInterval(updTimer);
          setTimeout(() => location.reload(), 5000);
          return;
        }
        if (!st || !st.ok) return;
        showProgress(st.phase === 'downloading' ? st.percent : 100, st.message || st.phase);
        if (st.phase === 'restarting') {
          clearInterval(updTimer);
          setTimeout(() => location.reload(), 6000);
        } else if (st.phase === 'error') {
          clearInterval(updTimer);
          if (updApply) updApply.disabled = false;
        } else if (st.phase === 'done') {
          clearInterval(updTimer);
        }
      }, 900);
    };

    const updCheckBtn = $('#updCheck');
    if (updCheckBtn) {
      updCheckBtn.addEventListener('click', async () => {
        updCheckBtn.disabled = true;
        if (updState) updState.textContent = '正在检查…';
        try {
          const r = await fetch('/api/update/check?force=1').then((x) => x.json());
          if (!r.ok) {
            if (updState) updState.textContent = '检查失败：' + (r.error || '网络不通');
          } else if (r.hasUpdate) {
            if (updState) updState.innerHTML = '发现新版本 <b>v' + esc(r.latest) + '</b>（当前 v' + esc(r.current) + '）';
            if (updApply) updApply.classList.remove('hidden');
          } else {
            if (updState) updState.textContent = '已经是最新版本（v' + r.current + '）';
          }
        } catch (err) {
          if (updState) updState.textContent = '检查失败：' + err.message;
        } finally {
          updCheckBtn.disabled = false;
        }
      });
    }

    if (updApply) {
      updApply.addEventListener('click', async () => {
        updApply.disabled = true;
        showProgress(0, '准备下载…');
        try {
          const r = await fetch('/api/update/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).then((x) => x.json());
          if (!r.ok) {
            showProgress(0, '启动更新失败：' + (r.error || '未知错误'));
            updApply.disabled = false;
            return;
          }
          pollUpdate();
        } catch (err) {
          showProgress(0, '启动更新失败：' + err.message);
          updApply.disabled = false;
        }
      });
    }

    $('#setModel').value = state.settings.model || (state.cfg && state.cfg.model) || 'deepseek-flash';
    $('#setTheme').value = state.settings.theme || 'auto';
    $('#setSearch').checked = Boolean(state.settings.search);
    $('#setThink').checked = Boolean(state.settings.thinking);

    $('#eyeBtn').addEventListener('click', () => {
      const input = $('#setKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    $('#testKey').addEventListener('click', async () => {
      const value = $('#setKey').value.trim();
      const st = $('#keyState');
      if (!value) {
        st.className = 'key-state err';
        st.textContent = '先填 Key';
        return;
      }
      st.className = 'key-state';
      st.textContent = '测试中…';
      try {
        const r = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: value }) });
        const d = await r.json();
        if (d.ok) {
          st.className = 'key-state ok';
          st.textContent = '连接正常';
        } else {
          st.className = 'key-state err';
          st.textContent = d.error || '连接失败';
        }
      } catch (err) {
        st.className = 'key-state err';
        st.textContent = '连接失败：' + err.message;
      }
    });

    $('#openWs').addEventListener('click', async () => {
      await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });
    $('#exportBtn').addEventListener('click', () => {
      window.location.href = '/api/export';
    });
    $('#clearBtn').addEventListener('click', async () => {
      const ok = await confirmDialog('清空所有对话？', '只删除本机对话记录，workspace 里生成的文件会保留。', true);
      if (!ok) return;
      await fetch('/api/clear', { method: 'POST' });
      state.sessions = [];
      newChat();
      renderSessions();
      close();
      toast('已清空');
    });

    $('#saveSet').addEventListener('click', () => {
      state.settings.key = $('#setKey').value.trim();
      state.settings.model = $('#setModel').value;
      state.settings.theme = $('#setTheme').value;
      state.settings.search = $('#setSearch').checked;
      state.settings.thinking = $('#setThink').checked;
      saveSettings();
      applyTheme();
      updateToggles();
      updateModelTag();
      close();
      toast('设置已保存');
    });
  }

  // ---------------- 更新提醒 ----------------

  async function checkUpdateSilently() {
    try {
      const info = await fetch('/api/update/check').then((r) => r.json());
      if (!info || !info.ok) return;
      state.updateInfo = info;
      const dot = $('#updDot');
      if (dot && info.hasUpdate) {
        dot.classList.remove('hidden');
        dot.textContent = '';
        const key = 'ecom.updateNotified';
        if (localStorage.getItem(key) !== info.latest) {
          localStorage.setItem(key, info.latest);
          toast('有新版本 v' + info.latest + '，点左下角「说明」可以更新');
        }
      }
    } catch {
      /* 检查失败就算了，不打扰用户 */
    }
  }

  async function startUpdate({ bar, msg, btn }) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '更新中…';
    }
    const setP = (p, text) => {
      if (bar) bar.style.width = Math.max(0, Math.min(100, p || 0)) + '%';
      if (msg) msg.textContent = text || '';
    };
    setP(0, '准备下载…');
    try {
      const r = await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || '启动失败');
      const timer = setInterval(async () => {
        let st = null;
        try {
          st = await fetch('/api/update/status').then((x) => x.json());
        } catch {
          clearInterval(timer);
          setP(100, '正在重启，页面稍后自动刷新…');
          setTimeout(() => location.reload(), 6000);
          return;
        }
        if (!st || !st.ok) return;
        setP(st.phase === 'downloading' ? st.percent : 100, st.message || st.phase);
        if (st.phase === 'restarting') {
          clearInterval(timer);
          setTimeout(() => location.reload(), 6000);
        } else if (st.phase === 'error' || st.phase === 'done') {
          clearInterval(timer);
          if (btn) {
            btn.disabled = false;
            btn.textContent = '下载并更新';
          }
        }
      }, 900);
    } catch (err) {
      setP(0, '更新失败：' + err.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '下载并更新';
      }
    }
  }

  function showHelp() {
    const html =
      '<div class="modal-head"><div><h2>使用说明</h2><p>三步开始，以及常用快捷键。</p></div><button class="modal-close" data-close type="button">×</button></div>' +
      updateBlockHtml() +
      '<div class="help">' +
      '<h3>1. 填 Key</h3><p>到 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com</a> 创建 API Key，在「设置」里填入。按量计费，每次回答下方会显示本次用量。</p>' +
      '<h3>2. 选技能</h3><p>左侧技能库覆盖选品、Listing、关键词、广告、竞品、差评、利润、库存、合规、客服。点开一个技能，填几项信息，或者直接用常用问法开始。</p>' +
      '<h3>3. 丢材料</h3><p>Excel、PDF、Word、图片都可以直接上传。广告搜索词报告、ABA 数据、竞品截图，越具体结果越好。</p>' +
      '<h3>它会做什么</h3><ul>' +
      '<li>需要最新政策或趋势时，联网查询（开启「联网」）。</li>' +
      '<li>需要算账时，在受限环境里跑代码，不靠口算。</li>' +
      '<li>把 Listing、报告、测算表写成文件，落在 <code>workspace/</code>，可直接打开或下载。</li></ul>' +
      '<h3>快捷键</h3>' +
      '<div class="kbd-line"><b>Enter</b><span>发送</span></div>' +
      '<div class="kbd-line"><b>Shift + Enter</b><span>换行</span></div>' +
      '<div class="kbd-line"><b>Ctrl + K</b><span>新对话</span></div>' +
      '<h3>安全与隐私</h3><p>对话记录和文件只存在这台电脑上；API Key 存在浏览器本地，请求直接发往 DeepSeek 官方接口。生成的内容请自行复核，尤其是合规、税务与平台政策。</p>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn primary" data-close type="button">关闭</button></div>';
    const close = showModal(html, { wide: true });
    const box = close.modal;
    bindUpdateBlock(box);
  }

  function updateBlockHtml() {
    const info = state.updateInfo;
    if (!info) {
      return '<div class="upd-inline"><span class="upd-inline-text">版本 v' + esc(state.cfg ? state.cfg.version : '') + '</span></div>';
    }
    if (!info.hasUpdate) {
      return '<div class="upd-inline"><span class="upd-inline-text">已是最新版本 v' + esc(state.cfg ? state.cfg.version : '') + '</span></div>';
    }
    return (
      '<div class="upd-inline has-new"><div class="upd-inline-head">有新版本 <b>v' + esc(info.latest) + '</b>（当前 v' + esc(info.current) + '）</div>' +
      '<div class="upd-progress"><div class="upd-bar"><span data-updbar></span></div><div class="upd-msg" data-updmsg></div></div>' +
      '<div class="upd-inline-actions"><button class="btn primary small" type="button" data-updapply>下载并更新</button>' +
      '<a class="btn small ghost" href="' + esc(info.pageUrl || '') + '" target="_blank" rel="noopener">看更新内容</a></div></div>'
    );
  }

  function bindUpdateBlock(root) {
    const btn = root.querySelector('[data-updapply]');
    if (!btn) return;
    btn.addEventListener('click', () =>
      startUpdate({ bar: root.querySelector('[data-updbar]'), msg: root.querySelector('[data-updmsg]'), btn })
    );
  }

  const EYE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.5"/></svg>';

  function showOnboarding() {
    if (document.getElementById('onboard')) return;
    const div = document.createElement('div');
    div.className = 'onboard';
    div.id = 'onboard';
    div.innerHTML =
      '<div class="onboard-card">' +
      '<div class="brand"><div class="brand-mark"><svg viewBox="0 0 32 32" fill="none"><rect x="1" y="1" width="30" height="30" rx="8" fill="currentColor"/><path d="M9.5 20.5 15.2 12l3.2 4.2 2.1-2.6 3.9 6.9H9.5Z" fill="#f7f3ea" class="logo-fg"/><circle cx="21.8" cy="10.6" r="1.7" fill="#f7f3ea" class="logo-fg"/></svg></div>' +
      '<div class="brand-text"><div class="brand-name">' + esc(state.cfg ? state.cfg.brand : '跨境 AI 工作台') + '</div><div class="brand-sub">' + esc(state.cfg ? state.cfg.brandEn : 'Ecom Workbench') + '</div></div></div>' +
      '<h1>连接 DeepSeek</h1>' +
      '<p class="sub">填入 API Key 后即可开始。Key 只保存在这台电脑的浏览器里，请求直接发往 DeepSeek。</p>' +
      '<div class="steps">' +
      '<div class="step"><span class="n">1</span><span>打开 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">platform.deepseek.com</a>，创建一个 API Key。</span></div>' +
      '<div class="step"><span class="n">2</span><span>账户里留一点余额，按量计费。</span></div>' +
      '<div class="step"><span class="n">3</span><span>把 <code>sk-</code> 开头的 Key 粘贴到下面。</span></div>' +
      '</div>' +
      '<div class="key-box"><label>API Key</label><div class="key-wrap"><input type="password" id="obKey" placeholder="sk-..." autocomplete="off" spellcheck="false"><button class="key-eye" id="obEye" type="button" title="显示 Key">' + EYE_SVG + '</button></div>' +
      '<div class="err" id="obErr"></div>' +
      '<div class="hint">费用按实际 token 计算，每次回答下方会显示用量。</div></div>' +
      '<div class="actions"><button class="btn primary" id="obStart" type="button">保存并开始</button></div>' +
      '<button class="skip" id="obSkip" type="button">稍后设置</button>' +
      '</div>';
    document.body.append(div);
    $('#obEye').addEventListener('click', () => {
      const input = $('#obKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    const start = () => {
      const value = $('#obKey').value.trim();
      if (!value) {
        $('#obErr').textContent = '请先填入 Key';
        return;
      }
      if (!/^sk-/.test(value)) {
        $('#obErr').textContent = 'Key 一般以 sk- 开头，请检查一下';
        return;
      }
      state.settings.key = value;
      saveSettings();
      div.remove();
      toast('Key 已保存');
      $('#input').focus();
    };
    $('#obStart').addEventListener('click', start);
    $('#obKey').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') start();
    });
    $('#obSkip').addEventListener('click', () => div.remove());
    setTimeout(() => $('#obKey').focus(), 80);
  }

  /* ================= 事件 ================= */

  // ---------------- 知识库 ----------------
  const kb = { items: [], categories: [], sources: [], filter: '', q: '' };

  async function loadKnowledge() {
    try {
      const resp = await fetch('/api/knowledge' + (kb.q ? '?q=' + encodeURIComponent(kb.q) : ''));
      const data = await resp.json();
      if (!data.ok) return;
      kb.items = data.items || [];
      kb.categories = data.categories || [];
      kb.sources = data.sources || [];
      renderKnowledge();
      const count = document.getElementById('navKnowledgeCount');
      if (count) count.textContent = String(kb.items.length);
      const counter = document.getElementById('kbCount');
      if (counter) counter.textContent = '已收录 ' + kb.items.length + ' 条';
    } catch {
      /* 忽略 */
    }
  }

  function renderKnowledge() {
    const list = document.getElementById('kbList');
    if (!list) return;
    const catSel = document.getElementById('kbCategory');
    const srcSel = document.getElementById('kbSource');
    if (catSel && !catSel.options.length) {
      catSel.innerHTML = kb.categories.map((c) => '<option>' + esc(c) + '</option>').join('');
    }
    if (srcSel && !srcSel.options.length) {
      srcSel.innerHTML = kb.sources.map((c) => '<option>' + esc(c) + '</option>').join('');
    }
    const filters = document.getElementById('kbFilters');
    if (filters) {
      filters.innerHTML = ['', ...kb.categories]
        .map(
          (c) =>
            '<button class="kb-chip' + (kb.filter === c ? ' active' : '') + '" type="button" data-kbcat="' +
            esc(c) + '">' + (c || '全部') + '</button>'
        )
        .join('');
      filters.querySelectorAll('[data-kbcat]').forEach((b) =>
        b.addEventListener('click', () => {
          kb.filter = b.dataset.kbcat || '';
          renderKnowledge();
        })
      );
    }
    const items = kb.items.filter((x) => (kb.filter ? x.category === kb.filter : true));
    if (!items.length) {
      list.innerHTML =
        '<div class="kb-empty">' +
        '<div class="kb-empty-title">还没有知识点。先写三条试试：</div>' +
        '<div class="kb-empty-sub">建议先给这三个分类各写一条红线</div>' +
        '<div class="kb-empty-cats"><span>Listing</span><span>广告</span><span>仓储备货</span></div>' +
        '<button class="btn primary" type="button" id="kbEmptyStart">写第一条</button>' +
        '</div>';
      const startBtn = document.getElementById('kbEmptyStart');
      if (startBtn) {
        startBtn.addEventListener('click', () => {
          const box = document.getElementById('kbContent');
          if (box) box.focus();
        });
      }
      return;
    }
    list.innerHTML = items
      .map(
        (it) =>
          '<div class="kb-item" data-id="' + it.id + '">' +
          '<div class="kb-meta"><span class="kb-tag">' + esc(it.category) + '</span>' +
          '<span class="kb-date">生效 ' + esc(it.effective || '-') + (it.expires ? ' · 失效 ' + esc(it.expires) : '') + '</span>' +
          '<span class="kb-src">' + esc(it.source || '手写') + '</span></div>' +
          '<div class="kb-body">' + esc(it.content) + '</div>' +
          (it.note ? '<div class="kb-note">备注：' + esc(it.note) + '</div>' : '') +
          '<div class="kb-acts"><button class="btn small ghost" type="button" data-kbedit>编辑</button>' +
          '<button class="btn small ghost" type="button" data-kbdel>删除</button></div>' +
          '</div>'
      )
      .join('');

    list.querySelectorAll('.kb-item').forEach((el) => {
      const id = el.dataset.id;
      const item = kb.items.find((x) => x.id === id);
      if (!item) return;
      el.querySelector('[data-kbdel]').addEventListener('click', async () => {
        if (!confirm('删除这条知识？（软删除，文件里还留着）')) return;
        await fetch('/api/knowledge?id=' + encodeURIComponent(id), { method: 'DELETE' });
        loadKnowledge();
      });
      el.querySelector('[data-kbedit]').addEventListener('click', () => {
        const cats = kb.categories.map((c) => '<option' + (c === item.category ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
        const srcs = kb.sources.map((c) => '<option' + (c === (item.source || '手写') ? ' selected' : '') + '>' + esc(c) + '</option>').join('');
        el.innerHTML =
          '<div class="kb-edit">' +
          '<div class="kb-row">' +
          '<label class="kb-field kb-narrow"><span>分类</span><select data-e="category">' + cats + '</select></label>' +
          '<label class="kb-field kb-narrow"><span>生效</span><input type="date" data-e="effective" value="' + esc(item.effective || '') + '"></label>' +
          '<label class="kb-field kb-narrow"><span>失效（可选）</span><input type="date" data-e="expires" value="' + esc(item.expires || '') + '"></label>' +
          '<label class="kb-field kb-narrow"><span>来源</span><select data-e="source">' + srcs + '</select></label>' +
          '</div>' +
          '<label class="kb-field kb-full"><span>内容</span><textarea rows="3" data-e="content">' + esc(item.content) + '</textarea></label>' +
          '<label class="kb-field kb-full"><span>备注（可选）</span><input type="text" data-e="note" value="' + esc(item.note || '') + '"></label>' +
          '<div class="kb-acts"><button class="btn small primary" type="button" data-esave>保存</button>' +
          '<button class="btn small ghost" type="button" data-ecancel>取消</button></div>' +
          '</div>';

        el.querySelector('[data-ecancel]').addEventListener('click', () => renderKnowledge());
        el.querySelector('[data-esave]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          const val = (k) => {
            const n = el.querySelector('[data-e="' + k + '"]');
            return n ? n.value : '';
          };
          try {
            const resp = await fetch('/api/knowledge', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id,
                category: val('category'),
                effective: val('effective'),
                expires: val('expires'),
                source: val('source'),
                content: val('content'),
                note: val('note'),
              }),
            });
            const data = await resp.json();
            if (!data.ok) throw new Error(data.error || '保存失败');
            toast('已保存');
            loadKnowledge();
          } catch (err) {
            toast('没保存：' + err.message, true);
            btn.disabled = false;
          }
        });
      });
    });
  }

  async function addKnowledge() {
    const btn = document.getElementById('kbAdd');
    const content = document.getElementById('kbContent');
    const note = document.getElementById('kbNote');
    const cat = document.getElementById('kbCategory');
    const eff = document.getElementById('kbEffective');
    const exp = document.getElementById('kbExpires');
    const src = document.getElementById('kbSource');
    if (!content || !content.value.trim()) return toast('内容不能为空', true);
    btn.disabled = true;
    try {
      const resp = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.value.trim(),
          note: note ? note.value.trim() : '',
          category: cat ? cat.value : '其他',
          effective: eff ? eff.value : '',
          expires: exp ? exp.value : '',
          source: src ? src.value : '手写',
        }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || '保存失败');
      content.value = '';
      if (note) note.value = '';
      toast('已保存');
      loadKnowledge();
    } catch (err) {
      toast('没保存：' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function bindKnowledge() {
    // 第一次进来自动展开「怎么用」，之后保持收起
    const help = document.getElementById('kbHelp');
    if (help) {
      let seen = '';
      try {
        seen = localStorage.getItem('kbHelpSeen') || '';
      } catch {
        seen = '1';
      }
      if (!seen) {
        help.open = true;
        try {
          localStorage.setItem('kbHelpSeen', '1');
        } catch {
          /* 忽略 */
        }
      }
    }

    const add = document.getElementById('kbAdd');
    if (add) add.addEventListener('click', addKnowledge);
    const search = document.getElementById('kbSearch');
    if (search) {
      let timer = 0;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          kb.q = search.value.trim();
          loadKnowledge();
        }, 300);
      });
    }
    const eff = document.getElementById('kbEffective');
    if (eff) eff.value = new Date().toISOString().slice(0, 10);
  }

  function bindEvents() {
    // @ 选员工
    const atInput = $('#input');
    atInput.addEventListener('input', () => {
      const q = atQuery();
      if (q === null) closeAtMenu();
      else renderAtMenu(q);
    });
    atInput.addEventListener('keydown', (e) => {
      const items = atItems();
      if (!items.length) {
        if (e.key === 'Escape') closeAtMenu();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setAtActive(atActive + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setAtActive(atActive - 1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        pickAtActive();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAtMenu();
      }
    });
    document.addEventListener('click', (e) => {
      const menu = $('#atMenu');
      if (!menu || menu.classList.contains('hidden')) return;
      if (menu.contains(e.target)) return;
      // 触发按钮自己会开关菜单，别在这里抢先关掉
      if (e.target.closest && e.target.closest('#agentBtn, #skillPickBtn')) return;
      closeAtMenu();
    });
    const skillPickBtn = $('#skillPickBtn');
if (skillPickBtn) {
      skillPickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = $('#atMenu');
        if (menu && !menu.classList.contains('hidden')) {
          closeAtMenu();
          return;
        }
        openSkillPicker();
      });
    }
    const agentBtn = $('#agentBtn');
    if (agentBtn) {
      agentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = $('#atMenu');
        if (menu && !menu.classList.contains('hidden')) {
          closeAtMenu();
          return;
        }
        $('#input').focus();
        renderAtMenu('');
      });
    }
    $('#newChat').addEventListener('click', () => newChat());
    $$('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.view));
    });
    $('#welcomeSkills').addEventListener('click', () => showView('skills'));
    $('#addMcp').addEventListener('click', () => openMcpModal(null));
    $('#skillSearch').addEventListener('input', (e) => {
      state.skillFilter.q = e.target.value;
      renderSkillsPage();
    });
    $('#outputSearch').addEventListener('input', (e) => {
      state.outputFilter.q = e.target.value;
      renderOutputsPage();
    });
    $('#outputOnlyDocs').addEventListener('click', () => {
      state.outputFilter.onlyDocs = !state.outputFilter.onlyDocs;
      const btn = $('#outputOnlyDocs');
      btn.classList.toggle('active', state.outputFilter.onlyDocs);
      btn.textContent = state.outputFilter.onlyDocs ? '只看报告' : '全部文件';
      renderOutputsPage();
    });
    $('#outputsRefresh').addEventListener('click', () => loadOutputs(true));
    $('#jumpBottom').addEventListener('click', jumpToBottom);
    let stickTimer = null;
    $('#chat').addEventListener(
      'scroll',
      () => {
        if (stickTimer) return;
        stickTimer = setTimeout(() => {
          stickTimer = null;
          const chat = $('#chat');
          if (!chat) return;
          state.chatStick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
          updateJumpBtn();
        }, 80);
      },
      { passive: true }
    );
    $('#outputsFolder').addEventListener('click', async () => {
      try {
        await fetch('/api/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch {
        toast('打不开文件夹');
      }
    });
    $('#sendBtn').addEventListener('click', () => {
      if (state.streaming) {
        state.abortedByUser = true;
        if (state.controller) state.controller.abort();
        return;
      }
      send();
    });
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    $('#input').addEventListener('input', autoGrow);
    $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('#searchBtn').addEventListener('click', () => {
      state.settings.search = !state.settings.search;
      saveSettings();
      updateToggles();
      toast(state.settings.search ? '已开启联网：需要最新信息时会自动查' : '已关闭联网');
    });
    $('#thinkBtn').addEventListener('click', () => {
      state.settings.thinking = !state.settings.thinking;
      saveSettings();
      updateToggles();
    });
    $('#clearSkill').addEventListener('click', clearSkill);
    $('#skillChip').addEventListener('click', () => {
      if (state.skill) openSkill(state.skill);
    });
    const agentChipBtn = $('#agentChip');
    if (agentChipBtn) agentChipBtn.addEventListener('click', () => showView('agents'));
    $('#settingsBtn').addEventListener('click', showSettings);
    $('#themeBtn').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      state.settings.theme = dark ? 'light' : 'dark';
      saveSettings();
      applyTheme();
    });
    $('#menuBtn').addEventListener('click', toggleSidebar);
    $('#backdrop').addEventListener('click', closeSidebar);
    $('#clearHistory').addEventListener('click', async () => {
      if (!state.sessions.length) return;
      const ok = await confirmDialog('清空最近对话？', '所有本机对话记录都会删除，workspace 里的文件保留。', true);
      if (!ok) return;
      await fetch('/api/clear', { method: 'POST' });
      state.sessions = [];
      newChat();
      renderSessions();
      toast('已清空');
    });
    $$('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'settings') showSettings();
        if (btn.dataset.action === 'help') showHelp();
      });
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newChat();
      }
    });
    document.addEventListener('click', (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        const code = copy.closest('.code-block');
        if (code) {
          copyText(code.querySelector('code').textContent);
          const old = copy.textContent;
          copy.textContent = '已复制';
          setTimeout(() => {
            copy.textContent = old;
          }, 1200);
        }
      }
    });
    const composer = $('#composer');
    ['dragenter', 'dragover'].forEach((ev) =>
      composer.addEventListener(ev, (e) => {
        e.preventDefault();
        composer.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      composer.addEventListener(ev, (e) => {
        e.preventDefault();
        composer.classList.remove('dragover');
        if (ev === 'drop' && e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
      })
    );
    $('#input').addEventListener('paste', (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.settings.theme === 'auto') applyTheme();
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.streaming) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ================= 工具函数 ================= */

  function autoGrow() {
    const input = $('#input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }

  function scrollToBottom(instant) {
    const chat = $('#chat');
    if (!chat) return;
    state.chatStick = true;
    chat.style.scrollBehavior = 'auto';
    chat.scrollTop = chat.scrollHeight;
    updateJumpBtn();
  }

  // 粘底：默认跟着最新内容走；用户主动往上滚就停止跟随
  function scrollMaybe(force) {
    const chat = $('#chat');
    if (!chat) return;
    if (state.chatStick || force) {
      chat.scrollTop = chat.scrollHeight;
    }
    updateJumpBtn();
  }

  function updateJumpBtn() {
    const chat = $('#chat');
    const btn = $('#jumpBottom');
    if (!chat || !btn) return;
    const far = chat.scrollHeight - chat.scrollTop - chat.clientHeight > 160;
    btn.classList.toggle('show', far && !state.chatStick);
  }

  function jumpToBottom() {
    state.chatStick = true;
    const chat = $('#chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
    updateJumpBtn();
  }

  function toggleSidebar() {
    $('#sidebar').classList.toggle('open');
    $('#backdrop').classList.toggle('show');
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#backdrop').classList.remove('show');
  }

  function toolVerb(name) {
    const map = { web_search: '搜索', read_url: '读取网页', read_file: '读文件', write_file: '写文件', run_javascript: '计算', list_files: '查看文件' };
    return map[name] || '处理';
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function formatSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtNum(n) {
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
    const d = new Date(ts);
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text || '');
      toast('已复制');
    } catch {
      toast('复制失败，请手动选择', true);
    }
  }

  let toastTimer = null;
  function toast(message, isError) {
    const t = $('#toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.className = 'toast' + (isError ? ' error' : '');
    }, isError ? 4200 : 2200);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
