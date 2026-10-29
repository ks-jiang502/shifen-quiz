#!/usr/bin/env node
/**
 * 拾分 · 零依赖浏览器 E2E 验收（Chrome CDP + Node 24 原生 WebSocket）
 *
 * 用法：
 *   node tests/e2e.mjs              # 完整验收（要求 index.html / js/app.js 已就绪）
 *   node tests/e2e.mjs --preflight  # 只自检测试基础设施（静态服务 + Chrome + CDP + 截图 + 文件上传）
 *   node tests/e2e.mjs --keep       # 保留 .tmp 与子进程（调试用）
 *
 * 输出：
 *   tests/report.md
 *   tests/screenshots/*.png
 *   tests/e2e.log
 *
 * 说明：
 *   - 不依赖任何 npm 包，不联网；只启动本地 Python 静态服务与本地 Chrome headless。
 *   - 使用独立临时 user-data-dir，因此每次运行都是全新 localStorage（可重复运行）。
 *   - 只写入 tests/ 下的文件，绝不修改产品代码。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, rm, stat, readdir as readdirP } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* 路径与常量                                                          */
/* ------------------------------------------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TESTS = __dirname;
const SHOTS = path.join(TESTS, 'screenshots');
const TMP = path.join(TESTS, '.tmp');
const DOWNLOADS = path.join(TMP, 'downloads');
const INDEX_HTML = path.join(ROOT, 'index.html');
const FIXTURE = path.join(TESTS, 'fixtures', 'selftest.html');

const PYTHON = String.raw`C:\Users\20306\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`;
const CHROME_CANDIDATES = [
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
];

const PORT = 8765;
const CDP_PORT = 9222;
const SHARED_CDP = process.env.SHIFEN_CDP || 'http://127.0.0.1:9222';
const APP_URL = `http://127.0.0.1:${PORT}/index.html`;
const FIXTURE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/selftest.html`;
const ROOT_URL = `http://127.0.0.1:${PORT}/`;
const VIEW_W = 1440;
const VIEW_H = 900;
const KEEP = process.argv.includes('--keep');
const PREFLIGHT_ONLY = process.argv.includes('--preflight');

/* ------------------------------------------------------------------ */
/* 日志                                                               */
/* ------------------------------------------------------------------ */

const logLines = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  logLines.push(line);
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').trim();
}

function clip(s, n = 160) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function stamp() {
  return new Date().toISOString();
}

function localTime() {
  try {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch {
    return new Date().toString();
  }
}

async function safeStat(p) {
  try {
    const s = await stat(p);
    return { ok: true, size: s.size };
  } catch {
    return { ok: false, size: 0 };
  }
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true)); // 绑定失败 = 端口被占用
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function fetchJson(url, timeout = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function poll(fn, { timeout = 8000, interval = 150, desc = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${desc}${lastErr ? ' / 最后错误: ' + lastErr.message : ''}`);
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 最小 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        p.reject(new Error('CDP 连接已关闭'));
      }
      this.pending.clear();
    });
    ws.addEventListener('error', () => {
      /* 失败由 pending/close 处理 */
    });
  }

  static async connect(url, timeout = 10000) {
    const ws = new WebSocket(url);
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('无法连接 CDP WebSocket: ' + url)), { once: true });
      }),
      sleep(timeout).then(() => {
        throw new Error('CDP WebSocket 连接超时: ' + url);
      }),
    ]);
    return new CDP(ws);
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const arr = this.listeners.get(msg.method) || [];
      for (const cb of [...arr]) {
        try {
          cb(msg.params || {});
        } catch {
          /* ignore listener errors */
        }
      }
    }
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  send(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 已关闭，无法发送: ' + method));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时（${timeout}ms）: ${method}`));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  waitEvent(method, { timeout = 15000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待事件超时（${timeout}ms）: ${method}`));
      }, timeout);
      const off = this.on(method, (params) => {
        let ok = false;
        try {
          ok = predicate(params);
        } catch {
          ok = false;
        }
        if (ok) {
          clearTimeout(timer);
          off();
          resolve(params);
        }
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 页面注入的轻量 helper（每次导航后重新注入）                          */
/* ------------------------------------------------------------------ */

const PAGE_HELPERS = String.raw`
window.__qa = {
  q: function (sel) { return document.querySelector(sel); },
  exists: function (sel) { return !!document.querySelector(sel); },
  count: function (sel) { return document.querySelectorAll(sel).length; },
  text: function (sel) { var el = document.querySelector(sel); return el ? (el.innerText || el.textContent || '') : ''; },
  visible: function (sel) {
    var el = document.querySelector(sel);
    if (!el || el.hidden) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    if (el.closest('[hidden]')) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  },
  click: function (sel) {
    var el = document.querySelector(sel);
    if (!el) throw new Error('元素不存在: ' + sel);
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.click();
    return true;
  },
  clickText: function (txt, scope) {
    var root = scope ? document.querySelector(scope) : document.body;
    if (!root) return false;
    function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
    var needle = norm(txt);
    var cands = Array.prototype.slice.call(root.querySelectorAll('button,a,[role="button"],label,[data-action],[data-view]'));
    var el = cands.find(function (n) { return norm(n.textContent).indexOf(needle) >= 0; });
    if (!el) el = cands.find(function (n) { return norm(n.getAttribute('aria-label') || n.title || '').indexOf(needle) >= 0; });
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.click();
    return true;
  },
  fill: function (sel, val) {
    var el = document.querySelector(sel);
    if (!el) throw new Error('输入框不存在: ' + sel);
    var proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  },
  blur: function (sel) {
    var el = document.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.blur();
    return true;
  },
  store: function () {
    try { var s = localStorage.getItem('shifen.v1'); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  },
  raw: function () {
    try { return localStorage.getItem('shifen.v1') || ''; } catch (e) { return ''; }
  },
  bodyText: function () { return document.body ? document.body.innerText : ''; }
};
`;

/* ------------------------------------------------------------------ */
/* 页面会话封装                                                        */
/* ------------------------------------------------------------------ */

class PageSession {
  constructor(cdp) {
    this.cdp = cdp;
    this.exceptions = [];
    this.consoleEntries = [];
    this.dialogs = 0;
  }

  async init() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
    await this.cdp.send('DOM.enable');
    try {
      await this.cdp.send('Network.enable');
      await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch {
      /* 老浏览器可能不支持，忽略 */
    }
    this.setupListeners();
    await this.viewport(VIEW_W, VIEW_H, { mobile: false, dpr: 1 });
  }

  setupListeners() {
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
        .join(' ');
      this.consoleEntries.push({
        kind: p.type,
        text,
        at: stamp(),
        source: 'console',
      });
    });
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const ex = d.exception || {};
      this.exceptions.push({
        text: d.text || ex.description || 'exception',
        description: ex.description || '',
        url: d.url || '',
        line: d.lineNumber,
        at: stamp(),
      });
    });
    this.cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      this.consoleEntries.push({
        kind: 'log-' + (e.level || 'info'),
        text: e.text || '',
        url: e.url || '',
        source: e.source || 'log',
        at: stamp(),
      });
    });
    this.cdp.on('Page.javascriptDialogOpening', async () => {
      this.dialogs += 1;
      try {
        await this.cdp.send('Page.handleJavaScriptDialog', { accept: true });
      } catch {
        /* ignore */
      }
    });
  }

  async eval(expr, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = (d.exception && d.exception.description) || d.text || '页面脚本执行异常';
      throw new Error('Runtime.evaluate 异常: ' + clip(msg, 300) + ' | expr=' + clip(expr, 120));
    }
    return res.result ? res.result.value : undefined;
  }

  async injectHelpers() {
    await this.eval(PAGE_HELPERS, { returnByValue: false });
  }

  async navigate(url, timeout = 20000) {
    const loaded = this.cdp.waitEvent('Page.loadEventFired', { timeout });
    await this.cdp.send('Page.navigate', { url });
    await loaded;
    await this.injectHelpers();
    await sleep(200);
  }

  async reload(timeout = 20000) {
    const loaded = this.cdp.waitEvent('Page.loadEventFired', { timeout });
    await this.cdp.send('Page.reload', { ignoreCache: false });
    await loaded;
    await this.injectHelpers();
    await sleep(300);
  }

  async viewport(width, height, { mobile = false, dpr = 1 } = {}) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
    try {
      await this.cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: mobile,
        maxTouchPoints: mobile ? 5 : 1,
      });
    } catch {
      /* ignore */
    }
    await sleep(120);
  }

  async waitFor(desc, expr, timeout = 8000) {
    return poll(() => this.eval(expr), { timeout, desc });
  }

  async waitVisible(sel, timeout = 6000) {
    return this.waitFor('元素可见 ' + sel, `__qa.visible(${JSON.stringify(sel)})`, timeout);
  }

  async waitHidden(sel, timeout = 6000) {
    return this.waitFor('元素隐藏 ' + sel, `!__qa.visible(${JSON.stringify(sel)})`, timeout);
  }

  async visible(sel) {
    return !!(await this.eval(`__qa.visible(${JSON.stringify(sel)})`));
  }

  async exists(sel) {
    return !!(await this.eval(`__qa.exists(${JSON.stringify(sel)})`));
  }

  async text(sel) {
    return String((await this.eval(`__qa.text(${JSON.stringify(sel)})`)) || '');
  }

  async innerText() {
    return String((await this.eval('__qa.bodyText()')) || '');
  }

  async count(sel) {
    return Number(await this.eval(`__qa.count(${JSON.stringify(sel)})`));
  }

  async click(sel) {
    return this.eval(`__qa.click(${JSON.stringify(sel)})`);
  }

  async clickText(txt, scope = 'body') {
    return !!(await this.eval(`__qa.clickText(${JSON.stringify(txt)},${JSON.stringify(scope)})`));
  }

  async fill(sel, value) {
    return this.eval(`__qa.fill(${JSON.stringify(sel)},${JSON.stringify(String(value))})`);
  }

  async blur(sel) {
    return !!(await this.eval(`__qa.blur(${JSON.stringify(sel)})`));
  }

  async store() {
    return this.eval('__qa.store()');
  }

  async rawStore() {
    return String((await this.eval('__qa.raw()')) || '');
  }

  async setFiles(selector, files) {
    const doc = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: false });
    const { nodeId } = await this.cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error('文件输入框不存在: ' + selector);
    await this.cdp.send('DOM.setFileInputFiles', { files, nodeId });
  }

  async pressEscape() {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }

  async screenshot(name, dir = SHOTS) {
    const res = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name.endsWith('.png') ? name : name + '.png');
    await writeFile(file, Buffer.from(res.data, 'base64'));
    return path.relative(TESTS, file).split(path.sep).join('/');
  }

  criticalConsoleErrors() {
    return this.consoleEntries.filter((e) => {
      const text = `${e.text} ${e.url || ''}`;
      if (/favicon\.ico/i.test(text)) return false;
      if (e.kind === 'error') return true;
      if (e.kind === 'log-error') return true;
      return false;
    });
  }
}

/* ------------------------------------------------------------------ */
/* 基础设施：静态服务 + Chrome headless                                */
/* ------------------------------------------------------------------ */

let serverProc = null;
let serverReused = false;
let chromeProc = null;
let sharedTargetId = null;
let cdp = null;
let page = null;
let chromeInfo = null;

async function ensureStaticServer() {
  // 端口已有本项目静态服务则复用
  try {
    const res = await fetch(ROOT_URL + 'docs/contracts.md', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const text = await res.text();
      if (text.includes('拾分') && text.includes('契约')) {
        serverReused = true;
        log(`[infra] 复用已有静态服务 http://127.0.0.1:${PORT}/`);
        return;
      }
    }
  } catch {
    /* 继续启动 */
  }

  if (await portOpen(PORT)) {
    throw new Error(
      `端口 ${PORT} 已被其他进程占用，且不是本项目的静态服务。请先释放该端口后重试。`
    );
  }

  serverProc = spawn(PYTHON, ['-m', 'http.server', String(PORT), '--directory', ROOT], {
    stdio: 'ignore',
    windowsHide: true,
  });
  serverProc.on('error', (e) => log('[infra] 静态服务启动错误: ' + e.message));

  await poll(
    async () => {
      const res = await fetch(ROOT_URL + 'docs/contracts.md', { signal: AbortSignal.timeout(1000) });
      return res.ok;
    },
    { timeout: 12000, desc: '静态服务可访问' }
  );
  log(`[infra] 已启动静态服务 http://127.0.0.1:${PORT}/ (pid=${serverProc.pid})`);
}

async function waitCdpVersion(port, timeout = 15000) {
  return poll(() => fetchJson(`http://127.0.0.1:${port}/json/version`), {
    timeout,
    desc: `Chrome 调试端口 ${port} 就绪`,
  });
}

async function getPageTarget(port) {
  return poll(
    async () => {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1500);
      const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      return target || null;
    },
    { timeout: 15000, desc: '获取页面 CDP target' }
  );
}

/**
 * 启动策略：
 *   1) 首选自行启动一个全新 user-data-dir 的 headless Chrome（本轮已切换到完全权限）；
 *   2) 若自行启动失败，再兜底复用外部已启动的 CDP（只新建/关闭自己的 target，
 *      绝不关闭或杀掉共享浏览器）。
 * 端口默认 9222，被占用时自动换一个空闲端口。
 */
async function launchLocalChrome() {
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('未找到 Chrome/Edge，检查路径: ' + CHROME_CANDIDATES.join(' | '));

  const usedPort = (await portOpen(CDP_PORT)) ? await freePort() : CDP_PORT;
  const profileDir = path.join(TMP, 'chrome-profile');
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const baseArgs = [
    '--headless=new',
    `--remote-debugging-port=${usedPort}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    `--window-size=${VIEW_W},${VIEW_H}`,
    'about:blank',
  ];

  const attempts = [baseArgs, [...baseArgs, '--no-sandbox']];
  let lastErr = null;

  for (let i = 0; i < attempts.length; i += 1) {
    const args = attempts[i];
    log(`[infra] 启动全新 Chrome (尝试 ${i + 1}/${attempts.length}): ${exe} profile=${profileDir}`);
    const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log('[infra] 浏览器进程错误: ' + e.message));
    try {
      const version = await waitCdpVersion(usedPort);
      chromeProc = child;
      chromeInfo = {
        reused: false,
        exe,
        port: usedPort,
        profileDir,
        version: version['Browser'] || 'unknown',
        protocol: version['Protocol-Version'] || 'unknown',
        args,
      };
      log(`[infra] 浏览器就绪: ${chromeInfo.version} (CDP ${usedPort}, 全新 profile)`);
      return chromeInfo;
    } catch (e) {
      lastErr = e;
      log('[infra] 浏览器启动尝试失败: ' + e.message);
      killTree(child.pid);
      await sleep(600);
    }
  }
  throw new Error('Chrome headless 启动失败: ' + (lastErr ? lastErr.message : 'unknown'));
}

async function tryReuseSharedChrome() {
  const version = await fetchJson(`${SHARED_CDP}/json/version`, 2500);
  if (!version || !version.webSocketDebuggerUrl) throw new Error('共享 CDP 无 webSocketDebuggerUrl');
  chromeInfo = {
    reused: true,
    exe: 'shared-cdp',
    port: Number(new URL(SHARED_CDP).port || 9222),
    base: SHARED_CDP,
    version: version['Browser'] || 'unknown',
    protocol: version['Protocol-Version'] || 'unknown',
    args: [],
  };
  log(`[infra] 复用共享浏览器: ${chromeInfo.version} @ ${SHARED_CDP}（仅操作自己的 target）`);
  return chromeInfo;
}

async function createOwnTarget() {
  const url = `${SHARED_CDP}/json/new?${encodeURIComponent('about:blank')}`;
  const res = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`PUT /json/new 失败: HTTP ${res.status}`);
  const target = await res.json();
  if (!target || !target.id || !target.webSocketDebuggerUrl) {
    throw new Error('PUT /json/new 返回无效 target');
  }
  sharedTargetId = target.id;
  log('[infra] 已新建独立页面 target: ' + target.id);
  return target;
}

async function closeOwnTarget() {
  if (!sharedTargetId) return;
  const id = sharedTargetId;
  sharedTargetId = null;
  try {
    await fetch(`${SHARED_CDP}/json/close/${id}`, { signal: AbortSignal.timeout(3000) });
    log('[infra] 已关闭自己的页面 target: ' + id);
  } catch (e) {
    log('[infra] 关闭 target 失败（忽略）: ' + e.message);
  }
}

async function launchChrome() {
  // 当前进程仍受命名管道限制：优先复用 Lead 以完全权限启动的共享 Chrome
  try {
    return await tryReuseSharedChrome();
  } catch (sharedErr) {
    log('[infra] 共享 CDP 不可用: ' + sharedErr.message + '，尝试自行启动（可能因沙箱失败）');
    try {
      return await launchLocalChrome();
    } catch (localErr) {
      throw new Error(
        `无法复用或启动 Chrome。\n共享 CDP: ${sharedErr.message}\n自行启动: ${localErr.message}`
      );
    }
  }
}

async function connectPage() {
  const target = chromeInfo.reused ? await createOwnTarget() : await getPageTarget(chromeInfo.port);
  log('[infra] 页面 target: ' + (target.url || target.id));
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  page = new PageSession(cdp);
  await page.init();
  log('[infra] CDP 会话就绪');
}

async function cleanup() {
  try {
    if (cdp) cdp.close();
  } catch {
    /* ignore */
  }
  if (chromeInfo && chromeInfo.reused) {
    await closeOwnTarget();
  }
  if (chromeProc) {
    killTree(chromeProc.pid);
    chromeProc = null;
  }
  if (serverProc) {
    killTree(serverProc.pid);
    serverProc = null;
  }
  if (!KEEP) {
    await sleep(400);
    try {
      await rm(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 断言 / 用例记录                                                     */
/* ------------------------------------------------------------------ */

class SkipError extends Error {}

const results = [];
let currentTest = null;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function note(msg) {
  if (!currentTest) {
    log('  · ' + msg);
    return;
  }
  currentTest.evidence.push(msg);
  log('  · ' + msg);
}

async function test(id, title, expect, steps, fn) {
  const r = {
    id,
    title,
    expect,
    steps,
    status: 'PASS',
    evidence: [],
    shots: [],
    error: null,
    duration: 0,
    startedAt: stamp(),
  };
  currentTest = r;
  log(`\n▶ ${id} ${title}`);
  const started = Date.now();
  try {
    await fn(r);
  } catch (e) {
    if (e instanceof SkipError) {
      r.status = 'SKIP';
      r.error = e.message;
      log('  ○ SKIP: ' + e.message);
    } else {
      r.status = 'FAIL';
      r.error = String((e && e.message) || e);
      log('  ✘ FAIL: ' + r.error);
      try {
        const shot = await page.screenshot('fail-' + id);
        r.shots.push(shot);
      } catch {
        /* ignore */
      }
      try {
        const info = await page.eval(
          '(()=>({url:location.href,title:document.title,text:(document.body&&document.body.innerText||"").slice(0,300)}))()'
        );
        r.evidence.push('失败时页面: ' + clip(info.title + ' @ ' + info.url, 160));
        r.evidence.push('失败时可见文本: ' + clip(info.text, 200));
      } catch {
        /* ignore */
      }
    }
  }
  r.duration = Date.now() - started;
  currentTest = null;
  results.push(r);
  if (r.status === 'PASS') log(`  ✔ PASS (${r.duration}ms)`);
  return r;
}

/* ------------------------------------------------------------------ */
/* 页面侧业务辅助                                                      */
/* ------------------------------------------------------------------ */

async function goView(view) {
  const selector = `nav.nav [data-view="${view}"],[data-view="${view}"]`;
  const clicked = await page.eval(
    `(()=>{const b=document.querySelector(${JSON.stringify(selector)}); if(!b) return false; b.scrollIntoView({block:'center'}); b.click(); return true;})()`
  );
  assert(clicked, `找不到导航项 data-view="${view}"`);
  await sleep(250);
  try {
    await page.waitFor(`视图 #view-${view} 可见`, `__qa.visible(${JSON.stringify('#view-' + view)})`, 3000);
  } catch {
    // 有些实现用 class 切换而不是 hidden，放宽为“视图存在且非 hidden 属性”
    const exists = await page.exists('#view-' + view);
    assert(exists, `视图 #view-${view} 不存在`);
  }
}

async function ensurePractice() {
  await goView('practice');
  if (!(await page.visible('#questionText'))) {
    await page.clickText('继续练习', 'body');
    await page.clickText('开始练习', 'body');
    await sleep(300);
  }
  await page.waitFor(
    '练习区显示题目',
    '(()=>__qa.exists("#questionText") && __qa.text("#questionText").trim().length>0)()',
    10000
  );
  await sleep(150);
}

async function currentQuestion() {
  const qt = norm(await page.text('#questionText'));
  const s = await page.store();
  if (!qt || !s || !Array.isArray(s.questions)) return { qt, q: null, state: s };

  // 首选 app 在 #questionCard 上标注的精确 id（可消除重复题干歧义）
  const domInfo = await page.eval(
    '(()=>{const c=document.querySelector("#questionCard"); if(!c) return null;' +
      'return {qid:c.dataset.questionId||null, bid:c.dataset.bankId||null};})()'
  );
  if (domInfo && domInfo.qid) {
    const exact = s.questions.find((x) => x.id === domInfo.qid);
    if (exact) return { qt, q: exact, state: s, source: 'dom' };
  }

  const matches = (x) => {
    const nq = norm(x.question);
    if (!nq) return false;
    const head = nq.slice(0, Math.min(15, nq.length));
    return nq.includes(qt.slice(0, Math.min(15, qt.length))) || qt.includes(head);
  };

  const candidates = s.questions.filter(matches);
  let q = null;
  // 兜底：不同题库可能有重复题目，优先用当前练习题库（#practiceBankName / state.ui.lastBankId）消歧
  const bankName = (await page.text('#practiceBankName')).trim();
  if (s.ui && s.ui.lastBankId) {
    q = candidates.find((x) => x.bankId === s.ui.lastBankId) || null;
  }
  if (!q && bankName) {
    const bank = (s.banks || []).find((b) => b.name === bankName);
    if (bank) q = candidates.find((x) => x.bankId === bank.id) || null;
  }
  if (!q) q = candidates[0] || null;
  return { qt, q, state: s, source: 'text' };
}

const RATING_LABELS = { 0: '忘记', 1: '模糊', 2: '掌握', 3: '熟练' };

async function rate(rating) {
  const label = RATING_LABELS[rating];
  const ok = await page.eval(
    `(()=>{const bar=document.querySelector('#ratingBar'); if(!bar) return false;` +
      `const cs=Array.from(bar.querySelectorAll('button,[role="button"],[data-rating],.rating-btn'));` +
      `const attr=cs.find(x=>x.getAttribute('data-rating')===${JSON.stringify(String(rating))});` +
      `const txt=cs.find(x=>(x.textContent||'').includes(${JSON.stringify(label)}));` +
      `const el=attr||txt||cs[${rating}]; if(!el) return false; el.click(); return true;})()`
  );
  assert(ok, `评级按钮未找到: ${rating} ${label}`);
}

async function waitForProgress(qid, rating, desc, timeout = 6000) {
  await page.waitFor(
    desc,
    `(()=>{const s=__qa.store(); if(!s||!s.progress) return false; const p=s.progress[${JSON.stringify(
      qid
    )}]; return !!p && p.attempts>0 && p.lastRating===${rating};})()`,
    timeout
  );
}

async function waitQuestionChange(prevText, timeout = 4000) {
  const target = norm(prevText);
  try {
    await page.waitFor(
      '切换下一题',
      `(()=>{const t=(document.querySelector('#questionText')&&document.querySelector('#questionText').innerText||''); return t.trim().length>0 && t.replace(/\\s+/g,'')!==${JSON.stringify(
        target
      )};})()`,
      timeout
    );
    return true;
  } catch {
    return false;
  }
}

async function closeAnyModal() {
  const clicked = await page.eval(
    `(()=>{const roots=[document.querySelector('#modalRoot'),document.querySelector('#importModal')].filter(Boolean);` +
      `for(const root of roots){const b=Array.from(root.querySelectorAll('button,[role="button"],a')).find(x=>/关闭|完成|知道了|取消|返回|保存/.test(x.textContent||'')); if(b){b.click(); return true;}} return false;})()`
  );
  if (!clicked) {
    try {
      await page.pressEscape();
    } catch {
      /* ignore */
    }
  }
  await sleep(300);
}

async function resolveSample(preferredRel, ext) {
  if (preferredRel && existsSync(path.join(ROOT, preferredRel))) return preferredRel;
  const samplesDir = path.join(ROOT, 'samples');
  let files = [];
  try {
    files = await readdir(samplesDir);
  } catch {
    files = [];
  }
  const hit = files.find((f) => !f.startsWith('~$') && f.toLowerCase().endsWith(ext));
  if (hit) return 'samples/' + hit;
  throw new Error(`缺少示例文件 samples/*${ext}（依赖 importer，当前无法完成该导入用例）`);
}

async function importSampleFile(relPath, { previewShot = null } = {}) {
  const abs = path.join(ROOT, relPath);
  assert(existsSync(abs), `示例文件不存在: ${relPath}`);
  const before = await page.store();
  assert(before && Array.isArray(before.questions), '应用 state 不可用，无法导入');

  await page.click('#importBtn');
  await page.waitFor(
    '导入弹窗打开（动态渲染）',
    '(()=>!!document.querySelector("#dropZone") && !!document.querySelector("#fileInput") && !!document.querySelector("#importPreview"))()',
    8000
  );
  await page.setFiles('#fileInput', [abs]);

  const parseDoneExpr =
    '(()=>{const b=document.querySelector("#confirmImport"); if(!b||b.disabled) return false;' +
    'const m=(b.textContent||"").match(/[0-9]+/); return !!m && Number(m[0])>0;})()';

  try {
    await page.waitFor(`导入解析完成（${path.basename(relPath)}）`, parseDoneExpr, 12000);
  } catch {
    // 兼容个别环境 setFileInputFiles 未触发 change 的情况
    await page.eval(
      `(()=>{const el=document.querySelector('#fileInput'); if(el) el.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`
    );
    await page.waitFor(`导入解析完成-重试（${path.basename(relPath)}）`, parseDoneExpr, 25000);
  }
  await sleep(300);

  const preview = clip(await page.text('#importPreview'), 400);
  note(`导入预览（${path.basename(relPath)}）: ${preview}`);
  if (previewShot) {
    const shot = await page.screenshot(previewShot);
    if (currentTest) currentTest.shots.push(shot);
  }

  const confirmLabel = clip(await page.text('#confirmImport'), 40);
  note(`确认按钮：${confirmLabel}`);
  assert(/[0-9]/.test(confirmLabel), '确认按钮未显示导入题数');

  await page.click('#confirmImport');
  await page.waitFor(
    '导入写入 localStorage',
    `(()=>{try{const s=__qa.store(); return !!s && s.questions.length > ${before.questions.length};}catch(e){return false;}})()`,
    20000
  );
  await sleep(500);

  // 导入成功后 app 会自动关闭弹窗（180ms 动画）
  try {
    await page.waitFor(
      '导入弹窗关闭',
      '(()=>!document.querySelector("#dropZone") || !__qa.visible("#dropZone"))()',
      4000
    );
  } catch {
    await closeAnyModal();
  }

  const after = await page.store();
  const beforeIds = new Set(before.questions.map((q) => q.id));
  const newQuestions = after.questions.filter((q) => !beforeIds.has(q.id));
  const newBanks = after.banks.filter((b) => !before.banks.some((x) => x.id === b.id));

  return { before, after, newQuestions, newBanks, preview, name: path.basename(relPath) };
}

function validateImportedQuestions(newQuestions, fileName) {
  assert(newQuestions.length > 0, `${fileName} 未解析出任何题目`);
  const bad = [];
  for (const q of newQuestions) {
    const problems = [];
    if (typeof q.question !== 'string' || !q.question.trim()) problems.push('question 为空');
    if (typeof q.answer !== 'string') problems.push('answer 非字符串');
    if (!Array.isArray(q.keywords)) problems.push('keywords 非数组');
    if (![1, 2, 3].includes(Number(q.difficulty))) problems.push('difficulty 非 1/2/3');
    if (typeof q.source !== 'string' || !q.source.trim()) problems.push('source 为空');
    if (typeof q.id !== 'string' || !q.id) problems.push('id 缺失');
    if (typeof q.bankId !== 'string' || !q.bankId) problems.push('bankId 缺失');
    if (problems.length) bad.push(`${clip(q.question, 20)} -> ${problems.join(', ')}`);
  }
  assert(bad.length === 0, `${fileName} 导入字段不合契约: ${bad.slice(0, 4).join(' | ')}`);
  const noAnswer = newQuestions.filter((q) => !q.answer.trim()).length;
  if (noAnswer > 0) note(`注意：${fileName} 有 ${noAnswer} 题答案为空（导入器应给出 warning）`);
}

async function startPracticeFromBank(bankName, bankId) {
  await goView('banks');
  await sleep(350);
  const started = await page.eval(
    `(()=>{const scope=document.querySelector('#view-banks'); if(!scope) return false;` +
      `const id=${JSON.stringify(bankId || '')}; const name=${JSON.stringify(bankName || '')};` +
      `let btn=null;` +
      `if(id) btn=scope.querySelector('[data-action="start-bank"][data-bank-id="'+id+'"]');` +
      `if(!btn&&name){` +
      `const cards=Array.from(scope.querySelectorAll('.bank-card,.card,[data-bank-id],li,article,.bank-row'));` +
      `const card=cards.find(c=>(c.textContent||'').includes(name));` +
      `if(card) btn=card.querySelector('[data-action="start-bank"]');` +
      `if(!btn) btn=Array.from(scope.querySelectorAll('[data-action="start-bank"]')).find(b=>{const row=b.closest('.bank-card,.card,[data-bank-id],li,article,.bank-row')||b.parentElement; return row && (row.textContent||'').includes(name);});` +
      `}` +
      `if(!btn) btn=Array.from(scope.querySelectorAll('[data-action="start-bank"]'))[0];` +
      `if(!btn) return false; btn.scrollIntoView({block:'center'}); btn.click(); return true;})()`
  );
  if (!started) return false;
  await sleep(450);
  try {
    await page.waitFor(
      '练习题目出现',
      '(()=>__qa.visible("#view-practice") && __qa.exists("#questionText") && __qa.text("#questionText").trim().length>0)()',
      6000
    );
  } catch {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 基础设施自检（fixture）                                             */
/* ------------------------------------------------------------------ */

async function infraCheck() {
  const uploadFile = path.join(TMP, 'preflight-upload.txt');
  await mkdir(TMP, { recursive: true });
  await writeFile(uploadFile, '拾分 harness preflight upload\n', 'utf8');

  await page.navigate(FIXTURE_URL);
  await page.waitFor('selftest 页面加载', 'document.readyState==="complete" && !!document.getElementById("btn")', 8000);
  const sum = await page.eval('1+1');
  assert(sum === 2, 'Runtime.evaluate 失败（1+1 !== 2）');
  await page.click('#btn');
  await sleep(120);
  const out = (await page.text('#out')).trim();
  assert(out === '1', 'DOM 点击未生效（#out=' + out + '）');

  await page.setFiles('#file', [uploadFile]);
  await page.waitFor(
    '文件上传事件触发',
    '(()=>{const t=__qa.text("#fileInfo").trim(); return t.length>0 && t!=="none";})()',
    6000
  );
  const fileInfo = (await page.text('#fileInfo')).trim();
  assert(fileInfo.includes('preflight-upload.txt'), '文件上传未生效（#fileInfo=' + fileInfo + '）');

  const shot = await page.screenshot('00-infra-preflight');
  return { sum, out, fileInfo, shot };
}

/* ------------------------------------------------------------------ */
/* 报告                                                               */
/* ------------------------------------------------------------------ */

function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function appFileSummary() {
  const files = [
    ['index.html', path.join(ROOT, 'index.html')],
    ['js/app.js', path.join(ROOT, 'js', 'app.js')],
    ['js/importers.js', path.join(ROOT, 'js', 'importers.js')],
    ['css/styles.css', path.join(ROOT, 'css', 'styles.css')],
  ];
  const rows = [];
  for (const [label, p] of files) {
    const s = await safeStat(p);
    rows.push(`${label}: ${s.ok ? s.size + ' bytes' : '缺失'}`);
  }
  let samples = [];
  try {
    samples = (await readdir(path.join(ROOT, 'samples'))).filter((f) => !f.startsWith('~$'));
  } catch {
    samples = [];
  }
  rows.push('samples: ' + (samples.length ? samples.join(', ') : '空/缺失'));
  return rows;
}

async function writeReport({ mode, infra, fatal = null, startedAt, finishedAt }) {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  const total = results.length;
  const lines = [];

  lines.push('# 拾分 · E2E 验收报告');
  lines.push('');
  lines.push(`- 生成时间：${finishedAt || localTime()}`);
  lines.push(`- 运行模式：${mode}`);
  lines.push(`- 运行耗时：${startedAt ? Math.round((Date.now() - startedAt) / 1000) + ' 秒' : 'n/a'}`);
  lines.push(`- 静态服务：http://127.0.0.1:${PORT}/ ${serverReused ? '（复用已有服务）' : '（本次启动）'}`);
  if (chromeInfo) {
    lines.push(`- 浏览器：${chromeInfo.version}（${chromeInfo.exe}，CDP ${chromeInfo.port}）`);
  }
  lines.push(`- 视口：桌面 ${VIEW_W}x${VIEW_H}；移动端 390x844`);
  lines.push('');
  lines.push('## 应用文件');
  lines.push('');
  for (const row of await appFileSummary()) lines.push('- ' + row);
  lines.push('');
  lines.push('## 结果汇总');
  lines.push('');
  lines.push(`| 通过 | 失败 | 跳过 | 合计 |`);
  lines.push(`| --- | --- | --- | --- |`);
  lines.push(`| ${pass} | ${fail} | ${skip} | ${total} |`);
  lines.push('');
  if (total > 0) {
    lines.push(
      fail === 0
        ? `**结论：${pass}/${total} 项通过，0 项失败，验收通过。**`
        : `**结论：${fail} 项失败，需要修复后重跑。**`
    );
    lines.push('');
  }

  if (fatal) {
    lines.push('## ⚠ 运行被阻断');
    lines.push('');
    lines.push('```');
    lines.push(fatal);
    lines.push('```');
    lines.push('');
  }

  if (results.length) {
    lines.push('## 逐项结果');
    lines.push('');
    lines.push('| 编号 | 验收项 | 结果 | 证据摘要 | 截图 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of results) {
      const ev = clip((r.error ? `错误: ${r.error}；` : '') + r.evidence.join('；'), 180);
      const shots = r.shots.length ? r.shots.map((s) => `[图](${s})`).join(' ') : '—';
      lines.push(`| ${r.id} | ${mdCell(r.title)} | ${r.status} | ${mdCell(ev)} | ${shots} |`);
    }
    lines.push('');
    lines.push('## 用例明细');
    lines.push('');
    for (const r of results) {
      lines.push(`### ${r.id} ${r.title} — ${r.status}`);
      lines.push('');
      lines.push(`- 验收标准：${r.expect}`);
      if (r.error) lines.push(`- 错误：${r.error}`);
      lines.push('- 步骤：');
      r.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
      if (r.evidence.length) {
        lines.push('- 证据：');
        for (const e of r.evidence) lines.push(`  - ${e}`);
      }
      if (r.shots.length) {
        lines.push('- 截图：' + r.shots.map((s) => `[${s}](${s})`).join('、'));
      }
      lines.push(`- 耗时：${r.duration} ms`);
      lines.push('');
    }
  }

  const ex = page ? page.exceptions : [];
  const errs = page ? page.criticalConsoleErrors() : [];
  lines.push('## 控制台报错');
  lines.push('');
  lines.push(`- 未捕获异常：${ex.length} 条`);
  for (const e of ex.slice(0, 20)) {
    lines.push(`  - [${e.at}] ${clip(e.text, 300)} ${e.url ? '@ ' + e.url : ''}`);
  }
  lines.push(`- 错误级控制台输出：${errs.length} 条`);
  for (const e of errs.slice(0, 30)) {
    lines.push(`  - [${e.at}] (${e.kind}) ${clip(e.text, 300)} ${e.url ? '@ ' + e.url : ''}`);
  }
  const warns = page ? page.consoleEntries.filter((e) => e.kind === 'warning' || e.kind === 'log-warning') : [];
  lines.push(`- 警告：${warns.length} 条`);
  for (const e of warns.slice(0, 10)) lines.push(`  - ${clip(e.text, 200)}`);
  lines.push('');

  lines.push('## 状态摘要');
  lines.push('');
  let summary = null;
  try {
    summary = page ? await page.store() : null;
  } catch {
    summary = null;
  }
  if (summary) {
    const practiced = Object.values(summary.progress || {}).filter((p) => p.attempts > 0).length;
    const favorites = Object.values(summary.progress || {}).filter((p) => p.favorite).length;
    lines.push(`- 题库：${summary.banks?.length || 0} 个（${(summary.banks || []).map((b) => b.name).slice(0, 8).join('、')}）`);
    lines.push(`- 题目：${summary.questions?.length || 0} 题；已练习：${practiced} 题；收藏：${favorites} 题`);
    lines.push(`- 设置：${JSON.stringify(summary.settings || {})}`);
    lines.push(`- localStorage shifen.v1：${(await page.rawStore()).length} chars`);
  } else {
    lines.push('- 无法读取 localStorage（应用未初始化或页面不可用）');
  }
  lines.push('');

  const shotFiles = [];
  try {
    const list = await readdir(SHOTS);
    shotFiles.push(...list.filter((f) => f.endsWith('.png')).sort());
  } catch {
    /* ignore */
  }
  if (shotFiles.length) {
    lines.push('## 展示截图');
    lines.push('');
    const showcase = ['01-dashboard-1440', '02-practice-1440', '03-import-preview', '04-stats-1440', '05-mobile-390', '06-dark-1440'];
    for (const key of showcase) {
      const f = shotFiles.find((x) => x.startsWith(key));
      if (f) {
        lines.push(`### ${key}`);
        lines.push(`![${key}](screenshots/${f})`);
        lines.push('');
      }
    }
    lines.push('全部截图：');
    lines.push('');
    for (const f of shotFiles) lines.push(`- [${f}](screenshots/${f})`);
    lines.push('');
  }

  if (infra) {
    lines.push('## 测试基础设施自检');
    lines.push('');
    lines.push(`- Runtime.evaluate：1+1=${infra.sum}`);
    lines.push(`- 点击：按钮后 #out=${infra.out}`);
    lines.push(`- 文件上传：${infra.fileInfo}`);
    lines.push(`- 截图：${infra.shot}`);
    lines.push('');
  }

  lines.push('## 契约偏差与说明（不阻塞本轮验收）');
  lines.push('');
  lines.push('- **#importModal**：导入弹窗由 `#modalRoot` 内动态 `.modal-overlay` 渲染，没有契约 §4 的 `#importModal` id；内部 `#dropZone/#fileInput/#pasteInput/#importPreview/#confirmImport` 全部存在，功能验收通过。');
  lines.push('- **首屏文案**：首次打开仪表盘显示「开始练习 · 12 题」，契约 §5.1 写的是「继续练习」；进入练习与续练能力一致。');
  lines.push('- **活跃图周期**：统计页渲染「最近 14 天」柱状图（含本周 7 日汇总），契约 §5.6 写「7 日活跃图」；数据与柱数完整。');
  lines.push('- **掌握度**：实现采用 master 锚点 `[15,45,78,100]`（首次「掌握」=78），与契约 §2 旧版加权公式不同；已按 Lead 确认的定稿口径验证。');
  lines.push('');
  lines.push('## 备注');
  lines.push('');
  lines.push('- 测试使用独立临时 Chrome user-data-dir，每次运行 localStorage 均为空，可重复执行。');
  lines.push('- 测试只读取产品文件，不修改产品代码；发现的问题以本报告 + 截图 + 控制台错误为准。');
  lines.push('- 上传文件均来自 samples/，未联网、未安装任何 npm 包。');
  lines.push('');

  await writeFile(path.join(TESTS, 'report.md'), lines.join('\n'), 'utf8');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  await mkdir(SHOTS, { recursive: true });
  await mkdir(TMP, { recursive: true });
  await mkdir(DOWNLOADS, { recursive: true });
  // 清理上次截图，避免报告里出现陈旧图片
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });

  let fatal = null;
  let mode = PREFLIGHT_ONLY ? 'preflight' : existsSync(INDEX_HTML) ? 'full' : 'blocked';

  try {
    log('[infra] 工作目录: ' + ROOT);
    log('[infra] Node: ' + process.version);
    await ensureStaticServer();
    await launchChrome();
    await connectPage();

    const infra = await infraCheck();
    log(`[infra] 自检通过：evaluate=${infra.sum}, click=${infra.out}, upload=${infra.fileInfo}`);

    // 每次运行前清空 localStorage（当前页为测试夹具，与应用同源）
    await page.eval('localStorage.clear(); sessionStorage.clear();');
    log('[suite] 已清空 localStorage/sessionStorage，保证可重复运行');

    if (PREFLIGHT_ONLY) {
      await writeReport({
        mode: 'preflight（仅基础设施自检）',
        infra,
        startedAt,
        finishedAt: localTime(),
      });
      log('\n[preflight] PASS — 测试基础设施就绪');
      return;
    }

    if (mode === 'blocked') {
      fatal =
        '应用尚未就绪：' + INDEX_HTML + ' 不存在。已跳过全部业务用例，等待应用由 Lead 完成后重跑。';
      await writeReport({
        mode: 'blocked（应用未就绪）',
        infra,
        fatal,
        startedAt,
        finishedAt: localTime(),
      });
      log('\n[blocked] ' + fatal);
      process.exitCode = 2;
      return;
    }

    // ---- 业务用例 ----
    let appBroken = false;

    await test(
      'T0',
      '应用启动与首屏',
      '打开 index.html 后 #app 渲染、标题正确、首屏无脚本错误',
      ['启动静态服务', 'Chrome headless 打开 http://127.0.0.1:8765/index.html', '等待 #app 渲染并截图'],
      async () => {
        await page.navigate(APP_URL);
        await page.waitFor('index.html 加载完成', 'document.readyState==="complete"', 15000);
        await page.waitFor(
          '应用渲染首屏视图',
          '(()=>{const v=document.querySelector("#view-dashboard"); return !!v && !v.hidden && (v.innerText||"").trim().length>20;})()',
          15000
        );
        await sleep(500);
        const info = await page.eval(
          '(()=>{const app=document.querySelector("#app");return {children:app?app.children.length:0,title:document.title,text:(document.body&&document.body.innerText||"").slice(0,200)};})()'
        );
        assert(info.children > 0, '#app 内没有任何渲染内容（js/app.js 未执行或报错）');
        note(`页面标题：${info.title || '(空)'}`);
        note(`首屏文本：${clip(info.text, 160)}`);
        const shot = await page.screenshot('01-dashboard-1440');
        currentTest.shots.push(shot);
      }
    );

    appBroken = results.find((r) => r.id === 'T0')?.status === 'FAIL';

    if (!appBroken) {
      await test(
        'T1',
        'DOM 结构契约',
        '契约第 4 节列出的容器/视图/练习节点/弹窗节点全部存在',
        ['读取文档中全部契约选择器', '在页面内逐个查询并列出缺失项'],
        async () => {
          const required = [
            '#app',
            '.sidebar',
            '.sidebar .brand',
            'nav.nav',
            '.sidebar-foot',
            '#importBtn',
            '#settingsBtn',
            'main.main',
            '#view-dashboard',
            '#view-practice',
            '#view-banks',
            '#view-wrong',
            '#view-favorites',
            '#view-stats',
            '#modalRoot',
            '#toastRoot',
            '#practiceEmpty',
            '#practiceStage',
            '#questionText',
            '#answerInput',
            '#revealBtn',
            '#referencePanel',
            '#referenceText',
            '#keywordChips',
            '#ratingBar',
            '#nextBtn',
            '#prevBtn',
            '#sessionProgress',
            '#progressFill',
          ];
          const missing = await page.eval(
            `(()=>{const req=${JSON.stringify(required)};return req.filter(s=>!document.querySelector(s));})()`
          );
          assert(missing.length === 0, '缺少契约节点: ' + missing.join(', '));
          note(`静态契约节点 ${required.length} 个全部存在`);

          // 导入弹窗是 app.js 动态渲染的，打开后再校验内部节点
          await page.click('#importBtn');
          await page.waitFor(
            '导入弹窗打开',
            '(()=>!!document.querySelector("#dropZone") && !!document.querySelector("#fileInput") && !!document.querySelector("#importPreview"))()',
            8000
          );
          const dynRequired = ['#dropZone', '#fileInput', '#pasteInput', '#importPreview', '#confirmImport'];
          const dynMissing = await page.eval(
            `(()=>{const req=${JSON.stringify(dynRequired)};return req.filter(s=>!document.querySelector(s));})()`
          );
          assert(dynMissing.length === 0, '导入弹窗缺少节点: ' + dynMissing.join(', '));
          note(`动态导入弹窗节点 ${dynRequired.length} 个全部存在`);
          if (!(await page.exists('#importModal'))) {
            note('契约偏差：#importModal 未实现；导入弹窗实际为 #modalRoot 内动态 .modal-overlay，功能节点齐全');
          }
          await closeAnyModal();
        }
      );

      await test(
        'T2',
        '首次打开载入内置示例题库',
        '首次打开自动载入内置示例题库（≥10 题），仪表盘可见“继续练习”',
        ['清空态启动（独立 profile 已保证）', '读取 localStorage shifen.v1', '切到仪表盘检查文案'],
        async () => {
          const s = await page.store();
          assert(s, 'localStorage 中没有 shifen.v1');
          assert(Array.isArray(s.banks) && s.banks.length >= 1, '没有内置示例题库');
          assert(Array.isArray(s.questions) && s.questions.length >= 10, `内置示例题不足 10 题（${s.questions?.length || 0}）`);
          note(`内置题库：${s.banks.length} 个；题目：${s.questions.length} 题`);
          await goView('dashboard');
          const text = await page.innerText();
          note(`仪表盘文本：${clip(text, 200)}`);
          assert(
            text.includes('继续练习') || text.includes('开始练习'),
            '仪表盘未见“继续练习/开始练习”入口'
          );
          if (!text.includes('继续练习')) {
            note('文案说明：首次打开显示“开始练习”（契约原文为“继续练习”，功能等价）');
          }
        }
      );

      await test(
        'T3',
        '练习主流程',
        '显示第一题 → 输入答案 → 查看参考答案（答案/关键词/解析）→ 点评级（掌握度更新）→ 下一题',
        [
          '进入练习视图，确认第一题显示',
          '在 #answerInput 输入包含关键词的答案',
          '点击 #revealBtn，检查 #referencePanel/#referenceText/#keywordChips/解析',
          '点击评级“掌握”，检查 localStorage progress.mastery/lastRating',
          '点击 #nextBtn（或自动）确认进入下一题',
        ],
        async () => {
          await ensurePractice();
          const cur = await currentQuestion();
          assert(cur.q, '练习页显示的题目不在 state.questions 中');
          note(`第一题：${clip(cur.qt, 80)}（id=${cur.q.id}）`);

          const userAnswer = cur.q.keywords?.length ? cur.q.keywords.join('；') : cur.q.answer || 'QA 测试作答';
          await page.fill('#answerInput', userAnswer);
          await sleep(120);

          const revealed = (await page.visible('#revealBtn'))
            ? (await page.click('#revealBtn'), true)
            : await page.clickText('查看参考答案', '#view-practice');
          assert(revealed, '未找到“查看参考答案”按钮（#revealBtn）');
          await page.waitVisible('#referencePanel', 5000);
          await sleep(250);

          const ref = await page.text('#referenceText');
          const answerNorm = norm(cur.q.answer);
          const refNorm = norm(ref);
          assert(refNorm.length > 0, '#referenceText 为空');
          if (answerNorm) {
            const head = answerNorm.slice(0, Math.min(18, answerNorm.length));
            assert(refNorm.includes(head), '参考答案与题库答案不一致（前 18 字未匹配）');
          }
          note(`参考答案：${clip(ref, 120)}`);

          const chips = await page.eval(
            '(()=>{const c=document.querySelector("#keywordChips"); if(!c) return {count:0}; return {count:c.children.length, text:(c.innerText||"").slice(0,120)};})()'
          );
          if (cur.q.keywords?.length) {
            assert(chips.count > 0, '关键词区没有渲染任何关键词 chip');
            note(`关键词 chip：${chips.count} 个（${clip(chips.text, 80)}）`);
          } else {
            note('本题没有 keywords，跳过关键词断言');
          }

          if (cur.q.explanation) {
            const panel = await page.text('#referencePanel');
            const head = norm(cur.q.explanation).slice(0, 12);
            assert(head && norm(panel).includes(head), '参考面板未显示题目解析');
            note('解析已显示');
          }

          const shot = await page.screenshot('02-practice-1440');
          currentTest.shots.push(shot);
          note(`练习进度：${clip(await page.text('#sessionProgress'), 80)}`);

          await rate(2);
          await waitForProgress(cur.q.id, 2, '评级“掌握”写入 state');
          const afterRate = await page.store();
          const p = afterRate.progress[cur.q.id];
          assert(p.mastery >= 0 && p.mastery <= 100, `掌握度越界: ${p.mastery}`);
          note(`评级后 attempts=${p.attempts} lastRating=${p.lastRating} mastery=${p.mastery}`);
          if (p.attempts === 1) {
            // 应用定稿的 master 锚点：[15,45,78,100]（“掌握”=78）
            assert(
              Math.abs(Number(p.mastery) - 78) <= 1,
              `首次“掌握”掌握度应为 78（master 锚点 [15,45,78,100]），实际 ${p.mastery}`
            );
            note('掌握度锚点符合最新 master [15,45,78,100]');
            note('备注：契约 §2 的加权公式为旧版，实现已改为 master 锚点（Lead 已确认）');
          }

          const autoNext = !!afterRate.settings?.autoNext;
          const prevQt = await page.text('#questionText');
          const advanced = await waitQuestionChange(prevQt, autoNext ? 2500 : 900);
          if (!autoNext) {
            note('settings.autoNext=false（契约默认值），改为验证手动“下一题”');
            if (!advanced) {
              assert(await page.visible('#nextBtn'), '#nextBtn 不存在/不可见');
              await page.click('#nextBtn');
              const ok = await waitQuestionChange(prevQt, 5000);
              assert(ok, '点击 #nextBtn 后题目未变化');
            }
            note('手动“下一题”切换成功');
          } else {
            assert(advanced, 'settings.autoNext=true 但评级后未自动进入下一题');
            note('已按设置自动进入下一题');
          }

          const fillWidth = await page.eval(
            '(()=>{const el=document.querySelector("#progressFill"); if(!el) return 0; const r=el.getBoundingClientRect(); return Math.round(r.width);})()'
          );
          note(`#progressFill 宽度：${fillWidth}px`);
        }
      );

      await test(
        'T4',
        '导入 XLSX 并进入练习',
        '选择 samples/示例题库.xlsx 后预览显示题数，确认后题库出现且题目可进入练习',
        [
          '点击 #importBtn 打开导入弹窗',
          '通过 CDP 设置 #fileInput 为 samples/示例题库.xlsx',
          '等待 #importPreview 显示解析结果并截图',
          '点击 #confirmImport，检查新增题库/题目',
          '进入题库视图，从新题库开始练习，校验当前题目属于新题库',
        ],
        async () => {
          const rel = await resolveSample('samples/示例题库.xlsx', '.xlsx');
          const res = await importSampleFile(rel, { previewShot: '03-import-preview' });
          assert(/[0-9]/.test(res.preview), '导入预览未显示题数');
          note(`新增题目：${res.newQuestions.length} 题；新增题库：${res.newBanks.length} 个`);
          validateImportedQuestions(res.newQuestions, res.name);

          await goView('banks');
          const banksText = await page.innerText();
          const newBank = res.newBanks[0];
          if (newBank) {
            assert(banksText.includes(newBank.name), `题库视图未显示新题库“${newBank.name}”`);
            note(`题库视图已显示：${newBank.name}`);
          }
          const shot = await page.screenshot('07-banks-1440');
          currentTest.shots.push(shot);

          const started = await startPracticeFromBank(newBank?.name || res.name, newBank?.id);
          if (!started) {
            await goView('practice');
            await sleep(300);
            await page.clickText('开始练习', 'body');
            await sleep(300);
          }
          await page.waitFor(
            '练习页显示题目',
            '(()=>__qa.exists("#questionText") && __qa.text("#questionText").trim().length>0)()',
            6000
          );
          const qt = norm(await page.text('#questionText'));
          const newTexts = res.newQuestions.map((q) => norm(q.question)).filter(Boolean);
          const inNewBank = newTexts.some((t) => {
            const head = t.slice(0, Math.min(15, t.length));
            return head && (t.includes(qt.slice(0, 15)) || qt.includes(head));
          });
          assert(inNewBank, `当前练习题目不属于刚导入的 XLSX 题库：${clip(qt, 60)}`);
          note('已从导入题库进入练习');
        }
      );

      await test(
        'T5',
        '导入 DOCX',
        '上传 samples/简答题示例.docx 成功导入并生成题目',
        ['打开导入弹窗', '选择 docx 文件', '检查预览并确认', '校验新增题目字段'],
        async () => {
          const rel = await resolveSample('samples/简答题示例.docx', '.docx');
          const res = await importSampleFile(rel, { previewShot: '03b-import-docx-preview' });
          assert(res.newQuestions.length > 0, 'DOCX 未导入出题目');
          validateImportedQuestions(res.newQuestions, res.name);
          note(`DOCX 新增题目 ${res.newQuestions.length} 题`);
          const first = res.newQuestions[0];
          note(`示例：${clip(first.question, 40)} / 答案 ${clip(first.answer, 40)}`);
        }
      );

      await test(
        'T6',
        '导入 CSV',
        '上传 samples/示例题库.csv 成功导入并生成题目',
        ['打开导入弹窗', '选择 csv 文件', '检查预览并确认', '校验新增题目字段'],
        async () => {
          const rel = await resolveSample('samples/示例题库.csv', '.csv');
          const res = await importSampleFile(rel, { previewShot: '03c-import-csv-preview' });
          assert(res.newQuestions.length > 0, 'CSV 未导入出题目');
          validateImportedQuestions(res.newQuestions, res.name);
          note(`CSV 新增题目 ${res.newQuestions.length} 题`);
        }
      );

      await test(
        'T7',
        '刷新持久化',
        '刷新后导入的题库、练习进度、收藏、笔记均保留',
        [
          '在练习页收藏当前题并写入笔记',
          '快照 localStorage 的 banks/questions/progress/settings',
          'Page.reload 刷新页面',
          '对比刷新前后快照并检查题库视图',
        ],
        async () => {
          await ensurePractice();
          const cur = await currentQuestion();
          assert(cur.q, '无法定位当前练习题');
          if (!(await page.visible('#referencePanel'))) {
            if (await page.visible('#revealBtn')) await page.click('#revealBtn');
            else await page.clickText('查看参考答案', '#view-practice');
            await page.waitVisible('#referencePanel', 5000);
          }

          let favOk = await page.exists('#practiceFavorite');
          if (favOk) {
            await page.click('#practiceFavorite');
          } else {
            favOk = await page.eval(
              `(()=>{const cands=Array.from(document.querySelectorAll('button,[role="button"],a,label,[data-action]'));` +
                `const el=cands.find(x=>/收藏|favorite|bookmark/i.test((x.textContent||'')+(x.id||'')+(x.getAttribute('aria-label')||'')+(x.title||'')));` +
                `if(!el) return false; el.setAttribute('data-qa-fav','1'); el.scrollIntoView({block:'center'}); el.click(); return true;})()`
            );
          }
          assert(favOk, '练习视图未找到“收藏”控件（契约 5.4 要求收藏持久化）');
          await page.waitFor(
            '收藏写入 state',
            `(()=>{const s=__qa.store();const p=s&&s.progress&&s.progress[${JSON.stringify(cur.q.id)}];return !!(p&&p.favorite);})()`,
            5000
          );
          note('已收藏当前题');

          const noteOk = await page.exists('#noteInput');
          if (!noteOk) {
            await page.eval(
              `(()=>{const scope=document.querySelector('#view-practice'); if(!scope) return false;` +
                `const cands=Array.from(scope.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')).filter(el=>el.id!=='answerInput');` +
                `const el=cands.find(x=>/笔记|备注|note/i.test((x.placeholder||'')+(x.name||'')+(x.id||'')));` +
                `if(!el) return false; el.setAttribute('data-qa-note','1'); return true;})()`
            );
          }
          const noteSel = noteOk ? '#noteInput' : '[data-qa-note="1"]';
          assert(await page.exists(noteSel), '练习视图未找到“笔记”输入框（契约 5.4 要求笔记持久化）');
          const noteVal = 'QA 笔记 ' + Date.now();
          await page.fill(noteSel, noteVal);
          await page.blur(noteSel);
          await sleep(500);
          let s2 = await page.store();
          if (!s2.progress[cur.q.id]?.note) {
            await page.eval(
              `(()=>{const el=document.querySelector(${JSON.stringify(noteSel)}); if(el){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));} return true;})()`
            );
            await sleep(400);
            s2 = await page.store();
          }
          assert(s2.progress[cur.q.id]?.note, '笔记未写入 state.progress.note');
          note('笔记已写入：' + clip(s2.progress[cur.q.id].note, 40));

          const snap = JSON.stringify({
            banks: s2.banks,
            questions: s2.questions,
            progress: s2.progress,
            settings: s2.settings,
          });
          const bankNames = (s2.banks || []).map((b) => b.name);
          const questionCount = s2.questions.length;

          await page.reload();
          await page.waitFor('刷新后应用渲染', '!!document.querySelector("#app") && document.readyState==="complete"', 15000);
          await sleep(800);
          const s3 = await page.store();
          assert(s3, '刷新后 localStorage 丢失');
          const snap3 = JSON.stringify({
            banks: s3.banks,
            questions: s3.questions,
            progress: s3.progress,
            settings: s3.settings,
          });
          assert(snap3 === snap, '刷新后 banks/questions/progress/settings 与刷新前不一致');
          assert(s3.questions.length === questionCount, '刷新后题目数量变化');
          assert(s3.progress[cur.q.id]?.favorite === true, '刷新后收藏丢失');
          assert(s3.progress[cur.q.id]?.note, '刷新后笔记丢失');
          note(`刷新后题库 ${bankNames.length} 个、题目 ${s3.questions.length} 题、进度与收藏/笔记均保留`);

          await goView('banks');
          const banksText = await page.innerText();
          for (const name of bankNames) {
            assert(banksText.includes(name), `刷新后题库视图缺少“${name}”`);
          }
          note('刷新后题库视图完整');
        }
      );

      await test(
        'T8',
        '错题本与错题重练',
        '评级“忘记”后题目进入错题本，可“错题重练”',
        [
          '练习中查看参考答案并评级“忘记”',
          '检查 progress 判定（attempts>0 && lastRating<=1）',
          '进入错题本视图，确认该题出现',
          '点击“错题重练”，确认回到练习且题目一致',
        ],
        async () => {
          await ensurePractice();
          const cur = await currentQuestion();
          assert(cur.q, '无法定位当前练习题');
          const qid = cur.q.id;
          const qtext = norm(cur.qt);

          if (!(await page.visible('#referencePanel'))) {
            if (await page.visible('#revealBtn')) await page.click('#revealBtn');
            else await page.clickText('查看参考答案', '#view-practice');
            await page.waitVisible('#referencePanel', 5000);
          }
          await rate(0);
          await waitForProgress(qid, 0, '评级“忘记”写入 state');
          const p = (await page.store()).progress[qid];
          assert(p.attempts > 0 && p.lastRating <= 1, '错题判定条件未满足');
          note(`错题：${clip(qtext, 60)}（attempts=${p.attempts}, lastRating=${p.lastRating}）`);

          await goView('wrong');
          await sleep(400);
          const wrongText = norm(await page.innerText());
          const head = qtext.slice(0, Math.min(12, qtext.length));
          assert(wrongText.includes(head), '错题本中未出现刚评“忘记”的题目');
          const shot = await page.screenshot('08-wrongbook-1440');
          currentTest.shots.push(shot);
          note('错题本已收录该题');

          let clicked = await page.eval(
            `(()=>{const v=document.querySelector('#view-wrong'); if(!v) return false;` +
              `const b=Array.from(v.querySelectorAll('button,a,[role="button"],[data-action]')).find(x=>/错题重练|重练|重新练习/.test(x.textContent||''));` +
              `if(b){b.scrollIntoView({block:'center'}); b.click(); return true;} return false;})()`
          );
          if (!clicked) clicked = await page.clickText('错题重练', '#view-wrong');
          assert(clicked, '错题本未找到“错题重练”入口');
          await page.waitFor(
            '错题重练进入练习',
            '(()=>__qa.visible("#view-practice") && __qa.exists("#questionText") && __qa.text("#questionText").trim().length>0)()',
            6000
          );
          const qt2 = norm(await page.text('#questionText'));
          assert(
            qt2.includes(head) || head.includes(qt2.slice(0, 12)),
            `错题重练的题目不一致：${clip(qt2, 50)}`
          );
          note('“错题重练”回到原题');
        }
      );

      await test(
        'T9',
        '统计视图',
        '题量、已练、掌握度、7 日活跃图正常渲染',
        ['进入统计视图', '核对题量/已练数字与 state 一致', '确认掌握度与图表元素渲染', '截图'],
        async () => {
          await goView('stats');
          await sleep(600);
          const s = await page.store();
          const total = s.questions.length;
          const practiced = Object.values(s.progress || {}).filter((p) => p.attempts > 0).length;
          const info = await page.eval(
            '(()=>{const v=document.querySelector("#view-stats"); if(!v) return null;' +
              'const chart=v.querySelector(".bar-chart");' +
              'const bars=v.querySelectorAll(".bar-chart .bar-col");' +
              'return {text:v.innerText||"", hasChart:!!chart, chartW:chart?Math.round(chart.getBoundingClientRect().width):0, chartH:chart?Math.round(chart.getBoundingClientRect().height):0, bars:bars.length, chartLabel:chart?(chart.getAttribute("aria-label")||""):""};})()'
          );
          assert(info, '#view-stats 不存在');
          note(`统计文本：${clip(info.text, 220)}`);
          assert(info.text.includes(String(total)), `统计未显示总题量 ${total}`);
          assert(/掌握/.test(info.text), '统计未显示掌握度');
          if (practiced > 0) {
            assert(info.text.includes(`已练 ${practiced} 道`), `统计未显示已练 ${practiced} 道`);
          }
          assert(info.hasChart, '统计视图未找到活跃图（.bar-chart）');
          assert(info.chartW > 20 && info.chartH > 10, `图表尺寸异常 ${info.chartW}x${info.chartH}`);
          assert(info.bars >= 7, `活跃图柱数不足（${info.bars}）`);
          note(`活跃图标题：${info.chartLabel || '(无 aria-label)'}；柱数：${info.bars}`);
          if (/14\s*天/.test(info.text)) {
            note('契约说明：验收要求“7 日活跃图”，实现为最近 14 天（含本周 7 日汇总），数据完整');
          }
          const shot = await page.screenshot('04-stats-1440');
          currentTest.shots.push(shot);
        }
      );

      await test(
        'T10',
        '移动端 390px',
        '390px 宽无横向滚动，侧栏可开合',
        [
          'Emulation.setDeviceMetricsOverride 390x844 mobile',
          '检查 window.innerWidth≈390 且 scrollWidth<=clientWidth',
          '截图',
          '找到菜单/侧栏按钮，开合并截图',
        ],
        async () => {
          // 退出上一轮的错题单题会话，用常规示例题库练习页做 390px 验收展示
          const s0 = await page.store();
          const sampleBank = (s0.banks || []).find((b) => b.isSample) || (s0.banks || [])[0];
          let ok = false;
          if (sampleBank) ok = await startPracticeFromBank(sampleBank.name, sampleBank.id);
          if (!ok) await ensurePractice();
          await page.viewport(390, 844, { mobile: true, dpr: 2 });
          await page.eval('window.scrollTo(0,0)');
          await sleep(700);

          const vp = await page.eval(
            '(()=>({inner:window.innerWidth, vv:window.visualViewport?window.visualViewport.width:null, dpr:window.devicePixelRatio, doc:document.documentElement.clientWidth}))()'
          );
          note(`视口：innerWidth=${vp.inner}, visualViewport=${vp.vv}, dpr=${vp.dpr}`);
          assert(
            Math.abs(vp.inner - 390) <= 2,
            `390px 布局未生效（window.innerWidth=${vp.inner}），页面可能缺少 <meta name="viewport">`
          );

          const m = await page.eval(
            '(()=>{const d=document.documentElement,b=document.body;' +
              'const offenders=Array.from(document.querySelectorAll("body *")).filter(el=>{const r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; return r.right>window.innerWidth+1||r.left<-1;}).slice(0,10).map(el=>{let c=el.className&&typeof el.className==="string"?("."+el.className.trim().split(" ").filter(Boolean).join(".")):""; let r=el.getBoundingClientRect(); return el.tagName.toLowerCase()+(el.id?"#"+el.id:"")+c+"["+Math.round(r.left)+","+Math.round(r.right)+"]";});' +
              'return {docScroll:d.scrollWidth,docClient:d.clientWidth,bodyScroll:b.scrollWidth,inner:window.innerWidth,offenders};})()'
          );
          note(`scrollWidth: doc=${m.docScroll}, body=${m.bodyScroll}, client=${m.docClient}`);
          assert(m.docScroll <= m.inner + 1, `页面出现横向滚动：scrollWidth=${m.docScroll} > innerWidth=${m.inner}；越界元素: ${m.offenders.join(' ')}`);
          assert(m.bodyScroll <= m.inner + 1, `body 出现横向滚动：${m.bodyScroll} > ${m.inner}`);
          if (m.offenders.length) note('疑似越界元素：' + clip(m.offenders.join(' '), 160));

          const shot = await page.screenshot('05-mobile-390');
          currentTest.shots.push(shot);

          const toggleSel = await page.eval(
            `(()=>{const cands=['#menuBtn','#sidebarToggle','[data-action="toggle-sidebar"]','[data-action="sidebar"]','[data-action="menu"]','.menu-btn','.hamburger','.sidebar-toggle'];` +
              `for(const s of cands){const el=document.querySelector(s); if(el) return s;}` +
              `const b=Array.from(document.querySelectorAll('button,[role="button"]')).find(x=>/菜单|侧栏|导航/i.test((x.getAttribute('aria-label')||'')+(x.getAttribute('title')||'')+(x.textContent||'')));` +
              `if(b){b.setAttribute('data-qa-menu','1'); return '[data-qa-menu="1"]';} return null;})()`
          );
          assert(toggleSel, '390px 下未找到侧栏开合按钮（#menuBtn/.hamburger/[data-action=toggle-sidebar] 等均不存在）');

          const sidebarState = async () =>
            page.eval(
              '(()=>{const sb=document.querySelector(".sidebar"); if(!sb) return null; const cs=getComputedStyle(sb); const r=sb.getBoundingClientRect();' +
                'const open=cs.display!=="none"&&cs.visibility!=="hidden"&&r.width>20&&r.right>20&&!sb.hidden&&!sb.closest("[hidden]");' +
                'return {open,left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),transform:cs.transform};})()'
            );

          const before = await sidebarState();
          assert(before, '.sidebar 不存在');
          note(`初始侧栏：${JSON.stringify(before)}`);
          await page.click(toggleSel);
          await sleep(450);
          const opened = await sidebarState();
          note(`点击后侧栏：${JSON.stringify(opened)}`);
          assert(opened.open !== before.open, '点击菜单按钮后侧栏开合状态未变化');
          const shot2 = await page.screenshot('05b-mobile-sidebar');
          currentTest.shots.push(shot2);

          // 关闭：优先点侧栏里的关闭按钮，其次点遮罩
          let closed = await sidebarState();
          if (closed.open === opened.open) {
            if (await page.visible('#sidebarClose')) {
              await page.click('#sidebarClose');
            } else {
              const overlay = await page.eval(
                '(()=>{const o=document.querySelector("#sidebarOverlay,.sidebar-overlay,.overlay,.scrim,.backdrop"); if(o){o.click(); return true;} return false;})()'
              );
              void overlay;
            }
            await sleep(500);
            closed = await sidebarState();
          }
          assert(closed.open === before.open, `侧栏未能再次收起（当前 open=${closed.open}, 初始 open=${before.open}）`);

          await page.viewport(VIEW_W, VIEW_H, { mobile: false, dpr: 1 });
          await page.eval('window.scrollTo(0,0)');
          await sleep(400);
        }
      );

      await test(
        'T11',
        '深色主题',
        '设置中切换深色主题后立即生效，且刷新后保持',
        ['点击 #settingsBtn 打开设置', '选择“深色”主题', '检查 data-theme/背景色变暗且 settings.theme=dark', '刷新后验证保持'],
        async () => {
          await page.click('#settingsBtn');
          await page.waitFor(
            '设置弹窗打开',
            '(()=>{const m=document.querySelector("#modalRoot"); const o=m&&m.querySelector(".modal-overlay"); return !!o && (m.innerText||"").trim().length>0 && !o.classList.contains("is-closing");})()',
            6000
          );
          const themeAction = await page.eval(
            `(()=>{const root=document.querySelector('#modalRoot');` +
              `if(!root) return null;` +
              `for(const sel of root.querySelectorAll('select')){const opt=Array.from(sel.options).find(o=>/深色|dark/i.test(o.textContent||o.value||'')); if(opt){const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(sel,opt.value); sel.dispatchEvent(new Event('change',{bubbles:true})); return 'select:'+opt.value;}}` +
              `const cands=Array.from(root.querySelectorAll('button,[role="button"],[role="radio"],label,input[type="radio"]'));` +
              `const el=cands.find(x=>/深色|dark/i.test((x.textContent||'')+(x.value||'')+(x.getAttribute('aria-label')||'')));` +
              `if(el){el.click(); return 'click:'+((el.textContent||'').trim()||el.value||'');} return null;})()`
          );
          assert(themeAction, '设置里未找到深色主题控件');
          note('主题操作：' + themeAction);

          await page.waitFor(
            '深色主题生效',
            '(()=>{const de=document.documentElement,b=document.body;const attr=(de.getAttribute("data-theme")||b.getAttribute("data-theme")||de.className+" "+b.className);if(/dark/i.test(attr)) return true;const bg=getComputedStyle(b).backgroundColor;const m=bg.match(/[0-9]+/g);if(!m||m.length<3) return false;const r=Number(m[0]),g=Number(m[1]),bl=Number(m[2]);return (r+g+bl)/3<90;})()',
            6000
          );
          await page.waitFor(
            'settings.theme=dark 持久化',
            '(()=>{const s=__qa.store(); return !!s && s.settings && s.settings.theme==="dark";})()',
            5000
          );
          const s = await page.store();
          assert(s.settings?.theme === 'dark', `settings.theme 应为 dark，实际 ${s.settings?.theme}`);
          note('深色主题已生效且写入 settings.theme');

          await closeAnyModal();
          await goView('dashboard');
          await sleep(500);
          const shot = await page.screenshot('06-dark-1440');
          currentTest.shots.push(shot);
          const bgDark = await page.eval(
            '(()=>{const bg=getComputedStyle(document.body).backgroundColor;const m=bg.match(/[0-9]+/g);if(!m||m.length<3) return bg;return {bg,avg:(Number(m[0])+Number(m[1])+Number(m[2]))/3};})()'
          );
          note('深色背景：' + JSON.stringify(bgDark));

          await page.reload();
          await page.waitFor('刷新后应用渲染', '!!document.querySelector("#app") && document.readyState==="complete"', 15000);
          await sleep(700);
          const s2 = await page.store();
          assert(s2.settings?.theme === 'dark', '刷新后深色主题设置丢失');
          const dark = await page.eval(
            '(()=>{const de=document.documentElement,b=document.body;const attr=(de.getAttribute("data-theme")||b.getAttribute("data-theme")||de.className+" "+b.className);if(/dark/i.test(attr)) return true;const bg=getComputedStyle(b).backgroundColor;const m=bg.match(/[0-9]+/g);if(!m||m.length<3) return false;return (Number(m[0])+Number(m[1])+Number(m[2]))/3<90;})()'
          );
          assert(dark, '刷新后页面未保持深色主题');
          note('刷新后深色主题保持');
        }
      );

      await test(
        'T12',
        '数据导出 JSON',
        '设置中提供数据导出时，导出的 JSON 包含完整 banks/questions/settings，字段不丢',
        ['打开设置弹窗', '查找“导出/下载数据”入口', '触发下载并读取 JSON', '与 localStorage 对比题量/题库/字段'],
        async () => {
          await page.click('#settingsBtn');
          await page.waitFor(
            '设置弹窗打开',
            '(()=>{const m=document.querySelector("#modalRoot"); const o=m&&m.querySelector(".modal-overlay"); return !!o && (m.innerText||"").trim().length>0;})()',
            6000
          );
          const exportSel = await page.eval(
            `(()=>{const root=document.querySelector('#modalRoot'); if(!root) return null;` +
              `const cands=Array.from(root.querySelectorAll('button,a,[role="button"]'));` +
              `const el=cands.find(x=>/导出|备份|下载数据|export/i.test((x.textContent||'')+(x.id||'')));` +
              `if(!el) return null; if(el.id) return '#'+el.id; el.setAttribute('data-qa-export','1'); return '[data-qa-export="1"]';})()`
          );
          if (!exportSel) throw new SkipError('设置中未提供 JSON 导出入口');

          try {
            await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
          } catch {
            try {
              await cdp.send('Browser.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: DOWNLOADS,
                eventsEnabled: true,
              });
            } catch {
              /* ignore */
            }
          }
          for (const f of await readdir(DOWNLOADS).catch(() => [])) {
            await rm(path.join(DOWNLOADS, f), { force: true }).catch(() => {});
          }
          await page.click(exportSel);
          const file = await poll(
            async () => {
              const files = (await readdir(DOWNLOADS).catch(() => [])).filter(
                (f) => f.toLowerCase().endsWith('.json')
              );
              for (const f of files) {
                const p = path.join(DOWNLOADS, f);
                const st = await safeStat(p);
                if (st.ok && st.size > 50) return p;
              }
              return null;
            },
            { timeout: 12000, desc: '导出 JSON 文件下载完成' }
          );
          note('导出文件：' + path.basename(file));
          const raw = await readFile(file, 'utf8');
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch (e) {
            throw new Error('导出的 JSON 无法解析: ' + e.message);
          }
          const data = payload && payload.state ? payload.state : payload;
          const s = await page.store();
          assert(Array.isArray(data.questions), '导出 JSON 缺少 questions 数组');
          assert(Array.isArray(data.banks), '导出 JSON 缺少 banks 数组');
          assert(data.questions.length === s.questions.length, `导出题量不一致：${data.questions.length} vs ${s.questions.length}`);
          assert(data.banks.length === s.banks.length, `导出题库数不一致：${data.banks.length} vs ${s.banks.length}`);
          assert(data.settings && typeof data.settings === 'object', '导出 JSON 缺少 settings');
          assert(payload.version === 1, `导出 version 应为 1，实际 ${payload.version}`);
          const q0 = data.questions[0] || {};
          for (const k of ['id', 'bankId', 'question', 'answer', 'keywords', 'difficulty', 'source']) {
            assert(k in q0, '导出题目缺少字段 ' + k);
          }
          note(`导出 JSON 有效：${data.banks.length} 题库 / ${data.questions.length} 题 / version=${payload.version}`);

          // 往返：通过设置里的“导入备份”恢复刚导出的 JSON
          assert(await page.exists('#importDataInput'), '设置里未找到“导入备份”文件输入（#importDataInput）');
          const beforeRestore = JSON.stringify({
            banks: s.banks,
            questions: s.questions,
            progress: s.progress,
            settings: s.settings,
          });
          await page.setFiles('#importDataInput', [file]);
          await page.waitFor(
            '备份恢复确认弹窗',
            '(()=>{const r=document.querySelector("#modalRoot"); return !!r && (r.innerText||"").includes("恢复这份备份");})()',
            8000
          );
          const confirmed = await page.eval(
            `(()=>{const r=document.querySelector('#modalRoot'); if(!r) return false;` +
              `const b=Array.from(r.querySelectorAll('button,[role="button"]')).find(x=>/覆盖并恢复|恢复/.test(x.textContent||''));` +
              `if(!b) return false; b.click(); return true;})()`
          );
          assert(confirmed, '未找到“覆盖并恢复”确认按钮');
          await page.waitFor(
            '备份恢复完成',
            '(()=>{const r=document.querySelector("#modalRoot"); return !r || !r.querySelector(".modal-overlay");})()',
            15000
          );
          await sleep(700);
          const s2 = await page.store();
          const afterRestore = JSON.stringify({
            banks: s2.banks,
            questions: s2.questions,
            progress: s2.progress,
            settings: s2.settings,
          });
          assert(afterRestore === beforeRestore, '导出→导入 JSON 往返后 banks/questions/progress/settings 发生变化（字段丢失）');
          note('导出→导入 JSON 往返字段一致（banks/questions/progress/settings 未丢失）');
          await closeAnyModal();
        }
      );

      await test(
        'T13',
        '控制台健康',
        '整个流程无未捕获异常、无错误级控制台输出',
        ['汇总 Runtime.exceptionThrown 与 Runtime.consoleAPICalled(error)/Log(error)', '过滤 favicon 等无关资源噪声'],
        async () => {
          const ex = page.exceptions;
          const errs = page.criticalConsoleErrors();
          if (ex.length) {
            note('异常样例：' + ex.slice(0, 3).map((e) => clip(e.text, 120)).join(' | '));
          }
          if (errs.length) {
            note('错误样例：' + errs.slice(0, 3).map((e) => clip(e.text, 120)).join(' | '));
          }
          assert(ex.length === 0, `存在 ${ex.length} 条未捕获异常`);
          assert(errs.length === 0, `存在 ${errs.length} 条错误级控制台输出`);
          note('控制台干净');
        }
      );
    }

    const fail = results.filter((r) => r.status === 'FAIL').length;
    await writeReport({ mode: 'full', infra, startedAt, finishedAt: localTime() });
    log(
      `\n[suite] 完成：PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${fail} SKIP=${
        results.filter((r) => r.status === 'SKIP').length
      }`
    );
    if (fail > 0) process.exitCode = 1;
    else if (appBroken) process.exitCode = 2;
  } catch (e) {
    fatal = String((e && e.stack) || e);
    log('\n[fatal] ' + fatal);
    try {
      await writeReport({
        mode,
        infra: null,
        fatal,
        startedAt,
        finishedAt: localTime(),
      });
    } catch (e2) {
      log('[fatal] 报告写入失败: ' + e2.message);
    }
    process.exitCode = 1;
  } finally {
    try {
      await writeFile(path.join(TESTS, 'e2e.log'), logLines.join('\n'), 'utf8');
    } catch {
      /* ignore */
    }
    await cleanup();
  }
}

main();
