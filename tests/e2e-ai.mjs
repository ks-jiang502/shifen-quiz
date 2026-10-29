#!/usr/bin/env node
/**
 * 拾分 · AI 功能零依赖 E2E（Chrome CDP + Node 原生 WebSocket + mock AI）
 *
 * 用法：node tests/e2e-ai.mjs
 *
 * 前置：静态服务 http://127.0.0.1:8765/、共享 headless Chrome CDP 9222、
 *       mock AI http://127.0.0.1:18765（tests/mock-ai-server.mjs）。
 *
 * 输出：tests/report-ai.md、tests/screenshots-ai/*.png。
 * 只操作自己新建的 Chrome target；不改产品文件。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TESTS = __dirname;
const SHOTS = path.join(TESTS, 'screenshots-ai');
const TMP = path.join(TESTS, '.tmp-ai');
const DOWNLOADS = path.join(TMP, 'downloads');
const INDEX_HTML = path.join(ROOT, 'index.html');
const AI_JS = path.join(ROOT, 'js', 'ai.js');
const MOCK_SERVER = path.join(TESTS, 'mock-ai-server.mjs');
const FIXTURE = path.join(TESTS, 'fixtures', 'selftest.html');

const PYTHON = String.raw`C:\Users\20306\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`;
const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 8765;
const CDP_PORT = 9222;
const SHARED_CDP = process.env.SHIFEN_CDP || 'http://127.0.0.1:9222';
const MOCK_ORIGIN = 'http://127.0.0.1:18765';
const MOCK_V1 = MOCK_ORIGIN + '/v1';
const APP_URL = `http://127.0.0.1:${PORT}/index.html`;
const FIXTURE_URL = `http://127.0.0.1:${PORT}/tests/fixtures/selftest.html`;
const ROOT_URL = `http://127.0.0.1:${PORT}/`;
const VIEW_W = 1440;
const VIEW_H = 900;
const AI_KEY = 'test';

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
/* 工具                                                               */
/* ------------------------------------------------------------------ */

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').trim();
}
function clip(s, n = 220) {
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
async function portOpen(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(true));
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
async function fetchJson(url, timeout = 3000, init) {
  const res = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(timeout) });
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
  throw new Error(`等待超时（${timeout}ms）：${desc}${lastErr ? ' / ' + lastErr.message : ''}`);
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
/* CDP                                                                */
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
      for (const p of this.pending.values()) p.reject(new Error('CDP 已关闭'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {});
  }
  static async connect(url, timeout = 10000) {
    const ws = new WebSocket(url);
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('无法连接 CDP: ' + url)), { once: true });
      }),
      sleep(timeout).then(() => {
        throw new Error('CDP 连接超时: ' + url);
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
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      for (const cb of [...(this.listeners.get(msg.method) || [])]) {
        try {
          cb(msg.params || {});
        } catch {
          /* ignore */
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
    if (this.closed) return Promise.reject(new Error('CDP 已关闭: ' + method));
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
/* 页面 helper（每次导航后注入）                                        */
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
    function n(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
    var needle = n(txt);
    var cands = Array.prototype.slice.call(root.querySelectorAll('button,a,[role="button"],label,[data-action]'));
    var el = cands.find(function (x) { return n(x.textContent).indexOf(needle) >= 0; });
    if (!el) el = cands.find(function (x) { return n(x.getAttribute('aria-label') || x.title || '').indexOf(needle) >= 0; });
    if (!el) return false;
    el.click();
    return true;
  },
  fill: function (sel, value) {
    var el = document.querySelector(sel);
    if (!el) throw new Error('输入框不存在: ' + sel);
    var proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  },
  setSelect: function (sel, value) {
    var el = document.querySelector(sel);
    if (!el) throw new Error('下拉框不存在: ' + sel);
    var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  },
  store: function () {
    try { var s = localStorage.getItem('shifen.v1'); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  },
  bodyText: function () { return document.body ? document.body.innerText : ''; },
  modals: function () { return document.querySelectorAll('#modalRoot .modal-overlay').length; },
  scroll: function (sel) {
    var el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }
};
if (!window.__qaFetchPatched) {
  window.__qaFetchPatched = true;
  window.__qaMock401 = false;
  var __qaOrigFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (window.__qaMock401 && url.indexOf('127.0.0.1:18765') >= 0) {
      var headers = new Headers(init.headers || {});
      headers.set('x-mock-status', '401');
      init = Object.assign({}, init, { headers: headers });
    }
    return __qaOrigFetch(input, init);
  };
}
`;

/* ------------------------------------------------------------------ */
/* PageSession                                                        */
/* ------------------------------------------------------------------ */

class PageSession {
  constructor(cdp) {
    this.cdp = cdp;
    this.exceptions = [];
    this.consoleEntries = [];
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
      /* ignore */
    }
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ''))
        .join(' ');
      this.consoleEntries.push({ kind: p.type, text, at: stamp() });
    });
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const ex = d.exception || {};
      this.exceptions.push({ text: d.text || ex.description || 'exception', description: ex.description || '', url: d.url || '', at: stamp() });
    });
    this.cdp.on('Log.entryAdded', (p) => {
      const e = p.entry || {};
      this.consoleEntries.push({ kind: 'log-' + (e.level || 'info'), text: e.text || '', url: e.url || '', at: stamp() });
    });
    this.cdp.on('Page.javascriptDialogOpening', async () => {
      try {
        await this.cdp.send('Page.handleJavaScriptDialog', { accept: true });
      } catch {
        /* ignore */
      }
    });
    await this.viewport(VIEW_W, VIEW_H);
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
      const msg = (d.exception && d.exception.description) || d.text || '页面脚本异常';
      throw new Error('Runtime.evaluate 异常: ' + clip(msg, 300) + ' | expr=' + clip(expr, 100));
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
    await sleep(250);
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
    await sleep(120);
  }
  async waitFor(desc, expr, timeout = 8000) {
    return poll(() => this.eval(expr), { timeout, desc });
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
  async setSelect(sel, value) {
    return this.eval(`__qa.setSelect(${JSON.stringify(sel)},${JSON.stringify(String(value))})`);
  }
  async store() {
    return this.eval('__qa.store()');
  }
  async screenshot(name) {
    const res = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await mkdir(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name.endsWith('.png') ? name : name + '.png');
    await writeFile(file, Buffer.from(res.data, 'base64'));
    return 'screenshots-ai/' + path.basename(file);
  }
  async setFiles(selector, files) {
    const doc = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: false });
    const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!nodeId) throw new Error('文件输入框不存在: ' + selector);
    await this.cdp.send('DOM.setFileInputFiles', { files, nodeId });
  }
  async pressEscape() {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  criticalConsoleErrors() {
    return this.consoleEntries.filter((e) => {
      const text = `${e.text} ${e.url || ''}`;
      if (/favicon\.ico/i.test(text)) return false;
      // 401 用例会故意产生一条浏览器资源 401 日志，属于测试预期
      if (/401/.test(text) && /18765|Unauthorized/i.test(text)) return false;
      return e.kind === 'error' || e.kind === 'log-error';
    });
  }
}

/* ------------------------------------------------------------------ */
/* 全局状态                                                           */
/* ------------------------------------------------------------------ */

let serverProc = null;
let serverReused = false;
let sharedTargetId = null;
let cdp = null;
let page = null;
let chromeInfo = null;

/* ------------------------------------------------------------------ */
/* 基础设施                                                           */
/* ------------------------------------------------------------------ */

async function ensureStaticServer() {
  try {
    const res = await fetch(ROOT_URL + 'docs/ai-contract.md', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const text = await res.text();
      if (text.includes('拾分') && text.includes('AI')) {
        serverReused = true;
        log(`[infra] 复用静态服务 http://127.0.0.1:${PORT}/`);
        return;
      }
    }
  } catch {
    /* 继续 */
  }
  if (await portOpen(PORT)) throw new Error(`端口 ${PORT} 被占用且不是本项目静态服务`);
  serverProc = spawn(PYTHON, ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore', windowsHide: true });
  await poll(
    async () => {
      const res = await fetch(ROOT_URL + 'docs/ai-contract.md', { signal: AbortSignal.timeout(1000) });
      return res.ok;
    },
    { timeout: 12000, desc: '静态服务可访问' }
  );
  log('[infra] 已启动静态服务');
}

async function verifyMock() {
  const res = await fetch(MOCK_V1 + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_KEY },
    body: JSON.stringify({
      model: 'mock-model',
      messages: [
        { role: 'system', content: '[TASK:PING]' },
        { role: 'user', content: 'ping' },
      ],
      temperature: 0.3,
      max_tokens: 8,
      stream: false,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('mock AI PING HTTP ' + res.status);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  if (String(content).trim() !== 'OK') throw new Error('mock AI PING 返回异常: ' + clip(content, 80));
  log('[infra] mock AI PING 正常（' + MOCK_ORIGIN + '）');
}

async function connectSharedChrome() {
  const version = await fetchJson(SHARED_CDP + '/json/version', 3000);
  if (!version || !version.webSocketDebuggerUrl) throw new Error('共享 Chrome CDP 不可用');
  chromeInfo = {
    exe: 'shared-cdp',
    port: Number(new URL(SHARED_CDP).port || CDP_PORT),
    version: version['Browser'] || 'unknown',
    protocol: version['Protocol-Version'] || 'unknown',
  };
  const res = await fetch(`${SHARED_CDP}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('PUT /json/new 失败: HTTP ' + res.status);
  const target = await res.json();
  if (!target?.webSocketDebuggerUrl) throw new Error('共享 Chrome 未返回页面 target');
  sharedTargetId = target.id;
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  page = new PageSession(cdp);
  await page.init();
  log(`[infra] 复用共享 Chrome: ${chromeInfo.version}，新建 target ${target.id}`);
}

async function closeSharedTarget() {
  if (!sharedTargetId) return;
  try {
    await fetch(`${SHARED_CDP}/json/close/${sharedTargetId}`, { signal: AbortSignal.timeout(3000) });
    log('[infra] 已关闭自己的 target: ' + sharedTargetId);
  } catch {
    /* ignore */
  }
  sharedTargetId = null;
}

async function cleanup() {
  try {
    cdp?.close();
  } catch {
    /* ignore */
  }
  await closeSharedTarget();
  if (serverProc) killTree(serverProc.pid);
  try {
    await rm(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 测试记录                                                           */
/* ------------------------------------------------------------------ */

class SkipError extends Error {}

const results = [];
let currentTest = null;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function note(msg) {
  if (currentTest) currentTest.evidence.push(msg);
  log('  · ' + msg);
}
async function test(id, title, expect, steps, fn) {
  const r = { id, title, expect, steps, status: 'PASS', evidence: [], shots: [], error: null, duration: 0 };
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
        r.shots.push(await page.screenshot('fail-' + id));
      } catch {
        /* ignore */
      }
      try {
        const info = await page.eval('(()=>({url:location.href,text:(document.body&&document.body.innerText||"").slice(0,260)}))()');
        r.evidence.push('失败时页面: ' + clip(info.url, 120));
        r.evidence.push('失败时文本: ' + clip(info.text, 220));
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
/* 页面业务辅助                                                       */
/* ------------------------------------------------------------------ */

async function waitModalText(text, timeout = 8000) {
  await page.waitFor(
    '弹窗包含 ' + text,
    `(()=>Array.from(document.querySelectorAll('#modalRoot .modal-overlay')).some(o=>((o.innerText||'').includes(${JSON.stringify(text)}))))()`,
    timeout
  );
}
async function closeAllModals() {
  for (let i = 0; i < 4; i += 1) {
    const n = Number(await page.eval('__qa.modals()'));
    if (!n) return;
    const clicked = await page.eval(
      `(()=>{const os=Array.from(document.querySelectorAll('#modalRoot .modal-overlay')); if(!os.length) return false;` +
        `const o=os[os.length-1]; const b=o.querySelector('.modal-head [data-close]')||o.querySelector('[data-close]');` +
        `if(b){b.click(); return true;} return false;})()`
    );
    if (!clicked) await page.pressEscape();
    await sleep(280);
  }
}
async function goView(view) {
  const selector = `nav.nav [data-view="${view}"],[data-view="${view}"]`;
  const ok = await page.eval(
    `(()=>{const b=document.querySelector(${JSON.stringify(selector)}); if(!b) return false; b.click(); return true;})()`
  );
  assert(ok, '找不到导航项 ' + view);
  await sleep(300);
}
async function ensurePractice() {
  await goView('practice');
  await page.waitFor(
    '练习题目出现',
    '(()=>__qa.exists("#questionText") && __qa.text("#questionText").trim().length>0)()',
    8000
  );
}
async function startPracticeFromBank(bankName, bankId) {
  await goView('banks');
  await sleep(350);
  const ok = await page.eval(
    `(()=>{const scope=document.querySelector('#view-banks'); if(!scope) return false;` +
      `const id=${JSON.stringify(bankId || '')}; const name=${JSON.stringify(bankName || '')};` +
      `let btn=null; if(id) btn=scope.querySelector('[data-action="start-bank"][data-bank-id="'+id+'"]');` +
      `if(!btn&&name){const cards=Array.from(scope.querySelectorAll('.bank-card,.card,[data-bank-id],li,article')); const card=cards.find(c=>(c.textContent||'').includes(name)); if(card) btn=card.querySelector('[data-action="start-bank"]');}` +
      `if(!btn) btn=Array.from(scope.querySelectorAll('[data-action="start-bank"]'))[0];` +
      `if(!btn) return false; btn.scrollIntoView({block:'center'}); btn.click(); return true;})()`
  );
  if (!ok) return false;
  await sleep(450);
  try {
    await page.waitFor(
      '从题库进入练习',
      '(()=>__qa.visible("#view-practice") && __qa.exists("#questionText") && __qa.text("#questionText").trim().length>0)()',
      8000
    );
  } catch {
    return false;
  }
  return true;
}
async function currentQid() {
  return String((await page.eval('document.querySelector("#questionCard")?.dataset.questionId || ""')) || '');
}
async function openImportModal() {
  await page.click('#importBtn');
  await waitModalText('导入题库');
}
async function selectImportTab(tab) {
  await page.click(`[data-import-tab="${tab}"]`);
  await sleep(250);
}
async function pasteAndParse(text, format) {
  await page.fill('#pasteInput', text);
  await page.setSelect('#pasteFormat', format);
  await page.click('#parsePasteBtn');
  await page.waitFor(
    '粘贴内容解析完成',
    '(()=>{const b=document.querySelector("#confirmImport"); return !!b && !b.disabled;})()',
    15000
  );
}
async function confirmImportWaiting(minDelta = 1) {
  const before = await page.store();
  await page.click('#confirmImport');
  await page.waitFor(
    '导入写入 localStorage',
    `(()=>{const s=__qa.store(); return !!s && s.questions.length >= ${before.questions.length + minDelta};})()`,
    20000
  );
  await sleep(600);
  const after = await page.store();
  const beforeIds = new Set(before.questions.map((q) => q.id));
  const newQuestions = after.questions.filter((q) => !beforeIds.has(q.id));
  const newBanks = after.banks.filter((b) => !before.banks.some((x) => x.id === b.id));
  return { before, after, newQuestions, newBanks };
}
async function screenshotScrolled(name, selector) {
  const ok = await page.eval(`__qa.scroll(${JSON.stringify(selector)})`);
  if (!ok) throw new Error('截图目标不存在: ' + selector);
  await sleep(350);
  const shot = await page.screenshot(name);
  if (currentTest) currentTest.shots.push(shot);
  return shot;
}
async function revealReference() {
  if (await page.visible('#referencePanel')) return;
  assert(await page.visible('#revealBtn'), '#revealBtn 不可见');
  await page.click('#revealBtn');
  await page.waitFor('参考答案展开', '__qa.visible("#referencePanel")', 6000);
  await sleep(200);
}
async function configureAIViaUI() {
  await page.click('#settingsBtn');
  await waitModalText('AI 服务');
  await page.waitFor('设置弹窗打开', '!!document.querySelector("#openAiSettingsBtn")', 6000);
  await page.eval('document.querySelector("#openAiSettingsBtn").click()');
  await waitModalText('AI 服务设置');
  await page.waitFor('AI 表单渲染', '!!document.querySelector("#aiProvider") && !!document.querySelector("#aiBaseUrl")', 6000);

  await page.setSelect('#aiProvider', 'custom');
  await page.fill('#aiBaseUrl', MOCK_V1);
  await page.fill('#aiModel', 'mock-model');
  await page.fill('#aiKey', AI_KEY);
  const on = await page.eval('document.querySelector("#aiEnabledSwitch").getAttribute("aria-checked")==="true"');
  if (!on) await page.eval('document.querySelector("#aiEnabledSwitch").click()');
  await sleep(150);
}
async function importPasteText(text, format = 'text') {
  await openImportModal();
  await selectImportTab('paste');
  await pasteAndParse(text, format);
  const preview = clip(await page.text('#importPreview'), 260);
  const result = await confirmImportWaiting(1);
  await closeAllModals();
  return { ...result, preview };
}
async function downloadViaSettings() {
  await goView('dashboard');
  await page.click('#settingsBtn');
  await waitModalText('导出备份');
  await page.waitFor('导出按钮', '!!document.querySelector("#exportDataBtn")', 5000);
  try {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  } catch {
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
    } catch {
      /* ignore */
    }
  }
  for (const f of await readdir(DOWNLOADS).catch(() => [])) {
    await rm(path.join(DOWNLOADS, f), { force: true }).catch(() => {});
  }
  await page.click('#exportDataBtn');
  const file = await poll(
    async () => {
      const files = (await readdir(DOWNLOADS).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.json'));
      for (const f of files) {
        const p = path.join(DOWNLOADS, f);
        const st = await safeStat(p);
        if (st.ok && st.size > 50) return p;
      }
      return null;
    },
    { timeout: 12000, desc: '导出 JSON 下载完成' }
  );
  return { file, raw: await readFile(file, 'utf8') };
}

/* ------------------------------------------------------------------ */
/* 报告                                                               */
/* ------------------------------------------------------------------ */

function mdCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
async function appFiles() {
  const rows = [];
  for (const [label, p] of [
    ['index.html', INDEX_HTML],
    ['js/app.js', path.join(ROOT, 'js', 'app.js')],
    ['js/ai.js', AI_JS],
    ['js/importers.js', path.join(ROOT, 'js', 'importers.js')],
    ['tests/mock-ai-server.mjs', MOCK_SERVER],
  ]) {
    const s = await safeStat(p);
    rows.push(`${label}: ${s.ok ? s.size + ' bytes' : '缺失'}`);
  }
  return rows;
}

let aiSnapshot = null;

async function writeReport({ startedAt, fatal = null, preflight = null }) {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  const total = results.length;
  const lines = [];

  lines.push('# 拾分 · AI 功能 E2E 验收报告');
  lines.push('');
  lines.push(`- 生成时间：${localTime()}`);
  lines.push(`- 运行耗时：${startedAt ? Math.round((Date.now() - startedAt) / 1000) + ' 秒' : 'n/a'}`);
  lines.push(`- 应用：${APP_URL}`);
  lines.push(`- 静态服务：${serverReused ? '复用已有 8765' : '本次启动 8765'}`);
  lines.push(`- Mock AI：${MOCK_ORIGIN}（PING 已校验）`);
  if (chromeInfo) lines.push(`- 浏览器：${chromeInfo.version}（共享 CDP ${SHARED_CDP}，仅操作自己的 target）`);
  lines.push(`- 视口：${VIEW_W}x${VIEW_H}`);
  lines.push('');
  lines.push('## 应用文件');
  lines.push('');
  for (const row of await appFiles()) lines.push('- ' + row);
  lines.push('');

  if (fatal) {
    lines.push('## ⚠ 运行被阻断');
    lines.push('');
    lines.push('```');
    lines.push(fatal);
    lines.push('```');
    lines.push('');
  }

  lines.push('## 结果汇总');
  lines.push('');
  lines.push('| 通过 | 失败 | 跳过 | 合计 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| ${pass} | ${fail} | ${skip} | ${total} |`);
  lines.push('');
  if (total) {
    lines.push(fail === 0 ? `**结论：${pass}/${total} 项通过，0 项失败，AI 功能验收通过。**` : `**结论：${fail} 项失败，需要修复后重跑。**`);
    lines.push('');
  }

  if (results.length) {
    lines.push('## 逐项结果');
    lines.push('');
    lines.push('| 编号 | 验收项 | 结果 | 证据摘要 | 截图 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of results) {
      const ev = clip((r.error ? '错误: ' + r.error + '；' : '') + r.evidence.join('；'), 190);
      lines.push(`| ${r.id} | ${mdCell(r.title)} | ${r.status} | ${mdCell(ev)} | ${r.shots.length ? r.shots.map((s) => `[图](${s})`).join(' ') : '—'} |`);
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
      if (r.shots.length) lines.push('- 截图：' + r.shots.map((s) => `[${s}](${s})`).join('、'));
      lines.push(`- 耗时：${r.duration} ms`);
      lines.push('');
    }
  }

  const ex = page ? page.exceptions : [];
  const errs = page ? page.criticalConsoleErrors() : [];
  lines.push('## 控制台');
  lines.push('');
  lines.push(`- 未捕获异常：${ex.length}`);
  ex.slice(0, 10).forEach((e) => lines.push(`  - ${clip(e.text, 300)}`));
  lines.push(`- 错误级输出：${errs.length}（401 用例产生的浏览器资源日志已按预期过滤）`);
  errs.slice(0, 10).forEach((e) => lines.push(`  - (${e.kind}) ${clip(e.text, 300)}`));
  lines.push('');

  lines.push('## AI 状态摘要（回归前快照）');
  lines.push('');
  if (aiSnapshot) {
    lines.push(`- 配置：provider=${aiSnapshot.ai.provider}，model=${aiSnapshot.ai.model}，baseUrl=${aiSnapshot.ai.baseUrl}，enabled=${aiSnapshot.ai.enabled}，apiKey=${aiSnapshot.ai.apiKey}，autoKeywords=${aiSnapshot.ai.autoKeywords}`);
    lines.push(`- 题库/题目：${aiSnapshot.banks} 个 / ${aiSnapshot.questions} 题`);
    lines.push(`- aiReviews 缓存：${aiSnapshot.reviewCount} 条；AI 关键词题目：${aiSnapshot.keywordQuestions} 题`);
    if (aiSnapshot.reviewQids.length) lines.push(`- 已点评题目：${aiSnapshot.reviewQids.join('、')}`);
  } else {
    lines.push('- 未采集');
  }
  lines.push('');

  if (preflight?.regression) {
    lines.push('## 原 E2E 回归（tests/e2e.mjs 14 项）');
    lines.push('');
    lines.push(`- 退出码：${preflight.regression.status}`);
    lines.push(`- 结果：${preflight.regression.ok ? 'PASS（14/14）' : 'FAIL'}`);
    lines.push('- 关键输出：');
    lines.push('```');
    lines.push(preflight.regression.tail);
    lines.push('```');
    lines.push('');
  }

  lines.push('## 展示截图');
  lines.push('');
  const shots = [];
  try {
    shots.push(...(await readdir(SHOTS)).filter((f) => f.endsWith('.png')).sort());
  } catch {
    /* ignore */
  }
  for (const f of shots) {
    lines.push(`### ${f}`);
    lines.push(`![${f}](screenshots-ai/${f})`);
    lines.push('');
  }

  lines.push('## 备注');
  lines.push('');
  lines.push('- 全部测试使用本地 mock AI（127.0.0.1:18765），未访问外网、未使用真实 API Key。');
  lines.push('- 401 用例通过测试侧 fetch 注入 `x-mock-status: 401` 请求头模拟鉴权失败（mock 服务官方支持该头）。');
  lines.push('- 截图前均对 AI 面板执行 scrollIntoView，保证面板在视口内。');
  lines.push('- 只操作共享 Chrome 中自建 target，结束后关闭自己的 target，不影响共享浏览器。');
  lines.push('');
  await writeFile(path.join(TESTS, 'report-ai.md'), lines.join('\n'), 'utf8');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  await mkdir(SHOTS, { recursive: true });
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  await mkdir(TMP, { recursive: true });
  await mkdir(DOWNLOADS, { recursive: true });

  let fatal = null;
  const preflight = { regression: null };
  let a1Pass = true;

  try {
    log('[infra] 工作目录: ' + ROOT);
    assert(existsSync(INDEX_HTML), 'index.html 不存在');
    assert(existsSync(AI_JS), 'js/ai.js 不存在');
    assert(existsSync(MOCK_SERVER), 'tests/mock-ai-server.mjs 不存在');

    await ensureStaticServer();
    await verifyMock();
    await connectSharedChrome();

    // 清空 localStorage：先到同源测试夹具页再清
    await page.navigate(FIXTURE_URL);
    await page.waitFor('夹具加载', 'document.readyState==="complete" && !!document.getElementById("btn")', 8000);
    await page.eval('localStorage.clear(); sessionStorage.clear();');
    log('[suite] 已清空 localStorage');

    await page.navigate(APP_URL);
    await page.waitFor(
      '应用首屏渲染',
      '(()=>{const v=document.querySelector("#view-dashboard"); return !!v && !v.hidden && (v.innerText||"").trim().length>20;})()',
      15000
    );
    await sleep(400);

    /* ---------------- A1 AI 设置 ---------------- */
    await test(
      'A1',
      'AI 设置：custom + mock 端点 + 测试连接 + 保存',
      '自定义服务商 baseUrl=http://127.0.0.1:18765/v1、model=mock-model、key=test；测试连接成功；保存后 settings.ai 正确',
      ['设置 → AI 服务 → 配置 AI', '选择 custom，填 Base URL / 模型 / Key，启用 AI', '点击测试连接，等待“连接成功”', '保存并检查 localStorage settings.ai', '截图（AI 设置面板滚入视口）'],
      async () => {
        await configureAIViaUI();
        await page.click('#aiTestBtn');
        await page.waitFor(
          'AI 测试连接成功',
          '(()=>{const el=document.querySelector("#aiTestResult"); return !!el && (el.innerText||"").includes("连接成功");})()',
          15000
        );
        const testText = clip(await page.text('#aiTestResult'), 120);
        note('测试连接：' + testText);
        assert(/mock-model/.test(testText), '测试连接结果未显示模型名 mock-model');
        await screenshotScrolled('01-ai-settings-1440.png', '#aiTestResult');

        await page.click('#aiSaveBtn');
        await page.waitFor(
          'AI 配置写入 localStorage',
          '(()=>{const s=__qa.store(); const ai=s&&s.settings&&s.settings.ai; return !!(ai&&ai.enabled&&ai.provider==="custom"&&ai.baseUrl==="http://127.0.0.1:18765/v1"&&ai.model==="mock-model"&&ai.apiKey==="test");})()',
          8000
        );
        const s = await page.store();
        note('保存后 settings.ai=' + JSON.stringify({ ...s.settings.ai, apiKey: '***' }));
        assert(s.settings.ai.apiKey === AI_KEY, 'API Key 未保存为 test');
        await closeAllModals();
        await goView('dashboard');
        await sleep(300);
      }
    );
    a1Pass = results.find((r) => r.id === 'A1')?.status === 'PASS';
    if (!a1Pass) throw new SkipError('A1 AI 配置失败，后续 AI 用例跳过');

    /* ---------------- A2 练习点评 + 关键词 ---------------- */
    await test(
      'A2',
      '练习：AI 点评（score 76 / 命中 / 遗漏 / 建议）+ 提取关键词',
      '无关键词题：AI 点评显示 76 分、2 个命中、2 个遗漏、3 条建议并写入 aiReviews；AI 提取 4 个关键词并写入 localStorage',
      ['导入一道无关键词题并进入练习', '输入答案并 reveal', '点击 AI 点评，校验分数/要点/建议/缓存', '点击重新点评，缓存时间更新', '点击 AI 提取关键词，校验 chips 与 localStorage 4 项', '截图（AI 点评/关键词面板滚入视口）'],
      async () => {
        const setup = await importPasteText('1. 什么是主动学习？\n答案：主动学习是学习者主动参与学习过程，而不是被动接受信息。\n');
        assert(setup.newQuestions.length === 1, '无关键词题导入失败');
        const bank = setup.newBanks[0];
        assert(bank, '未生成题库');
        note(`练习素材：${clip(setup.newQuestions[0].question, 60)}（bank=${bank.name}）`);
        assert(Array.isArray(setup.newQuestions[0].keywords) && setup.newQuestions[0].keywords.length === 0, '导入题应无关键词');

        assert(await startPracticeFromBank(bank.name, bank.id), '无法进入该题练习');
        const qid = await currentQid();
        assert(qid, '无法读取当前题 qid');
        await page.fill('#answerInput', '主动学习强调主动回忆、自我测试与间隔重复，比被动重读更有效。');
        await revealReference();

        assert((await page.text('#aiStatus')).includes('mock-model'), 'AI 状态未显示已启用的 mock-model');
        await page.click('#aiReviewBtn');
        await page.waitFor(
          'AI 点评渲染',
          '(()=>{const o=document.querySelector("#aiOutput"); return !!o && !o.hidden && !!o.querySelector(".ai-review-card");})()',
          25000
        );
        const reviewText = await page.text('#aiOutput');
        note('点评文本：' + clip(reviewText, 240));
        assert(reviewText.includes('76'), 'AI 点评未显示 76 分');
        assert((await page.count('#aiOutput .ai-point.hit')) === 2, '命中要点应为 2 个');
        assert((await page.count('#aiOutput .ai-point.miss')) === 2, '遗漏要点应为 2 个');
        assert((await page.count('#aiOutput .ai-suggestions li')) === 3, '改进建议应为 3 条');
        await screenshotScrolled('02-ai-review-1440.png', '#aiOutput');

        let s = await page.store();
        let review = s.aiReviews?.[qid];
        assert(review, '点评未写入 state.aiReviews');
        assert(review.score === 76 && review.verdict === '基本掌握', 'aiReviews 分数/结论不正确');
        assert(review.matchedPoints.length === 2 && review.missedPoints.length === 2, 'aiReviews 命中/遗漏数量不正确');
        const oldAt = review.at;
        note(`aiReviews[${qid}] score=${review.score} verdict=${review.verdict} at=${oldAt}`);

        await sleep(120);
        await page.eval('document.querySelector("#aiOutput [data-ai-retry]").click()');
        await page.waitFor(
          '重新点评更新缓存',
          `(()=>{const s=__qa.store(); const r=s&&s.aiReviews&&s.aiReviews[${JSON.stringify(qid)}]; return !!(r&&r.at>${oldAt});})()`,
          25000
        );
        note('重新点评已更新 aiReviews.at');

        await page.click('#aiKeywordsBtn');
        await page.waitFor(
          '关键词写入 state',
          `(()=>{const s=__qa.store(); const q=s&&s.questions&&s.questions.find(x=>x.id===${JSON.stringify(qid)}); return !!(q&&Array.isArray(q.keywords)&&q.keywords.length===4);})()`,
          25000
        );
        s = await page.store();
        const q = s.questions.find((x) => x.id === qid);
        note('AI 关键词：' + q.keywords.join('、'));
        assert(q.keywords.includes('主动学习') && q.keywords.includes('记忆保持率'), 'AI 关键词内容不符合 mock 返回');
        assert((await page.count('#keywordChips > *')) === 4, '关键词 chips 未更新为 4 个');
        await screenshotScrolled('03-ai-keywords-1440.png', '#aiTools');
      }
    );

    /* ---------------- A3 AI 导入（粘贴素材生成 10 题） ---------------- */
    let aiBank = null;
    await test(
      'A3',
      'AI 导入：粘贴材料 → 生成 10 题 → 预览 → 导入 → 可练习',
      '粘贴素材后生成 10 道题，预览显示 10 道题生成成功，确认导入后新题库出现且可进入练习',
      ['打开导入弹窗 → AI 生成 tab', '粘贴材料，生成题数选 10', '点击 AI 生成题目，等待预览 10 题', '确认导入，校验题库/题目数量', '从新题库进入练习', '截图（预览面板滚入视口）'],
      async () => {
        await openImportModal();
        await selectImportTab('ai');
        assert(await page.visible('#importAiPane'), 'AI 生成面板未显示');
        const material =
          '第三章 认知负荷与学习设计。认知负荷是工作记忆在完成任务时承受的心理负担，分为内在负荷、外在负荷和相关负荷。' +
          '降低外在认知负荷的方法包括：减少无关信息、使用清晰的排版、分步呈现内容、提供示例与练习。' +
          '间隔练习把复习分散到不同时间点，有助于长期保持；提取练习要求学习者主动回忆，而不是反复阅读。' +
          '费曼学习法强调用自己的话解释概念，并通过反馈修正理解。';
        await page.fill('#aiSourceText', material);
        await page.setSelect('#aiCount', '10');
        await page.setSelect('#aiDifficulty', '0');
        await page.waitFor('素材字数统计', '(()=>{const t=document.querySelector("#aiSourceMeta"); return !!t && /字/.test(t.innerText);})()', 5000);

        const before = await page.store();
        await page.click('#aiGenerateBtn');
        await page.waitFor(
          'AI 生成 10 题预览',
          '(()=>{const b=document.querySelector("#confirmImport"); const p=document.querySelector("#importPreview"); return !!b && !b.disabled && !!p && (p.innerText||"").includes("道题生成成功") && document.querySelectorAll("#previewList .preview-item").length===10;})()',
          30000
        );
        const preview = clip(await page.text('#importPreview'), 260);
        note('生成预览：' + preview);
        assert(preview.includes('10'), '预览未显示 10 道题');
        await screenshotScrolled('04-ai-import-preview-1440.png', '#importPreview');

        const result = await confirmImportWaiting(10);
        await closeAllModals();
        assert(result.newQuestions.length === 10, `确认导入题数应为 10，实际 ${result.newQuestions.length}`);
        aiBank = result.newBanks[0] || null;
        assert(aiBank, '导入未创建新题库');
        assert(aiBank.sourceType === 'AI 生成', '题库 sourceType 应为 AI 生成');
        note(`导入 AI 题库：${aiBank.name}（${result.newQuestions.length} 题）`);
        assert(result.newQuestions.every((q) => q.question && q.answer), 'AI 生成题存在空题干/空答案');

        assert(await startPracticeFromBank(aiBank.name, aiBank.id), '无法从 AI 生成题库进入练习');
        const qid = await currentQid();
        const s = await page.store();
        const q = s.questions.find((x) => x.id === qid);
        assert(q && q.bankId === aiBank.id, '当前练习题不属于 AI 生成题库');
        note('AI 题库已可练习：' + clip(await page.text('#questionText'), 50));
      }
    );

    /* ---------------- A4 AI 导入：docx 提取 1604 字 ---------------- */
    await test(
      'A4',
      'AI 导入：docx 素材提取 1604 字并生成',
      'samples/简答题示例.docx 经 extractText 提取 1604 字，AI 可据此生成 10 题预览',
      ['打开导入弹窗 → AI 生成 tab', '选择 samples/简答题示例.docx', '校验提取字数 = 1604', '生成 10 题并校验预览', '截图（素材/预览面板滚入视口）'],
      async () => {
        await openImportModal();
        await selectImportTab('ai');
        const docx = path.join(ROOT, 'samples', '简答题示例.docx');
        assert(existsSync(docx), 'samples/简答题示例.docx 不存在');
        await page.setFiles('#aiSourceInput', [docx]);
        await page.waitFor(
          'docx 素材提取完成',
          '(()=>{const ta=document.querySelector("#aiSourceText"); return !!ta && ta.value.trim().length>500;})()',
          15000
        );
        await sleep(300);
        const chars = Number(await page.eval('document.querySelector("#aiSourceText").value.length'));
        const meta = clip(await page.text('#aiSourceMeta'), 80);
        note(`docx 提取字数：${chars}；${meta}`);
        assert(chars === 1604, `docx 提取字数应为 1604，实际 ${chars}`);
        await screenshotScrolled('05-ai-docx-source-1440.png', '#aiSourceMeta');

        await page.click('#aiGenerateBtn');
        await page.waitFor(
          'docx 素材生成预览',
          '(()=>{const b=document.querySelector("#confirmImport"); const p=document.querySelector("#importPreview"); return !!b && !b.disabled && !!p && (p.innerText||"").includes("道题生成成功") && document.querySelectorAll("#previewList .preview-item").length===10;})()',
          30000
        );
        note('docx 素材生成 10 题预览正常');
        await screenshotScrolled('06-ai-docx-generate-1440.png', '#importPreview');
        await closeAllModals();
      }
    );

    /* ---------------- A5 导入预览 AI 补关键词 ---------------- */
    await test(
      'A5',
      '导入预览：AI 补全关键词，且不覆盖已有关键词',
      '粘贴两题（一题无关键词、一题有关键词）→ 预览出现“AI 补全关键词（1）” → 补全后导入：缺关键词题写入 3 个，已有关键词保持“间隔、复习”不变',
      ['粘贴 CSV 两题（缺/有关键词各一）', '预览出现 AI 补全关键词按钮并截图', '点击补全，等待命中数清零', '确认导入，校验两题关键词', '截图（预览 AI 条滚入视口）'],
      async () => {
        await openImportModal();
        await selectImportTab('paste');
        const csv = [
          '题目,答案,关键词',
          '主动学习是什么？,主动学习是学习者主动参与学习过程。,',
          '间隔重复是什么？,间隔重复是把复习分散到多个时间点。,间隔、复习',
        ].join('\n');
        await pasteAndParse(csv, 'csv');
        await page.waitFor(
          '预览出现 AI 补全关键词入口',
          '(()=>{const b=document.querySelector("#aiKeywordsImportBtn"); return !!b && /AI 补全关键词/.test(b.innerText||"");})()',
          8000
        );
        const strip = clip(await page.text('.import-ai-strip'), 120);
        note('AI 补全条：' + strip);
        assert(strip.includes('缺少关键词'), '未提示缺关键词');
        assert(strip.includes('1'), '缺少关键词数量应为 1');
        await screenshotScrolled('07-ai-preview-keywords-1440.png', '.import-ai-strip');

        await page.click('#aiKeywordsImportBtn');
        await page.waitFor(
          'AI 补关键词完成',
          '(()=>{const b=document.querySelector("#aiKeywordsImportBtn"); return !b || !__qa.visible("#aiKeywordsImportBtn");})()',
          25000
        );
        await sleep(400);
        const previewAfter = await page.text('#importPreview');
        assert(!previewAfter.includes('缺少关键词'), '补全后仍提示缺关键词');

        const result = await confirmImportWaiting(2);
        await closeAllModals();
        assert(result.newQuestions.length === 2, `应导入 2 题，实际 ${result.newQuestions.length}`);
        const qNoKey = result.newQuestions.find((q) => q.question.includes('主动学习'));
        const qHasKey = result.newQuestions.find((q) => q.question.includes('间隔重复'));
        assert(qNoKey && qHasKey, '导入题目文本不匹配');
        assert(qNoKey.keywords.length === 3, `缺关键词题应补齐 3 个，实际 ${qNoKey.keywords.length}`);
        assert(JSON.stringify(qHasKey.keywords) === JSON.stringify(['间隔', '复习']), '已有关键词被覆盖: ' + JSON.stringify(qHasKey.keywords));
        note('补全题关键词：' + qNoKey.keywords.join('、') + '；原有：' + qHasKey.keywords.join('、'));
      }
    );

    /* ---------------- A6 401 错误处理 ---------------- */
    await test(
      'A6',
      '错误处理：mock 401 可读提示、页面不崩、不写 aiReviews',
      'AI 点评返回 401 时显示可读“鉴权失败”错误卡片，aiReviews 不新增；解除错误后重试成功并写入缓存',
      ['进入 AI 题库某题，输入答案并 reveal', '记录 aiReviews 数量与当前 qid', '开启测试侧 401 注入，点击 AI 点评', '校验错误卡片文案、缓存未写、页面未崩', '关闭 401 注入，点击重试，校验恢复并写缓存', '截图（错误卡片滚入视口）'],
      async () => {
        assert(aiBank, '缺少 A3 生成的 AI 题库');
        assert(await startPracticeFromBank(aiBank.name, aiBank.id), '无法进入 AI 题库练习');
        await page.fill('#answerInput', '这是 401 错误处理用例的作答内容。');
        await revealReference();
        const qid = await currentQid();
        assert(qid, '无法读取 qid');
        const before = await page.store();
        const beforeCount = Object.keys(before.aiReviews || {}).length;
        assert(!before.aiReviews?.[qid], '测试题不应已有点评缓存');

        await page.eval('window.__qaMock401 = true');
        await page.click('#aiReviewBtn');
        await page.waitFor(
          '401 错误卡片渲染',
          '(()=>{const o=document.querySelector("#aiOutput"); return !!o && !o.hidden && !!o.querySelector(".ai-error-card");})()',
          25000
        );
        const errText = await page.text('#aiOutput');
        note('错误卡片：' + clip(errText, 220));
        assert(/鉴权失败|401/.test(errText), '错误提示未包含“鉴权失败/401”');
        assert(/API Key|权限|鉴权/.test(errText), '错误提示缺少可操作的中文说明');
        assert(await page.visible('#questionText'), '401 后练习页崩溃');
        const after = await page.store();
        assert(!after.aiReviews?.[qid], '401 失败后不应写入 aiReviews');
        assert(Object.keys(after.aiReviews || {}).length === beforeCount, '401 后 aiReviews 数量变化');
        await screenshotScrolled('08-ai-401-error-1440.png', '#aiOutput');

        await page.eval('window.__qaMock401 = false');
        await page.eval('document.querySelector("#aiOutput [data-ai-retry]").click()');
        await page.waitFor(
          '401 解除后重试成功',
          '(()=>{const o=document.querySelector("#aiOutput"); return !!o && !!o.querySelector(".ai-review-card");})()',
          25000
        );
        const retried = await page.store();
        assert(retried.aiReviews?.[qid]?.score === 76, '重试成功后未写入 aiReviews');
        note('解除 401 后重试成功，已写入 aiReviews');
      }
    );

    /* ---------------- A7 导出 JSON 不含 apiKey ---------------- */
    await test(
      'A7',
      '导出 JSON 不含 apiKey；本机 key 不丢',
      '导出备份中 settings.ai.apiKey 为空/缺失，原始 JSON 不含 test key；导出后本机仍保留 key',
      ['设置中点击导出 JSON 并读取文件', '校验 apiKey 被剥离、其余 AI 配置保留', '校验本机 localStorage 的 key 仍在'],
      async () => {
        const { raw } = await downloadViaSettings();
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          throw new Error('导出的 JSON 无法解析: ' + e.message);
        }
        const exported = payload.state || payload;
        const ai = exported.settings?.ai || {};
        note('导出 AI 配置：' + JSON.stringify({ ...ai, apiKey: '<redacted>' }));
        assert('apiKey' in ai, '导出 settings.ai 缺少 apiKey 字段');
        assert(ai.apiKey === '', '导出 JSON 的 apiKey 应为空，实际: ' + JSON.stringify(ai.apiKey));
        assert(!raw.includes('"apiKey": "test"'), '导出原文仍包含明文 test key');
        assert(ai.model === 'mock-model' && ai.provider === 'custom' && ai.enabled === true, '导出的其他 AI 配置不完整');

        const s = await page.store();
        assert(s.settings.ai.apiKey === AI_KEY, '导出后本机 apiKey 丢失');
        note('导出后本机 apiKey 仍保留');
        await closeAllModals();
      }
    );

    /* ---------------- A9 导入时自动补全关键词 ---------------- */
    await test(
      'A9',
      '设置开关：导入时自动补全关键词（默认关闭）',
      'AI 设置中的“导入时自动补全关键词”默认关闭；开启后普通粘贴导入缺关键词题，自动调用 AI 补齐 3 个关键词并成功导入',
      ['打开 AI 设置，确认自动补关键词开关默认关闭', '开启开关并保存（settings.ai.autoKeywords=true）', '普通粘贴两道无关键词题，等待自动补全完成', '确认导入，校验每道题写入 3 个关键词', '截图（导入预览 AI 条滚入视口）'],
      async () => {
        await page.click('#settingsBtn');
        await waitModalText('AI 服务');
        await page.waitFor('设置弹窗打开', '!!document.querySelector("#openAiSettingsBtn")', 6000);
        await page.eval('document.querySelector("#openAiSettingsBtn").click()');
        await waitModalText('AI 服务设置');
        await page.waitFor('自动补关键词开关', '!!document.querySelector("#aiAutoKeywordsSwitch")', 6000);
        const beforeSwitch = await page.eval('document.querySelector("#aiAutoKeywordsSwitch").getAttribute("aria-checked")');
        assert(beforeSwitch === 'false', '自动补关键词开关默认应关闭');
        note('默认关闭：aria-checked=false');
        await page.eval('document.querySelector("#aiAutoKeywordsSwitch").click()');
        await page.click('#aiSaveBtn');
        await page.waitFor(
          'autoKeywords 配置保存',
          '(()=>{const s=__qa.store(); return !!(s&&s.settings&&s.settings.ai&&s.settings.ai.autoKeywords===true);})()',
          8000
        );
        note('已开启 settings.ai.autoKeywords=true');
        await closeAllModals();

        await openImportModal();
        await selectImportTab('paste');
        const text = [
          '1. 自动补关键词测试题一：什么是提取练习？',
          '答案：提取练习要求学习者主动从记忆中回忆知识，而不是反复阅读。',
          '2. 自动补关键词测试题二：什么是间隔练习？',
          '答案：间隔练习把复习分散到不同时间点，利用遗忘曲线强化长期记忆。',
        ].join('\n');
        await page.fill('#pasteInput', text);
        await page.setSelect('#pasteFormat', 'text');
        await page.click('#parsePasteBtn');
        await page.waitFor(
          '自动补关键词完成（预览无缺关键词提示）',
          '(()=>{const b=document.querySelector("#aiKeywordsImportBtn"); const p=document.querySelector("#importPreview"); const t=(p&&p.innerText)||""; return !b && !/AI 正在补全/.test(t) && t.includes("道题识别成功") && t.includes("导入到") && !!document.querySelector("#confirmImport");})()',
          25000
        );
        note('自动补全完成后预览已无缺关键词提示');
        // 等前面 401 用例的错误 toast 消失，避免污染交付截图
        await page.waitFor('旧错误提示消失', '!document.querySelector("#toastRoot .toast-error")', 7000).catch(() => {});
        await screenshotScrolled('09-ai-auto-keywords-1440.png', '#importPreview');

        const result = await confirmImportWaiting(2);
        await closeAllModals();
        assert(result.newQuestions.length === 2, `应导入 2 题，实际 ${result.newQuestions.length}`);
        const okKeywords = result.newQuestions.every((q) => q.keywords.length === 3);
        assert(okKeywords, '自动补全后题目关键词数量应为 3：' + JSON.stringify(result.newQuestions.map((q) => q.keywords)));
        note('自动补全入库关键词：' + result.newQuestions.map((q) => q.keywords.join('、')).join(' | '));

        const s = await page.store();
        assert(s.settings.ai.autoKeywords === true, '导入后 autoKeywords 设置应保持开启');
        note('设置保持开启');
      }
    );

    /* ---------------- 回归前快照 ---------------- */
    {
      const s = await page.store();
      aiSnapshot = {
        ai: {
          provider: s.settings.ai.provider,
          model: s.settings.ai.model,
          baseUrl: s.settings.ai.baseUrl,
          enabled: s.settings.ai.enabled,
          apiKey: s.settings.ai.apiKey ? '***保留***' : '(空)',
          autoKeywords: s.settings.ai.autoKeywords,
        },
        banks: s.banks.length,
        questions: s.questions.length,
        reviewCount: Object.keys(s.aiReviews || {}).length,
        reviewQids: Object.keys(s.aiReviews || {}),
        keywordQuestions: s.questions.filter((q) => Array.isArray(q.keywords) && q.keywords.length).length,
      };
      log('[suite] AI 快照: ' + JSON.stringify(aiSnapshot));
    }

    /* ---------------- A8 原 14 项回归 ---------------- */
    await test(
      'A8',
      '回归：原 tests/e2e.mjs 14 项全过',
      'AI 改动后原 E2E 14 项仍全部 PASS（不配置 AI 的普通流程不受影响）',
      ['spawn node tests/e2e.mjs（复用 8765/9222，独立 target）', '校验退出码 0 且输出 PASS=14 FAIL=0'],
      async () => {
        const t0 = Date.now();
        // 本进程内 child_process 的管道可能被 DSH 限制拦截（EPERM），因此不捕获 stdout；
        // 回归脚本会写 tests/e2e.log 与 tests/report.md，再从文件读取结果。
        const e2eReport = path.join(TESTS, 'report.md');
        const e2eLog = path.join(TESTS, 'e2e.log');
        await rm(e2eReport, { force: true }).catch(() => {});
        const res = spawnSync(process.execPath, [path.join(TESTS, 'e2e.mjs')], {
          cwd: ROOT,
          stdio: 'ignore',
          timeout: 240000,
          windowsHide: true,
        });
        const status = res.status;
        let reportText = '';
        let logText = '';
        try {
          reportText = await readFile(e2eReport, 'utf8');
        } catch {
          reportText = '';
        }
        try {
          logText = await readFile(e2eLog, 'utf8');
        } catch {
          logText = '';
        }
        const counts = reportText.match(/\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
        const reportOk = /结论：14\/14 项通过/.test(reportText);
        const tail = clip(
          logText
            .split('\n')
            .filter((l) => l.trim())
            .slice(-18)
            .join('\n') || (res.error ? String(res.error.message || res.error) : '(无日志)'),
          1800
        );
        preflight.regression = {
          status,
          ok: status === 0 && reportOk,
          tail,
          error: res.error ? String(res.error.message || res.error) : '',
          counts: counts ? counts.slice(1).join('/') : '',
        };
        note(`回归退出码=${status}，耗时 ${Math.round((Date.now() - t0) / 1000)}s，报告汇总=${counts ? counts.slice(1).join('/') : '未读取'} 项`);
        if (res.error) note('spawn error: ' + preflight.regression.error);
        assert(status === 0, '原 E2E 14 项未全部通过（退出码 ' + status + '）');
        assert(reportOk, '原 E2E 报告未显示 14/14 项通过');
        note('原 E2E 14 项 PASS=14 FAIL=0（依据 tests/report.md）');
      }
    );

    const fail = results.filter((r) => r.status === 'FAIL').length;
    await writeReport({ startedAt, preflight });
    log(`\n[suite] 完成：PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${fail} SKIP=${results.filter((r) => r.status === 'SKIP').length}`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    fatal = String((e && e.stack) || e);
    log('\n[fatal] ' + fatal);
    try {
      await writeReport({ startedAt, fatal, preflight });
    } catch (e2) {
      log('[fatal] 报告写入失败: ' + e2.message);
    }
    process.exitCode = 1;
  } finally {
    try {
      await writeFile(path.join(TESTS, 'e2e-ai.log'), logLines.join('\n'), 'utf8');
    } catch {
      /* ignore */
    }
    await cleanup();
  }
}

main();
