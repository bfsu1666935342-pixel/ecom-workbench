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
      showView('chat');
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
    $('#brandSub').textContent = state.cfg.brandEn;
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
    state.agent = agent;
    state.skill = null;
    if (state.session) {
      state.session.skillId = null;
      state.session.agentId = agent ? agent.id : null;
    }
    newChat(true);
    showView('chat');
    updateSkillUI();
    const input = $('#input');
    if (input) input.focus();
  }

  function showView(view) {
    state.view = view;
    $('#chatView').classList.toggle('hidden', view !== 'chat');
    $('#skillsView').classList.toggle('hidden', view !== 'skills');
    $('#agentsView').classList.toggle('hidden', view !== 'agents');
    $('#mcpView').classList.toggle('hidden', view !== 'mcp');
    $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
    if (view === 'chat') {
      $('#chatTitle').textContent = state.session && state.session.title ? state.session.title : '新对话';
      updateSkillUI();
    } else if (view === 'skills') {
      $('#chatTitle').textContent = '技能库';
      updateSkillUI();
    } else if (view === 'agents') {
      $('#chatTitle').textContent = '员工';
      renderAgentsPage();
      updateSkillUI();
      renderSkillFilters();
      renderSkillsPage();
    } else {
      $('#chatTitle').textContent = '数据源';
      updateSkillUI();
      renderMcpPage();
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
      '<p>填写服务商提供的 MCP 地址和 Key。保存后点「保存并测试」读取工具列表。</p></div>' +
      '<div class="modal-head-actions">' +
      (s.preset === 'lingxing' ? '<button class="link-btn" id="mcpHelp" type="button">帮助</button>' : '') +
      '<button class="modal-close" data-close type="button">×</button></div></div>' +
      '<div class="field"><label>名称</label><input type="text" id="mcpName" value="' + esc(s.name) + '" placeholder="例如：领星 ERP"></div>' +
      '<div class="field"><label>MCP 地址</label><input type="text" id="mcpUrl" value="' + esc(s.url || '') + '" placeholder="https://.../mcp" spellcheck="false"></div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>认证方式</label><select id="mcpAuth">' +
      '<option value="bearer"' + (s.authMode === 'bearer' ? ' selected' : '') + '>Bearer Token</option>' +
      '<option value="query"' + (s.authMode === 'query' ? ' selected' : '') + '>URL 参数 key</option>' +
      '<option value="headers"' + (s.authMode === 'headers' ? ' selected' : '') + '>自定义 Headers</option>' +
      '</select></div>' +
      '<div class="field"><label id="mcpTokenLabel">访问令牌 / Key</label><input type="password" id="mcpToken" value="' + esc(s.token || '') + '" placeholder="服务商控制台里的 Key" autocomplete="off"></div>' +
      '</div>' +
      '<div class="field" id="mcpKeyParamField"><label>URL 参数名</label><input type="text" id="mcpKeyParam" value="' + esc(s.keyParam || 'key') + '" placeholder="key"><div class="mcp-form-help">Sorftime 默认用 key 放在 URL 参数里；其他服务商以文档为准。</div></div>' +
      '<div class="field"><label>附加 Headers（JSON，可选）</label><textarea id="mcpHeaders" rows="3" spellcheck="false">' + esc(JSON.stringify(s.headers || {}, null, 2)) + '</textarea><div class="mcp-form-help">例如 {"X-API-Key":"..."}。不要在这里重复写 Authorization，除非服务商要求。</div></div>' +
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
    const helpBtn = modal.querySelector('#mcpHelp');
    if (helpBtn) helpBtn.addEventListener('click', () => openLingxingHelp(true));
    const keyField = modal.querySelector('#mcpKeyParamField');
    const tokenLabel = modal.querySelector('#mcpTokenLabel');
    const syncAuth = () => {
      const mode = modal.querySelector('#mcpAuth').value;
      keyField.classList.toggle('hidden', mode !== 'query');
      tokenLabel.textContent = mode === 'query' ? 'URL 参数 Key' : '访问令牌 / Key';
    };
    modal.querySelector('#mcpAuth').addEventListener('change', syncAuth);
    syncAuth();

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
      return {
        id: s.id || undefined,
        preset: s.preset || 'custom',
        name: modal.querySelector('#mcpName').value.trim() || 'MCP',
        url: modal.querySelector('#mcpUrl').value.trim(),
        authMode: modal.querySelector('#mcpAuth').value,
        token: modal.querySelector('#mcpToken').value.trim(),
        keyParam: modal.querySelector('#mcpKeyParam').value.trim() || 'key',
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
      '<div class="modal-head"><div><h2>领星 MCP 怎么填</h2>' +
      '<p>领星用自定义 Header 认证，不是 Bearer Token，也不是 URL 参数 key。</p></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      '<div class="mcp-help">' +
      '<div class="mcp-help-row"><div class="mcp-help-k">MCP 地址</div><div class="mcp-help-v">' +
      '<code id="lingxingHelpUrl">' + esc(url) + '</code>' +
      '<button class="link-btn" data-copy-target="lingxingHelpUrl" type="button">复制</button>' +
      '<small>原样填写，不要自己在末尾加 /mcp。</small></div></div>' +
      '<div class="mcp-help-row"><div class="mcp-help-k">认证方式</div><div class="mcp-help-v">' +
      '<code>自定义 Headers</code>' +
      '<small>不要选 Bearer Token，也不要选 URL 参数 key。</small></div></div>' +
      '<div class="mcp-help-row"><div class="mcp-help-k">访问令牌 / Key</div><div class="mcp-help-v">' +
      '<code>留空</code>' +
      '<small>填在这里会额外发送 Authorization: Bearer，领星会认不出来。</small></div></div>' +
      '<div class="mcp-help-row"><div class="mcp-help-k">附加 Headers</div><div class="mcp-help-v">' +
      '<code id="lingxingHelpHeaders">{"X-Mcp-Key":"你的访问密钥"}</code>' +
      '<button class="link-btn" data-copy-target="lingxingHelpHeaders" type="button">复制</button>' +
      '<small>把「你的访问密钥」换成领星页面复制的那串，不要带 Bearer 前缀。</small></div></div>' +
      '<div class="mcp-help-row"><div class="mcp-help-k">启用</div><div class="mcp-help-v">' +
      '<code>勾选「启用这个数据源」</code>' +
      '<small>保存后点「保存并测试」，测试成功会显示读到的工具数量和工具名。</small></div></div>' +
      '</div>' +
      '<div class="mcp-help-note"><b>在领星哪里找：</b>领星 MCP 页面里的「服务器地址」「请求头名称」「访问密钥」。请求头名称就是 <code>X-Mcp-Key</code>。如果返回 401/403，先检查 Key 是否复制完整、地址是否多了或少了后缀。</div>' +
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
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.title = '删除对话';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('删除这个对话？', '对话记录会从本机删除，已生成的文件不受影响。', true);
        if (!ok) return;
        await fetch('/api/session?id=' + encodeURIComponent(s.id), { method: 'DELETE' });
        state.sessions = state.sessions.filter((x) => x.id !== s.id);
        if (state.session && state.session.id === s.id) newChat();
        renderSessions();
        toast('已删除');
      });
      item.append(title, del);
      item.addEventListener('click', () => openSession(s.id));
      box.append(item);
    }
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
    } else {
      avatar.innerHTML = '<svg viewBox="0 0 32 32" fill="none"><path d="M9.5 20.5 15.2 12l3.2 4.2 2.1-2.6 3.9 6.9H9.5Z" fill="currentColor"/></svg>';
    }

    const body = document.createElement('div');
    body.className = 'msg-body';

    const refs = { wrap, body };

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
    head.innerHTML = '<b>' + esc(state.cfg ? state.cfg.brand : '跨境 AI 工作台') + '</b>' + (state.skill && live ? '<span>· ' + esc(state.skill.title) + '</span>' : '');
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

    const content = document.createElement('div');
    content.className = 'md' + (live ? ' streaming' : '');
    content.innerHTML = msg.text ? MD.render(msg.text) : '';
    if (!msg.text && !live) content.style.display = 'none';
    body.append(content);
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
    refs.sourcesEl.style.display = '';
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
    refs.filesEl.style.display = '';
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
    if (live.renderScheduled) return;
    live.renderScheduled = true;
    requestAnimationFrame(() => {
      live.renderScheduled = false;
      if (!live.refs.contentEl) return;
      live.refs.contentEl.innerHTML = MD.render(live.msg.text);
      scrollMaybe();
    });
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

  function openSkill(skill) {
    closeSidebar();
    const fields = Array.isArray(skill.fields) ? skill.fields : [];
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
    const starters = (skill.starters || [])
      .map((s) => '<button class="starter" type="button" data-starter="' + esc(s) + '">' + esc(s) + '</button>')
      .join('');

    const cmds = Array.isArray(skill.commands) ? skill.commands : [];
    const cmdHtml = cmds.length
      ? '<h3>直接运行 <button class="btn small ghost" type="button" data-openfolder style="margin-left:8px">打开配置文件夹</button></h3><div class="run-list">' +
        cmds
          .map((c, i) => {
            const need = Array.isArray(c.params) && c.params.length > 0;
            return (
              '<div class="run-item"><div class="run-main"><b>' + esc(c.label) + '</b>' +
              (c.desc ? '<div class="run-desc">' + esc(c.desc) + '</div>' : '') +
              '</div><button class="btn small" type="button" data-run="' + i + '">' + (need ? '填参数' : '运行') + '</button></div>'
            );
          })
          .join('') +
        '</div><div class="run-panel hidden" data-runpanel></div>'
      : '';

    const html =
      '<div class="modal-head"><div class="skill-hero"><div class="skill-no">' + skillNo(skill) + '</div>' +
      '<div><div class="skill-group-tag">' + esc(skill.group || '技能') + '</div><h2>' + esc(skill.title) + '</h2>' +
      '<div class="tag">' + esc(skill.tagline || '') + '</div></div></div>' +
      '<button class="modal-close" data-close type="button">×</button></div>' +
      '<p class="skill-desc">' + esc(skill.description || '') + '</p>' +
      (starters ? '<h3>常用问法</h3><div class="starter-list">' + starters + '</div>' : '') +
      cmdHtml +
      fieldsHtml +
      '<div class="modal-actions"><button class="btn ghost" data-close type="button">取消</button>' +
      '<button class="btn primary" data-start type="button">用这个技能开始</button></div>';

    const close = showModal(html, { wide: true });
    const modal = close.modal;
    modal.querySelector('[data-openfolder]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const resp = await fetch('/api/skill/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skillId: skill.id, sub: 'config' }),
        });
        const data = await resp.json();
        if (!data.ok) alert('打不开：' + (data.error || '未知原因'));
      } catch (err) {
        alert('打不开：' + (err && err.message ? err.message : String(err)));
      } finally {
        btn.disabled = false;
      }
    });
    modal.querySelectorAll('[data-run]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = cmds[Number(btn.dataset.run)];
        if (!cmd) return;
        const panel = modal.querySelector('[data-runpanel]');
        panel.classList.remove('hidden');
        panel.innerHTML =
          '<div class="run-cmd-head">将要执行 <code>' + esc(cmd.run.join(' ')) + '</code></div>' +
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
    modal.querySelectorAll('[data-starter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        close();
        applySkill(skill, {}, btn.dataset.starter);
      });
    });
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

  async function doRunSkill(modal, skill, cmd, panel) {
    const btn = panel.querySelector('[data-gorun]');
    const box = panel.querySelector('[data-runresult]');
    const params = {};
    panel.querySelectorAll('[data-param]').forEach((el) => {
      const v = el.value.trim();
      if (v) params[el.dataset.param] = v;
    });
    const limit = Math.round((cmd.timeoutMs || 180000) / 1000);
    btn.disabled = true;
    btn.textContent = '运行中…';
    box.innerHTML = '<pre class="run-out">正在运行，最长 ' + limit + ' 秒…</pre>';
    try {
      const resp = await fetch('/api/skill/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: skill.id, index: cmd.index, params }),
      });
      const data = await resp.json();
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
      if (Array.isArray(data.files) && data.files.length) {
        html +=
          '<div class="run-files">' +
          data.files
            .map(
              (f) =>
                '<a class="run-file" target="_blank" rel="noopener" href="/api/file?path=' +
                encodeURIComponent(f) + '">' + esc(String(f).split('/').pop()) + '</a>'
            )
            .join('') +
          '</div><div class="run-hint" style="margin-top:6px">结果已复制到工作区「技能产出」</div>';
      }
      box.innerHTML = html;
    } catch (err) {
      box.innerHTML = '<pre class="run-out">' + esc('请求失败：' + (err && err.message ? err.message : String(err))) + '</pre>';
    } finally {
      btn.disabled = false;
      btn.textContent = '重新运行';
    }
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
    const agentChip = $('#agentChip');
    if (agentChip) {
      if (state.agent) {
        agentChip.classList.remove('hidden');
        agentChip.innerHTML =
          '<span class="chip-no">员工</span><span>' + esc(state.agent.title) + '</span>';
        agentChip.title = '点击更换员工';
      } else {
        agentChip.classList.add('hidden');
      }
    }
    const chip = $('#skillChip');
    const banner = $('#skillBanner');
    if (state.skill) {
      if (state.view === 'chat') chip.classList.remove('hidden');
      else chip.classList.add('hidden');
      chip.innerHTML = '<span class="chip-no">' + esc(skillGroupLabel(state.skill)) + ' ' + skillNo(state.skill) + '</span><span>' + esc(state.skill.title) + '</span>';
      chip.title = '点击更换技能';
      banner.classList.remove('hidden');
      $('#sbNo').textContent = skillGroupLabel(state.skill) + ' ' + skillNo(state.skill);
      $('#sbTitle').textContent = state.skill.title;
      const baseDesc = state.skill.tagline || state.skill.description || '';
      $('#sbDesc').textContent = state.skill.runOnly
        ? baseDesc + ' · 报告请点技能卡片里的「直接运行」生成'
        : baseDesc;
    } else {
      chip.classList.add('hidden');
      banner.classList.add('hidden');
    }
  }

  function clearSkill() {
    state.skill = null;
    if (state.session) state.session.skillId = null;
    updateSkillUI();
  }

  /* ================= 弹层 ================= */

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
      '<div class="modal-actions"><span class="left" style="font-size:10.5px;color:var(--faint);align-self:center">' + esc(state.cfg ? state.cfg.brand + ' v' + state.cfg.version : '') + '</span>' +
      '<button class="btn ghost" data-close type="button">取消</button><button class="btn primary" id="saveSet" type="button">保存</button></div>';

    const close = showModal(html, { wide: true });
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

  function showHelp() {
    const html =
      '<div class="modal-head"><div><h2>使用说明</h2><p>三步开始，以及常用快捷键。</p></div><button class="modal-close" data-close type="button">×</button></div>' +
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
    showModal(html, { wide: true });
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

  function bindEvents() {
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
    chat.style.scrollBehavior = instant ? 'auto' : 'smooth';
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => {
      chat.style.scrollBehavior = '';
    }, 30);
  }

  function scrollMaybe(force) {
    const chat = $('#chat');
    if (!chat) return;
    const near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 220;
    if (near || force) {
      chat.scrollTop = chat.scrollHeight;
    }
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
