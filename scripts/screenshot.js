'use strict';

/* 用 Chrome DevTools Protocol 截取界面截图（需要本机浏览器权限）。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:7862';
const PORT = Number(process.env.SHOT_PORT || 9333);
const OUT = path.join(__dirname, '..', 'docs');
const PROFILE = path.join(__dirname, '..', 'data', 'chrome-shot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  try {
    await fetch(BASE + '/api/clear', { method: 'POST' });
  } catch {
    /* ignore */
  }

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,960',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  try {
    let version = null;
    for (let i = 0; i < 50; i += 1) {
      try {
        const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
        if (r.ok) {
          version = await r.json();
          break;
        }
      } catch {
        /* retry */
      }
      await sleep(200);
    }
    if (!version) throw new Error('Chrome 没有启动');

    const targets = await fetch('http://127.0.0.1:' + PORT + '/json/list').then((r) => r.json());
    let page = targets.find((t) => t.type === 'page');
    if (!page) {
      page = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' }).then((r) => r.json());
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error('WS 连接失败'));
    });

    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    };

    const send = (method, params) =>
      new Promise((resolve, reject) => {
        seq += 1;
        const id = seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        errors.push('EVAL: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
      }
      return r.result ? r.result.value : undefined;
    };

    const navigate = async (url) => {
      await send('Page.navigate', { url });
      for (let i = 0; i < 60; i += 1) {
        await sleep(150);
        const ready = await evaluate('document.readyState');
        if (ready === 'complete') break;
      }
      await sleep(700);
    };

    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
      console.log('shot ' + name);
    };

    const typeAndSend = async (text) => {
      await evaluate(
        '(() => { const i = document.querySelector("#input"); i.value = ' +
          JSON.stringify(text) +
          '; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#sendBtn").click(); })()'
      );
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    await navigate(BASE);
    await sleep(800);
    await shot('01-onboarding.png');

    await evaluate(
      "localStorage.setItem('ecom.key','sk-demo'); localStorage.setItem('ecom.settings', JSON.stringify({model:'deepseek-flash',thinking:true,search:true,theme:'light'})); location.reload();"
    );
    await sleep(1800);
    await shot('02-welcome.png');

    await evaluate('document.querySelector("#welcomeSkills").click()');
    await sleep(500);
    await shot('03-skills.png');
    await evaluate('document.querySelector(".index-row").click()');
    await sleep(500);
    await shot('03-skill-modal.png');
    await evaluate('document.querySelector(".modal [data-close]").click()');
    await sleep(300);

    await evaluate(
      'Array.from(document.querySelectorAll(".index-row")).find(function(r){return r.textContent.indexOf("Listing 撰写") >= 0}).click()'
    );
    await sleep(400);
    await evaluate('document.querySelector(".modal [data-start]").click()');
    await sleep(400);
    await typeAndSend('帮我生成文件：露营灯 listing，英文，目标人群是周末露营的人');
    await sleep(3200);
    await shot('04-chat.png');

    await evaluate('location.reload()');
    await sleep(2000);
    await evaluate('document.querySelector(".session-item").click()');
    await sleep(900);
    await shot('04b-history.png');

    await evaluate('document.querySelector("#newChat").click()');
    await sleep(300);
    await typeAndSend('搜索一下 FBA 费用 2026，给我最新政策');
    await sleep(3200);
    await shot('05-sources.png');

    await evaluate('document.querySelector("#settingsBtn").click()');
    await sleep(500);
    await shot('06-settings.png');
    await evaluate('document.querySelector(".modal [data-close]").click()');
    await sleep(300);

    await evaluate('document.querySelector(".nav-item[data-view=\\"mcp\\"]").click()');
    await sleep(600);
    await shot('09-mcp.png');

    await evaluate('document.querySelectorAll(".mcp-card")[0].querySelector("[data-act=help]").click()');
    await sleep(500);
    await shot('11-lingxing-help.png');
    await evaluate('Array.from(document.querySelectorAll(".overlay")).pop().querySelector("[data-close]").click()');
    await sleep(300);

    await evaluate('document.querySelectorAll(".mcp-card")[0].querySelector("[data-act=config]").click()');
    await sleep(400);
    await evaluate('document.querySelector("#mcpHelp").click()');
    await sleep(400);
    await shot('11b-lingxing-help-from-config.png');
    await evaluate('Array.from(document.querySelectorAll(".overlay")).pop().querySelector("[data-close]").click()');
    await sleep(300);
    await evaluate('Array.from(document.querySelectorAll(".overlay")).pop().querySelector("[data-close]").click()');
    await sleep(300);

    await evaluate('document.querySelectorAll(".mcp-card")[3].querySelector("[data-act=config]").click()');
    await sleep(500);
    await evaluate(
      'document.querySelector("#mcpUrl").value="http://127.0.0.1:7901/mcp"; document.querySelector("#mcpToken").value="test"; document.querySelector("#mcpEnabled").checked=true; document.querySelector("#mcpSaveTest").click();'
    );
    await sleep(2200);
    await shot('09b-mcp-connected.png');
    await evaluate('document.querySelector(".modal [data-close]").click()');
    await sleep(400);
    await shot('09-mcp-connected.png');

    await evaluate(
      "localStorage.setItem('ecom.settings', JSON.stringify({model:'deepseek-flash',thinking:true,search:true,theme:'dark'})); location.reload();"
    );
    await sleep(1800);
    await shot('07-dark.png');

    await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
    await evaluate('location.reload()');
    await sleep(1800);
    await shot('08-mobile.png');
    await evaluate('document.querySelector("#welcomeSkills").click()');
    await sleep(600);
    await shot('10-mobile-skills.png');

    console.log('ERRORS ' + errors.length);
    for (const e of errors) console.log(e);
  } finally {
    try {
      chrome.kill();
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
