'use strict';

/* 按技能声明的 outputGuard 检查产出结构。
   skill.json 里写：
   "outputGuard": {
     "name": "竞品作战卡",
     "sections": [
       { "key": "profile", "label": "竞品档案", "kind": "table" },
       { "key": "angles", "label": "三个切入角度", "kind": "table", "minRows": 3 }
     ]
   }
   只认「标题 + 起码一条内容」，不判断内容好坏。 */

function norm(s) {
  return String(s || '')
    .replace(/[#*`>]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function findSection(text, label) {
  const lines = String(text || '').split('\n');
  const target = norm(label);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isHeading = /^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(line);
    if (!isHeading) continue;
    if (norm(line).includes(target)) {
      // 收集到下一个标题为止
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\s*#{1,6}\s/.test(lines[j])) break;
        body.push(lines[j]);
      }
      return { index: i, body: body.join('\n') };
    }
  }
  return null;
}

function countItems(body) {
  const lines = String(body || '').split('\n');
  let tableRows = 0;
  let bullets = 0;
  let sawTable = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('|')) {
      if (/^\|[\s:|-]+\|$/.test(t)) {
        sawTable = true;
        continue; // 表格分隔行
      }
      tableRows += 1;
    } else if (/^([-*+]|\d+[.)、])\s*\S/.test(t)) {
      bullets += 1;
    }
  }
  // 表格首行是表头，不算数据行
  if (tableRows > 0) tableRows -= 1;
  return { tableRows: Math.max(0, tableRows), bullets, sawTable };
}

function check(guard, text, opts = {}) {
  if (!guard || !Array.isArray(guard.sections) || !guard.sections.length) {
    return { ok: true, checked: false, missing: [], problems: [] };
  }
  const missing = [];
  const problems = [];
  // 用户明确不要的章节：跳过检查（可选章节才允许跳）
  const skip = new Set(
    (Array.isArray(opts.skip) ? opts.skip : []).map((x) => norm(String(x || '')))
  );
  const skipped = [];

  for (const section of guard.sections) {
    if (skip.has(norm(section.label)) || skip.has(norm(section.key))) {
      skipped.push(section.label);
      continue;
    }
    const found = findSection(text, section.label);
    if (!found) {
      missing.push(section.label);
      continue;
    }
    const items = countItems(found.body);
    const total = items.tableRows + items.bullets;
    if (total === 0) {
      problems.push('「' + section.label + '」标题在，但下面没有任何内容');
      continue;
    }
    if (section.kind === 'table' && !items.sawTable) {
      problems.push('「' + section.label + '」应该用表格，现在是列表或正文');
    }
    if (section.minRows && items.tableRows < section.minRows) {
      problems.push('「' + section.label + '」至少要 ' + section.minRows + ' 行，现在 ' + items.tableRows + ' 行');
    }
  }
  return { ok: missing.length === 0 && problems.length === 0, checked: true, missing, problems, skipped };
}

function describe(guard, result) {
  const name = (guard && guard.name) || '产出';
  const skipped = result.skipped && result.skipped.length ? '（按要求跳过：' + result.skipped.join('、') + '）' : '';
  if (result.ok) return name + '结构检查通过。' + skipped;
  const parts = [];
  if (result.missing.length) parts.push('缺少章节：' + result.missing.join('、'));
  if (result.problems.length) parts.push(...result.problems);
  return name + '结构不完整：\n- ' + parts.join('\n- ');
}

module.exports = { check, describe, findSection, countItems };
