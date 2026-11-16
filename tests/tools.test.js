'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.TOOLS_ROOT || path.resolve(__dirname, '..');
const { ToolRunner } = require(path.join(ROOT, 'server', 'tools'));
const WS = path.join(ROOT, 'workspace');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(path.join(WS, 'attachments'), { recursive: true });
fs.writeFileSync(path.join(WS, 'attachments', 'sample.csv'), 'term,clicks,spend\nlantern,10,2.5\nlamp,5,1.2\n', 'utf8');

let failures = 0;
const check = (c, l, d) => {
  if (c) console.log('  ok   ' + l);
  else {
    failures += 1;
    console.log('  FAIL ' + l + (d ? ' :: ' + d : ''));
  }
};

async function main() {
  const runner = new ToolRunner({ workspace: WS, dataDir: DATA, apiKey: 'x', baseUrl: 'http://x', emit: () => {} });

  const r1 = await runner.run(
    'run_javascript',
    JSON.stringify({
      code: "const rows = readCsv('attachments/sample.csv'); console.log('rows=' + rows.length + ' clicks=' + rows[0].clicks); write('reports/r.csv', rows.length + ' rows');",
      purpose: 'test',
    })
  );
  check(r1.ok, 'run_javascript 成功', r1.content);
  check(r1.content.includes('rows=2'), '读取 CSV 正确', r1.content);
  check(fs.existsSync(path.join(WS, 'reports', 'r.csv')), '写入文件成功');

  const r2 = await runner.run('run_javascript', JSON.stringify({ code: "try { require('fs').readFileSync('C:/Windows/win.ini'); console.log('BAD'); } catch (e) { console.log('blocked:' + e.code); }" }));
  check(r2.content.includes('blocked'), '工作区外读取被拒绝', r2.content);

  const r3 = await runner.run('run_javascript', JSON.stringify({ code: "try { require('child_process').execSync('whoami'); console.log('BAD'); } catch (e) { console.log('blocked-cp'); }" }));
  check(r3.content.includes('blocked-cp'), 'child_process 被拒绝', r3.content);

  const r4 = await runner.run('run_javascript', JSON.stringify({ code: "try { require('https'); console.log('BAD'); } catch (e) { console.log('blocked-net'); }" }));
  check(r4.content.includes('blocked-net'), '网络模块被拒绝', r4.content);

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

main();
