'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'markdown.js'), 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const MD = sandbox.window.MD;

let failures = 0;
function check(cond, label, actual) {
  if (cond) console.log('  ok   ' + label);
  else {
    failures += 1;
    console.log('  FAIL ' + label + (actual ? '\n       ' + actual : ''));
  }
}

const h = MD.render('## 标题\n\n**加粗** 和 *斜体*，还有 `code`。\n\n- 一\n- 二\n  - 二点一\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1 < 2;\n```\n\n[链接](https://example.com)');
check(h.includes('<h2 class="md-h md-h2">标题</h2>'), '标题');
check(h.includes('<strong>加粗</strong>'), '加粗');
check(h.includes('<em>斜体</em>'), '斜体');
check(h.includes('inline-code'), '行内代码');
check(h.includes('<table>') && h.includes('<th>A</th>'), '表格');
check(h.includes('&lt; 2'), '代码转义');
check(h.includes('href="https://example.com"'), '链接');
check((h.match(/<ul class="md-list">/g) || []).length >= 2, '嵌套列表', h);

const xss = MD.render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
check(!xss.includes('<script>'), 'XSS script 转义');
check(!xss.includes('<img src=x'), 'XSS img 属性转义');

const badLink = MD.render('[x](javascript:alert(1))');
check(!badLink.includes('javascript:alert'), '危险链接被过滤', badLink);

const unsafeImg = MD.render('![x](javascript:alert(1))');
check(!unsafeImg.includes('javascript:alert'), '危险图片被过滤', unsafeImg);

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exit(failures ? 1 : 0);
