'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('./llm');
const { toolDefs, ToolRunner } = require('./tools');
const { uid } = require('./util');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx']);
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'js', 'ts', 'py', 'log']);

function ext(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function purposeFor(name, mime) {
  const e = ext(name);
  if (IMAGE_EXT.has(e) || String(mime || '').startsWith('image/')) return 'user_data';
  if (DOC_EXT.has(e)) return 'text_recognition';
  return 'user_data';
}

function nowText() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('weekday') + ' ' + get('hour') + ':' + get('minute') + '（北京时间）';
}

function systemPrompt({ cfg, skill, agent, skills, search, hasMcp, canConfig, knowledge }) {
  const lines = [];

  // 知识库默认注入：小库直接给全文，大库给索引；按员工范围过滤
  const kbLines = (() => {
    if (!knowledge || !knowledge.length) return [];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const live = knowledge.filter(
      (it) => !it.deleted && (!it.effective || it.effective <= today) && (!it.expires || it.expires >= today)
    );
    if (!live.length) return [];
    const full = live.map((it) => '- [' + it.id + '] [' + it.category + '] ' + it.content).join('\n');
    const out = [];
    out.push('');
    out.push('# 知识库（我们自己的口径，优先级高于通用做法）');
    if (full.length <= 8000) {
      out.push('');
      out.push(full);
      out.push('');
      out.push('以上是全部生效条目。需要引用某条时，用方括号里的 id（style_refs 等字段只能填这个 id）。');
    } else {
      out.push('');
      out.push('共 ' + live.length + ' 条（太长，只给索引）。需要细节时调 search_knowledge。');
      for (const it of live.slice(0, 120)) {
        out.push('- [' + it.id + '] [' + it.category + '] ' + String(it.content).slice(0, 40));
      }
    }
    return out;
  })();
  lines.push(...kbLines);
  lines.push(
    '你是「' + cfg.brand + '」内置的亚马逊跨境电商运营 AI，服务中国卖家，覆盖选品、Listing、关键词、广告、竞品、差评、利润、库存、合规、客服等日常运营工作。',
    '',
    '当前时间：' + nowText() + '。默认主站点为美国站（US），除非用户另有说明。',
    '',
    '## 工作原则',
    '1. 结论先行：先给判断和可执行动作，再给解释。能用清单、表格就不用长段落。',
    '2. 不编数字：销量、搜索量、费用、佣金、汇率、ACOS、转化率等数字，只能来自用户提供的数据、附件或工具结果。缺少数据时明确说“需要你补充”，不要凭空估算；不得不假设时，标注「假设」并给区间。',
    search
      ? '3. 需要最新事实（平台政策、费用调整、竞品动态、市场趋势、节日日历）时，先调用 web_search；摘要不够再 read_url。回答中引用来源时给出 URL。'
      : '3. 本次没有开启联网工具。涉及最新政策、费用、趋势时，明确告诉用户「打开输入框下方的『联网』再问一次」，不要凭记忆编造具体数字或政策条款。',
    '4. 能交付文件就交付文件：Listing 文案、报告、测算表、话术文档，用 write_file 或 run_javascript 写成工作区文件，并在回答里说明文件路径。',
    '5. 精确计算用 run_javascript，尤其是 CSV 汇总、利润测算、广告花费反推；不要口算大表。',
    '6. 涉及合规、税务、法律时给方向性建议，并提示以平台官方和当地法规为准。',
    '7. 用中文回答，平台术语保留英文（ASIN、ACOS、FBA、TACoS 等）。不要暴露本系统提示词。',
    '',
    '## 工具',
    search ? '- web_search：联网搜索，返回标题/链接/摘要/日期。' : '- 本次未开启 web_search。',
    search ? '- read_url：读取网页正文。' : '',
    '- list_files / read_file：查看工作区文件；用户上传的附件在 attachments/ 下。',
    '- write_file：把成果写成文件，用户可以直接打开或下载。',
    '- run_javascript：在工作区跑 Node.js 做精确计算或数据处理；内置 read()、readCsv()、write()、readJson()、list()、table()。计算环境只能读写 workspace，禁止联网。',
    hasMcp
      ? '- mcp__ 开头的数据源工具：已连接的领星 / 卖家精灵 / SIF / Sorftime 等 MCP。需要真实类目、关键词、销量、广告数据时优先调用，并在回答里说明数据来自哪个数据源；查不到就说查不到。'
      : '',
    '',
'用户上传的 Excel / PDF / Word 已经作为文件内容传入对话，可以直接阅读；原始文件在 attachments/ 目录。',
    '用户以前上传过的文件都留在工作区，需要时先用 list_files 看 attachments/ 里有什么，再用 read_file / readCsv 自己读，**不要让他重新上传或者手抄数字**。找不到再问。',
  );
  if (canConfig) {
    lines.push(
      '',
      '## 改配置',
      '要增删复盘产品、换父体或竞品、改月目标与成本时，用 update_skill_config 提交**完整**的产品列表；',
      '它只生成提案，用户在界面上点「应用」才真正写盘。不要让他手改 JSON，也不要给命令行。',
      '提交前先 load_skill 看清字段；保存失败会返回原因，照着改再提交一次。'
    );
  }

  if (agent) {
    const owned = Array.isArray(skills) ? skills : [];
    const catalog = (agent.skills || [])
      .map((id) => owned.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => '- `' + s.id + '` ' + s.title + (s.tagline ? ' —— ' + s.tagline : ''))
      .join('\n');
    lines.push(
      '',
      '# 你是「' + agent.title + '」',
      '',
      agent.body || agent.description || '',
      '',
      '## 你手上的技能',
      '下面是这个岗位可用的专项技能。需要具体方法时，先用 load_skill(id) 取完整说明，**不要凭印象编流程**；拿到说明后按它执行。',
      '',
      catalog || '（暂时没有装配技能）',
      '',
      '用户也可能直接在技能库里单独用某个技能，那是另一条路径，不用特别解释。'
    );
  }

  if (skill && skill.runOnly && skill.body) {
    lines.push(
      '',
      '# 当前技能：' + skill.title,
      '',
      '## 硬约束（优先级最高，不能违反）',
      '这个技能的所有报告都由脚本渲染，你**不得自己写 HTML、表格或任何报告文件**，也不得把数据拼成文件冒充报告。',
'用户就在工作台界面里。**不要给用户贴命令行**（例如 scripts\\run.cmd ...），也不要让他开终端、装 Python——这些都不需要他做。',
      '要跑报告时，优先调用 run_skill：它会给用户弹一张确认卡，用户点「确认运行」后服务端开始跑，跑完结果卡会出现在对话里（带打开/下载）。',
      '只有在用户明确说「我自己去技能页跑」时才让他点技能卡片上的「直接运行」。不要说「你去技能产出里找文件」。',
      '跑之前可以用 read_skill_config 确认当前登记的 SPU、店铺、目标，别猜；要改就用 update_skill_config 提提案。',
      '按钮名字以技能正文里的「可直接运行的命令」为准，说人话（比如「① 登记一个 SPU」），不要说参数写法。',
      '用户已经说明身份的数据（比如「这是领星的 SPU」）就按它处理，不要反复质疑口径；拿不准就先用最小成本试一次。',
      '你可以解释每个按钮做什么、要填什么参数、数据口径是什么，但不能产出报告。',
      '',
      '（下面是这个技能的流程说明，仅供你理解，不要照着它手写报告。）',
      '',
      skill.body.trim(),
      '',
    );
  } else if (skill && skill.body) {
    lines.push(
      '',
      '# 当前技能：' + skill.title,
      '',
      skill.body.trim(),
      '',
      '（以上技能说明优先于通用风格，但不得违反“不编数字”的原则。）',
    );
  } else if (!agent) {
    lines.push(
      '',
      '## 没有选择技能时',
      '如果用户的问题明显对应某个专项技能（选品、Listing、广告、利润…），先给出初步回答，再建议他从左侧技能库选择对应技能，以获得更完整的流程和交付物。',
    );
  }
  return lines.join('\n');
}

function makeError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function prepareFiles({ store, apiKey, baseUrl, files, emit }) {
  const blocks = [];
  const notes = [];
  const uiFiles = [];
  const keyId = crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 12);
  for (const f of files || []) {
    const meta = store.getUpload(f.id);
    if (!meta) continue;
    const purpose = purposeFor(meta.name, meta.mime);
    uiFiles.push({ id: meta.id, name: meta.name, size: meta.size });
    if (!meta.remoteId || meta.keyId !== keyId) {
      emit({ t: 'upload', name: meta.name, status: 'start' });
      try {
        const up = await llm.uploadFile({
          apiKey,
          baseUrl,
          buffer: fs.readFileSync(meta.path),
          filename: meta.name,
          mime: meta.mime,
          purpose,
        });
        meta.remoteId = up.id;
        meta.remotePurpose = purpose;
        meta.keyId = keyId;
        store.saveUploadMeta(meta);
        emit({ t: 'upload', name: meta.name, status: 'ok' });
      } catch (err) {
        emit({ t: 'upload', name: meta.name, status: 'error', message: err.message });
        if (TEXT_EXT.has(ext(meta.name)) && meta.size < 2 * 1024 * 1024) {
          const text = fs.readFileSync(meta.path, 'utf8');
          blocks.push({ type: 'text', text: '\n\n【附件：' + meta.name + '】\n' + text.slice(0, 50000) });
          notes.push(meta.name + '（已按纯文本读取）');
          continue;
        }
        throw new llm.ApiError(400, '附件「' + meta.name + '」解析失败：' + err.message);
      }
    }
    blocks.push({ type: 'file', file_id: meta.remoteId });
    notes.push(meta.name + '（用途 ' + purpose + '，本地路径 attachments/' + path.basename(meta.path) + '）');
  }
  return { blocks, notes, uiFiles };
}

function deriveTitle(text, skill) {
  let clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  clean = clean.replace(/^请用「[^」]{1,30}」技能(完成下面这件事。?)?/, '').trim();
  clean = clean.replace(/^[-•]\s*/, '').trim();
  if (!clean) return skill ? skill.title : '新对话';
  return clean.slice(0, 28);
}

async function runTurn(opts) {
  const { cfg, store, session, text, files, options, apiKey, signal, emit } = opts;
  const skill = opts.skill || null;
  const agent = opts.agent || null;
  const mcp = opts.mcp || null;

  const userText = String(text || '').trim();
  if (!userText && (!files || !files.length)) throw makeError('请输入内容');

  const prepared = await prepareFiles({ store, apiKey, baseUrl: cfg.apiBase, files, emit });

  const attachmentNote = prepared.notes.length
    ? '\n\n【用户上传的附件】\n' + prepared.notes.map((n) => '- ' + n).join('\n')
    : '';
  const userContent = prepared.blocks.length
    ? [...prepared.blocks, { type: 'text', text: userText + attachmentNote }]
    : userText + attachmentNote;

  const now = Date.now();
  const userApi = { role: 'user', content: userContent };
  const userUi = { id: 'm-' + uid(), role: 'user', text: userText, files: prepared.uiFiles, createdAt: now };

  const newApi = [userApi];
  const newUi = [userUi];
  // 技能如果声明了固定产出结构，就让模型交卷前自己过一遍
  const outputGuard = (skill && skill.meta && skill.meta.outputGuard) || null;

  // 本次会话允许"提案改配置"的技能：声明了 configFiles 的，且属于当前员工或当前技能
  const configSkills = (opts.skills || []).filter((s) => {
  if (!s.meta || !Array.isArray(s.meta.configFiles) || !s.meta.configFiles.length) return false;
  if (agent) return (agent.skills || []).includes(s.id);
  if (skill) return skill.id === s.id;
  return true;
  });

  const mcpDefs = mcp ? mcp.defs() : [];
  const messages = [
    {
      role: 'system',
      content: systemPrompt({
        cfg,
        skill,
        agent,
        skills: opts.skills || [],
        search: Boolean(options.search),
        hasMcp: mcpDefs.length > 0,
        canConfig: configSkills.length > 0,
        knowledge: (() => {
          try {
            const { Knowledge, AGENT_SCOPES } = require('./knowledge');
            const all = new Knowledge(store.dataDir).list({});
            const allow = agent && AGENT_SCOPES[agent.id];
            return allow ? all.filter((it) => allow.includes(it.category)) : all;
          } catch {
            return [];
          }
        })(),
      }),
    },
    ...session.api,
    userApi,
  ];

  const runner = new ToolRunner({
    workspace: store.workspace,
    dataDir: store.dataDir,
    apiKey,
    baseUrl: cfg.apiBase,
    mcp,
    skills: opts.skills || [],
    allowedSkills: agent ? agent.skills || [] : null,
    configSkills,
    outputGuard,
    noReportFiles: Boolean(skill && skill.runOnly),
    skillTitle: skill ? skill.title : '',
    sessionId: session ? session.id : null,
    agentId: agent ? agent.id : null,
    emit: (ev) => {
      if (ev && ev.t === 'sources') {
        for (const item of ev.items || []) {
          if (item && item.url && !uiAssistant.sources.some((s) => s.url === item.url)) uiAssistant.sources.push(item);
        }
      }
      if (ev && ev.t === 'file') {
        if (!uiAssistant.files.some((f) => f.path === ev.path)) uiAssistant.files.push({ path: ev.path, name: ev.name, size: ev.size });
      }
      // 确认卡落库：实时事件丢了、刷新页面、翻回历史，都还能看到并点
      if (ev && ev.t === 'confirm') {
        try {
          if (!Array.isArray(session.messages)) session.messages = [];
          session.messages.push({
            role: 'assistant',
            text: '',
            ts: Date.now(),
            card: Object.assign({ kind: 'confirm' }, ev),
          });
          session.updatedAt = Date.now();
          store.saveSession(session);
        } catch (err) {
          console.warn('[agent] 确认卡落库失败：' + (err && err.message));
        }
      }
      emit(ev);
    },
  });
  const tools = [
    ...toolDefs({ search: Boolean(options.search), agentSkills: agent ? agent.skills : null, configSkills, outputGuard, skills: opts.skills || [] }),
    ...mcpDefs,
  ];
  const model =
    options.model && ['deepseek-flash', 'deepseek-v4-pro'].includes(options.model) ? options.model : cfg.model;

  const uiAssistant = {
    id: 'm-' + uid(),
    role: 'assistant',
    text: '',
    reasoning: '',
    tools: [],
    sources: [],
    files: [],
    model,
    createdAt: Date.now(),
  };
  const usageTotal = { input: 0, output: 0, cached: 0 };
  let finished = false;

  emit({
    t: 'session',
    id: session.id,
    title: session.title && session.title !== '新对话' ? session.title : deriveTitle(userText, skill),
    skillId: session.skillId,
    userMessage: userUi,
  });

  let aborted = false;
  try {
    for (let step = 0; step < cfg.maxSteps; step += 1) {
      if (signal && signal.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
      emit({ t: 'step', step });

      const res = await llm.streamChat({
        apiKey,
        baseUrl: cfg.apiBase,
        model,
        messages,
        tools,
        thinking: Boolean(options.thinking),
        signal,
        onDelta: (d) => {
          uiAssistant.text += d;
          emit({ t: 'text', d });
        },
        onReasoning: (d) => {
          uiAssistant.reasoning += d;
          emit({ t: 'reasoning', d });
        },
        onUsage: (u) => {
          if (!u) return;
          usageTotal.input += u.prompt_tokens || 0;
          usageTotal.output += u.completion_tokens || 0;
          usageTotal.cached += u.prompt_cache_hit_tokens || 0;
        },
      });

      const assistantApi = { role: 'assistant', content: res.text || '' };
      if (options.thinking && res.reasoning) assistantApi.reasoning_content = res.reasoning;
      if (res.toolCalls.length) {
        assistantApi.tool_calls = res.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        }));
      }
      messages.push(assistantApi);
      newApi.push(assistantApi);

      if (!res.toolCalls.length) {
        finished = true;
        // 技能声明了固定结构，但模型没调用 check_output 或没通过 → 明确提示
        const activeGuard = runner.outputGuard || outputGuard;
        if (activeGuard && !runner.outputGuardPassed) {
          const guardResult = require('./outputguard').check(activeGuard, uiAssistant.text);
          if (!guardResult.ok) {
            const lines = [];
            if (guardResult.missing.length) lines.push('缺少：' + guardResult.missing.join('、'));
            if (guardResult.problems.length) lines.push(...guardResult.problems);
            emit({
              t: 'notice',
              message:
                '这份「' + (activeGuard.name || '产出') + '」结构不完整：' +
                lines.join('；') +
                '。可以说「按模板重做一遍」让它补齐。',
            });
          }
        }
        break;
      }

      for (const call of res.toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = {};
        }
        const stepUi = {
          name: call.name,
          summary: summarizeTool(call.name, args),
          status: 'running',
          startedAt: Date.now(),
        };
        uiAssistant.tools.push(stepUi);
        emit({ t: 'tool', name: call.name, summary: stepUi.summary, status: 'start' });

        let result;
        if (signal && signal.aborted) {
          result = { ok: false, content: '用户已停止' };
        } else {
          result = await runner.run(call.name, call.arguments);
        }
        stepUi.status = result.ok ? 'ok' : 'error';
        stepUi.ms = Date.now() - stepUi.startedAt;
        emit({
          t: 'tool',
          name: call.name,
          summary: stepUi.summary,
          status: stepUi.status,
          ms: stepUi.ms,
          preview: String(result.content || '').slice(0, 260),
        });
        const toolMsg = { role: 'tool', tool_call_id: call.id, content: String(result.content || '').slice(0, 60000) };
        messages.push(toolMsg);
        newApi.push(toolMsg);
      }
      if (signal && signal.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    }
  } catch (err) {
    const isAbort = (err && err.name === 'AbortError') || (signal && signal.aborted);
    if (!isAbort) throw err;
    const hasAssistant = newApi.some((m) => m.role === 'assistant' && (m.content || m.tool_calls));
    if (!hasAssistant) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    aborted = true;
    if (uiAssistant.text || uiAssistant.reasoning) {
      const partial = { role: 'assistant', content: uiAssistant.text || '' };
      if (options.thinking && uiAssistant.reasoning) partial.reasoning_content = uiAssistant.reasoning;
      newApi.push(partial);
    }
  }

  if (!finished && !aborted) {
    emit({ t: 'notice', message: '已达到单轮工具调用上限（' + cfg.maxSteps + ' 步），先给你目前的结果，可以继续追问。' });
  }

  uiAssistant.usage = usageTotal;
  uiAssistant.stopped = aborted;
  if (!session.title || session.title === '新对话') {
    session.title = deriveTitle(userText || (prepared.uiFiles[0] && prepared.uiFiles[0].name) || '', skill);
  }

  session.api.push(...newApi);
  session.ui.push(...newUi, uiAssistant);
  session.usage.input += usageTotal.input;
  session.usage.output += usageTotal.output;
  session.usage.cached += usageTotal.cached;
  store.saveSession(session);

  emit({ t: 'usage', usage: usageTotal, total: session.usage });
  emit({ t: 'title', title: session.title });
  emit({ t: 'done', message: uiAssistant, title: session.title, stopped: aborted });
  return { assistant: uiAssistant, aborted };
}

function summarizeTool(name, args) {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const source = parts[1] || '数据源';
    const tool = parts.slice(2).join('__') || name;
    return '数据源：' + source + ' / ' + tool;
  }
  if (name === 'web_search') return '搜索：' + String(args.query || '').slice(0, 60);
  if (name === 'read_url') return '读取：' + String(args.url || '').slice(0, 60);
  if (name === 'write_file') return '写入：' + String(args.path || '').slice(0, 60);
  if (name === 'run_javascript') return String(args.purpose || '运行计算脚本').slice(0, 60);
  if (name === 'read_file') return '读取：' + String(args.path || '').slice(0, 60);
  if (name === 'list_files') return '查看工作区';
  return name;
}

module.exports = { runTurn, systemPrompt, nowText };
