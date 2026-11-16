'use strict';

/* 轻量 Markdown 渲染器：无依赖、先转义再渲染，够聊天场景使用。 */
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function safeUrl(url, allowData) {
    const u = String(url || '').trim();
    if (/^(https?:\/\/|mailto:)/i.test(u)) return escapeHtml(u);
    if (u.startsWith('/') || u.startsWith('#')) return escapeHtml(u);
    if (allowData && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(u)) return escapeHtml(u);
    return '#';
  }

  function inline(text) {
    const codes = [];
    let s = String(text);
    s = s.replace(/`([^`\n]+)`/g, (m, code) => {
      codes.push('<code class="inline-code">' + escapeHtml(code) + '</code>');
      return '\u0000CODE' + (codes.length - 1) + '\u0000';
    });
    s = escapeHtml(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      return '<img class="md-img" src="' + safeUrl(url, true) + '" alt="' + alt + '" loading="lazy">';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
      return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (m, pre, url) => {
      return pre + '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => codes[Number(i)] || '');
    return s;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    let inCode = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '`') inCode = !inCode;
      if (ch === '|' && !inCode) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  function renderCode(code, lang) {
    const label = lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '<span class="code-lang">code</span>';
    return (
      '<div class="code-block">' +
      '<div class="code-head">' + label +
      '<button class="code-copy" type="button" data-copy>复制</button></div>' +
      '<pre><code>' + escapeHtml(code) + '</code></pre>' +
      '</div>'
    );
  }

  function render(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^\s*(```+|~~~+)\s*([\w#+.-]*)\s*$/);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2] || '';
        const buf = [];
        i += 1;
        while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        out.push(renderCode(buf.join('\n'), lang));
        continue;
      }

      // blank
      if (!line.trim()) {
        i += 1;
        continue;
      }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        out.push('<h' + level + ' class="md-h md-h' + level + '">' + inline(h[2]) + '</h' + level + '>');
        i += 1;
        continue;
      }

      // hr
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr class="md-hr">');
        i += 1;
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        let html = '<div class="table-wrap"><table><thead><tr>';
        html += head.map((c) => '<th>' + inline(c) + '</th>').join('');
        html += '</tr></thead><tbody>';
        for (const r of rows) {
          html += '<tr>' + head.map((_, idx) => '<td>' + inline(r[idx] || '') + '</td>').join('') + '</tr>';
        }
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }

      // blockquote
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote class="md-quote">' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }

      // list
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          const m = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
          const indent = Math.min(4, Math.floor((m[1] || '').length / 2));
          const ordered = /^\s*\d+[.)]\s+/.test(lines[i]);
          items.push({ indent, ordered, text: m[2] });
          i += 1;
        }
        out.push(renderList(items));
        continue;
      }

      // paragraph
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(```|~~~)/.test(lines[i]) &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) &&
        !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
      ) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push('<p class="md-p">' + inline(buf.join('\n')).replace(/\n/g, '<br>') + '</p>');
    }

    return out.join('\n');
  }

  function renderList(items) {
    let idx = 0;
    function build(level) {
      const ordered = items[idx].ordered;
      let html = ordered ? '<ol class="md-list">' : '<ul class="md-list">';
      while (idx < items.length) {
        const item = items[idx];
        if (item.indent < level) break;
        if (item.indent > level) {
          html += build(item.indent);
          continue;
        }
        idx += 1;
        html += '<li>' + inline(item.text);
        if (idx < items.length && items[idx].indent > level) {
          html += build(items[idx].indent);
        }
        html += '</li>';
      }
      html += ordered ? '</ol>' : '</ul>';
      return html;
    }
    return build(0);
  }

  function plain(text) {
    return String(text || '').replace(/[#>*_`~\-]/g, '').replace(/\s+/g, ' ').trim();
  }

  window.MD = { render, escapeHtml, plain };
})();
