#!/usr/bin/env node
/* =========================================================================
   拾分 · AI 服务层自测（node tests/ai-service-check.mjs）
   -------------------------------------------------------------------------
   - 启动 tests/mock-ai-server.mjs 子进程（stdio: ignore），不访问外网
   - 用 node:vm 加载 js/ai.js（提供 window / fetch / AbortController）
   - 覆盖 testConnection、review、keywords、batch、generate、
     CONFIG/AUTH/MODEL/RATE/NETWORK/TIMEOUT/HTTP/PARSE 等分支
   - 输出 PASS / FAIL；失败时以非 0 退出；结束杀掉 mock 子进程
   ========================================================================= */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const AI_PATH = join(ROOT, 'js', 'ai.js');
const MOCK_PATH = join(HERE, 'mock-ai-server.mjs');

const KEY = 'sk-test-secret-123';
const MOCK_MODEL = 'mock-model';

let PORT = Number(process.env.MOCK_AI_PORT || 18765);
let BASE = '';
let V1 = '';

const VERDICTS = ['掌握', '基本掌握', '还需巩固', '未掌握'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ 端口选择 ------------------------------ */
/* 默认 18765；若已被其他进程（例如队友手动启动的 mock）占用，
   自动换一个空闲端口，保证自测环境隔离。也可用 MOCK_AI_PORT 指定。 */

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function resolveMockPort() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('MOCK_AI_PORT 不是合法端口：' + process.env.MOCK_AI_PORT);
  }
  if (await isPortFree(PORT)) return;
  if (process.env.MOCK_AI_PORT) {
    throw new Error('端口 ' + PORT + ' 已被占用，请先停止已运行的 mock 或换一个 MOCK_AI_PORT');
  }
  const fallback = await findFreePort();
  console.log('[ai-check] 端口 ' + PORT + ' 已被占用，自动改用空闲端口 ' + fallback);
  PORT = fallback;
}

await resolveMockPort();
BASE = 'http://127.0.0.1:' + PORT;
V1 = BASE + '/v1';

/* ------------------------------ 断言与用例运行器 ------------------------------ */

let passed = 0;
const failed = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message || '断言失败') + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual)
    );
  }
}

function assertChinese(message, label) {
  assert(
    /[\u4e00-\u9fa5]/.test(message || ''),
    (label || '错误') + ' 的 message 应为中文，实际：' + JSON.stringify(message)
  );
}

async function expectReject(fn, code, label) {
  try {
    await fn();
  } catch (err) {
    if (code) assertEqual(err.code, code, (label || '调用') + ' 的错误码');
    assert(typeof err.message === 'string' && err.message.length > 0, (label || '错误') + ' 应有 message');
    assertChinese(err.message, label);
    return err;
  }
  throw new Error((label || '调用') + ' 应该抛出错误，但成功返回了');
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failed.push({ name, error: err });
    console.log('FAIL ' + name + ' -> ' + (err && err.message ? err.message : String(err)));
    if (process.env.AI_CHECK_VERBOSE && err && err.stack) {
      console.log(err.stack);
    }
  }
}

/* ------------------------------ 加载 ai.js（vm） ------------------------------ */

const logs = [];

// 测试内可替换的 fetch，用来稳定触发 TIMEOUT 分支。
let currentFetch = (url, options) => fetch(url, options);

function hangingFetch(url, options) {
  return new Promise((resolve, reject) => {
    const rejectAbort = () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    const signal = options && options.signal;
    if (!signal) return; // 永不 resolve，也不会 reject，用于验证超时
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener('abort', rejectAbort);
  });
}

const sandbox = {
  window: {},
  console: {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' '))
  },
  fetch: (url, options) => currentFetch(url, options),
  AbortController,
  URL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};

const context = vm.createContext(sandbox);
vm.runInContext(readFileSync(AI_PATH, 'utf8'), context, { filename: 'js/ai.js' });

const AI = sandbox.window.ShifenAI;

/* ------------------------------ mock 子进程 ------------------------------ */

let mockChild = null;

async function startMock() {
  mockChild = spawn(process.execPath, [MOCK_PATH, '--port', String(PORT)], {
    stdio: 'ignore',
    windowsHide: true
  });

  let spawnError = null;
  mockChild.on('error', (err) => {
    spawnError = err;
  });

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error('无法启动 mock 子进程：' + spawnError.message);
    if (mockChild.exitCode !== null) {
      throw new Error(
        'mock 子进程提前退出（code=' + mockChild.exitCode + '），端口 ' + PORT + ' 可能已被占用'
      );
    }
    try {
      const res = await fetch(`${V1}/chat/completions`, {
        method: 'OPTIONS',
        signal: AbortSignal.timeout(800)
      });
      if (res.status === 204) return;
    } catch {
      /* 尚未监听，继续等待 */
    }
    await sleep(100);
  }
  throw new Error(`mock 服务在 12 秒内未就绪（${BASE}），请检查端口 ${PORT} 是否被占用`);
}

async function stopMock() {
  const child = mockChild;
  mockChild = null;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1500)]);
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
}

/* ------------------------------ 配置辅助 ------------------------------ */

function configure(patch = {}) {
  return AI.configure(
    Object.assign(
      {
        enabled: true,
        provider: 'custom',
        baseUrl: V1,
        model: MOCK_MODEL,
        apiKey: KEY,
        temperature: 0.3
      },
      patch
    )
  );
}

function withBase(baseUrl, patch = {}) {
  return configure(Object.assign({ baseUrl }, patch));
}

async function reviewOn(baseUrl, extra = {}) {
  configure(Object.assign({ baseUrl }, extra));
  return AI.reviewAnswer({
    question: '什么是主动学习？',
    reference: '主动学习是主动回忆、提问与总结，而不是被动重读。',
    keywords: ['主动学习'],
    userAnswer: '主动学习就是主动回忆和总结。'
  });
}

/* ------------------------------ 用例 ------------------------------ */

async function runTests() {
  /* ---------- 静态 API ---------- */

  await test('ai.js 暴露 window.ShifenAI 与全部契约方法', () => {
    assert(AI && typeof AI === 'object', 'window.ShifenAI 应存在');
    [
      'configure',
      'getConfig',
      'isConfigured',
      'testConnection',
      'reviewAnswer',
      'extractKeywords',
      'completeKeywordsBatch',
      'generateQuestions'
    ].forEach((name) => assertEqual(typeof AI[name], 'function', '方法 ' + name));
  });

  await test('PRESETS 包含四类服务商且 requiresKey 正确', () => {
    const providers = Object.keys(AI.PRESETS).sort();
    assertEqual(providers.join(','), 'custom,deepseek,ollama,openai');
    ['deepseek', 'openai', 'ollama', 'custom'].forEach((name) => {
      const preset = AI.PRESETS[name];
      assert(preset, name + ' 预设应存在');
      ['label', 'baseUrl', 'model', 'requiresKey'].forEach((field) => {
        assert(Object.prototype.hasOwnProperty.call(preset, field), name + ' 缺少字段 ' + field);
      });
    });
    assertEqual(AI.PRESETS.deepseek.requiresKey, true);
    assertEqual(AI.PRESETS.openai.requiresKey, true);
    assertEqual(AI.PRESETS.ollama.requiresKey, false);
    assertEqual(AI.PRESETS.custom.requiresKey, false);
  });

  await test('初始配置为未启用（不配置也能加载）', () => {
    const config = AI.getConfig();
    assertEqual(config.enabled, false);
    assertEqual(config.provider, 'deepseek');
    assertEqual(config.baseUrl, 'https://api.deepseek.com/v1');
    assertEqual(config.model, 'deepseek-chat');
    assertEqual(config.apiKey, '');
    assertEqual(AI.isConfigured(), false);
  });

  await test('configure 规范化并返回副本（末尾斜杠 / 温度 / key trim）', () => {
    const config = AI.configure({
      enabled: true,
      provider: 'custom',
      baseUrl: V1 + '///',
      model: '  mock-model  ',
      apiKey: '  ' + KEY + '  ',
      temperature: 5
    });
    assertEqual(config.baseUrl, V1, 'baseUrl 末尾斜杠应去掉');
    assertEqual(config.model, MOCK_MODEL, 'model 应 trim');
    assertEqual(config.apiKey, KEY, 'apiKey 应 trim');
    assertEqual(config.temperature, 2, 'temperature 应限制在 0-2');
    config.model = '被修改';
    assertEqual(AI.getConfig().model, MOCK_MODEL, 'getConfig 应返回副本');
  });

  await test('切换服务商时自动带入预设地址与模型', () => {
    const config = AI.configure({ provider: 'ollama' });
    assertEqual(config.baseUrl, 'http://127.0.0.1:11434/v1');
    assertEqual(config.model, 'qwen2.5:7b');
    assertEqual(config.provider, 'ollama');
  });

  await test('isConfigured 按 enabled/baseUrl/model/key 判断', () => {
    const base = {
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'k'
    };
    assertEqual(AI.isConfigured(base), true);
    assertEqual(AI.isConfigured(Object.assign({}, base, { enabled: false })), false);
    assertEqual(AI.isConfigured(Object.assign({}, base, { baseUrl: '' })), false);
    assertEqual(AI.isConfigured(Object.assign({}, base, { model: '' })), false);
    assertEqual(AI.isConfigured(Object.assign({}, base, { apiKey: '' })), false);
    assertEqual(AI.isConfigured(Object.assign({}, base, { provider: 'ollama', apiKey: '' })), true);
  });

  /* ---------- testConnection ---------- */

  await test('testConnection 成功返回 ok/latency/model/message', async () => {
    configure();
    const result = await AI.testConnection();
    assertEqual(result.ok, true, '应连接成功：' + JSON.stringify(result));
    assertEqual(typeof result.latency, 'number');
    assert(result.latency >= 0, 'latency 应为非负数');
    assertEqual(result.model, MOCK_MODEL);
    assertEqual(result.message, 'OK');
  });

  await test('testConnection 401 返回 ok:false + AUTH（不抛错）', async () => {
    const result = await AI.testConnection({
      enabled: true,
      provider: 'custom',
      baseUrl: `${V1}/mock-status-401`,
      model: MOCK_MODEL,
      apiKey: KEY
    });
    assertEqual(result.ok, false);
    assertEqual(result.code, 'AUTH');
    assertChinese(result.message, 'testConnection 401');
  });

  await test('testConnection 缺少 Key 返回 CONFIG', async () => {
    const result = await AI.testConnection({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: ''
    });
    assertEqual(result.ok, false);
    assertEqual(result.code, 'CONFIG');
    assertChinese(result.message, 'testConnection 缺 key');
  });

  await test('有 Key 时发送 Bearer；无 Key 的 Ollama 不发送且可正常调用', async () => {
    // mock 的 /mock-require-auth 只在缺少 Authorization: Bearer 时返回 401。
    configure({ baseUrl: `${V1}/mock-require-auth` });
    const authed = await AI.reviewAnswer({
      question: 'q',
      reference: 'r',
      userAnswer: 'a'
    });
    assertEqual(authed.score, 76, '带 Key 的请求应通过鉴权');

    configure({ provider: 'ollama', baseUrl: `${V1}/mock-require-auth`, model: MOCK_MODEL, apiKey: '' });
    await expectReject(
      () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: 'a' }),
      'AUTH',
      '无 Key 的 Ollama 请求不应带 Authorization'
    );

    configure({ provider: 'ollama', baseUrl: V1, model: MOCK_MODEL, apiKey: '' });
    const noKey = await AI.reviewAnswer({
      question: 'q',
      reference: 'r',
      userAnswer: 'a'
    });
    assertEqual(noKey.score, 76, '无 Key 的 Ollama 也应能正常调用');
  });

  /* ---------- review ---------- */

  await test('reviewAnswer 解析围栏 JSON 并归一化（score 76）', async () => {
    configure();
    const review = await AI.reviewAnswer({
      question: '什么是主动学习？',
      reference: '主动学习是主动回忆、提问与总结，而不是被动重读。',
      keywords: ['主动学习'],
      userAnswer: '主动学习就是主动回忆和总结。'
    });
    assertEqual(review.score, 76);
    assert(VERDICTS.indexOf(review.verdict) >= 0, 'verdict 应在四档内：' + review.verdict);
    assertEqual(review.matchedPoints.length, 2);
    assertEqual(review.missedPoints.length, 2);
    assertEqual(review.suggestions.length, 3);
    assert(review.summary.length > 0, 'summary 不应为空');
    assert(review.improvedAnswer.length > 0, 'improvedAnswer 不应为空');
    assertEqual(review.model, MOCK_MODEL);
    assertEqual(typeof review.at, 'number');
  });

  await test('reviewAnswer 对越界分值 / 重复数组做归一化', async () => {
    withBase(`${V1}/mock-overflow`);
    const review = await AI.reviewAnswer({
      question: 'q',
      reference: 'r',
      userAnswer: 'a'
    });
    assertEqual(review.score, 100, 'score 应限制在 0-100');
    assert(VERDICTS.indexOf(review.verdict) >= 0, 'verdict 应归一化到四档');
    const unique = new Set(review.matchedPoints.map(String));
    assertEqual(unique.size, review.matchedPoints.length, 'matchedPoints 应去重');
  });

  await test('reviewAnswer 空答案抛 CONFIG', async () => {
    configure();
    await expectReject(
      () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: '   ' }),
      'CONFIG',
      '空答案点评'
    );
  });

  await test('reviewAnswer 解析失败抛 PARSE', async () => {
    withBase(`${V1}/mock-bad-json`);
    await expectReject(
      () =>
        AI.reviewAnswer({
          question: 'q',
          reference: 'r',
          userAnswer: 'a'
        }),
      'PARSE',
      '非 JSON 模型输出'
    );
  });

  /* ---------- extractKeywords ---------- */

  await test('extractKeywords 返回 4 个关键词', async () => {
    configure();
    const result = await AI.extractKeywords({
      question: '如何高效记忆？',
      reference: '主动学习、间隔重复与自我测试有助于长期记忆。',
      existingKeywords: []
    });
    assertEqual(result.keywords.length, 4);
    assertEqual(
      JSON.stringify(result.keywords),
      JSON.stringify(['主动学习', '间隔重复', '自我测试', '记忆保持率'])
    );
  });

  await test('extractKeywords 对越界数量去重并限制 8 个', async () => {
    withBase(`${V1}/mock-overflow`);
    const result = await AI.extractKeywords({ question: 'q', reference: 'r' });
    assertEqual(result.keywords.length, 8);
    assertEqual(new Set(result.keywords.map(String)).size, 8, '关键词应去重');
  });

  await test('extractKeywords 缺少题目/参考答案抛 CONFIG', async () => {
    configure();
    await expectReject(() => AI.extractKeywords({}), 'CONFIG', '关键词缺输入');
  });

  await test('extractKeywords 解析失败抛 PARSE', async () => {
    withBase(`${V1}/mock-bad-json`);
    await expectReject(
      () => AI.extractKeywords({ question: 'q', reference: 'r' }),
      'PARSE',
      '关键词非 JSON'
    );
  });

  /* ---------- completeKeywordsBatch ---------- */

  await test('completeKeywordsBatch 10 题分两批且保留 index', async () => {
    configure();
    const items = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      question: '题目 ' + (i + 1),
      reference: '参考答案 ' + (i + 1),
      existingKeywords: []
    }));
    const results = await AI.completeKeywordsBatch(items);
    assertEqual(results.length, 10);
    results.forEach((item, i) => {
      assertEqual(Number(item.index), i, '第 ' + i + ' 项的 index 不应丢失');
      assertEqual(item.keywords.length, 3, '每项应返回 3 个关键词');
      assertEqual(String(item.keywords[0]), '要点' + i + '甲', '关键词应与 index 对应，不能串题');
    });
  });

  await test('completeKeywordsBatch 保留非连续自定义 index', async () => {
    configure();
    const results = await AI.completeKeywordsBatch([
      { index: 101, question: 'q101', reference: 'r101' },
      { index: 105, question: 'q105', reference: 'r105' }
    ]);
    assertEqual(JSON.stringify(results.map((item) => item.index)), '[101,105]');
    assertEqual(String(results[0].keywords[0]), '要点101甲');
    assertEqual(String(results[1].keywords[0]), '要点105甲');
  });

  await test('completeKeywordsBatch 部分批次失败时抛可读错误并带 partial', async () => {
    configure();
    const items = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      question: i === 8 ? '__MOCK_FAIL__' : '题目 ' + i,
      reference: '参考答案 ' + i
    }));
    const err = await expectReject(
      () => AI.completeKeywordsBatch(items),
      'HTTP',
      '批量部分失败'
    );
    assert(err.message.indexOf('第 2/2 批') >= 0, '错误消息应标明失败批次：' + err.message);
    assert(Array.isArray(err.partial), '错误上应带 partial');
    assertEqual(err.partial.length, 8, 'partial 应包含第一批已成功的 8 项');
  });

  await test('completeKeywordsBatch 空数组返回 []', async () => {
    configure();
    const results = await AI.completeKeywordsBatch([]);
    assertEqual(Array.isArray(results), true);
    assertEqual(results.length, 0);
  });

  /* ---------- generateQuestions ---------- */

  await test('generateQuestions 按 count 生成并归一化字段', async () => {
    configure();
    const result = await AI.generateQuestions({
      text: '主动学习强调主动回忆与总结，间隔重复有助于长期记忆。',
      count: 5,
      difficulty: 2,
      tags: '学习方法,记忆',
      instructions: '覆盖核心概念'
    });
    assertEqual(result.questions.length, 5);
    result.questions.forEach((question) => {
      assert(question.question.length > 0, 'question 不应为空');
      assert(question.answer.length > 0, 'answer 不应为空');
      assertEqual(question.difficulty, 2, '请求难度 2 应传递');
      assert(Array.isArray(question.tags), 'tags 应为数组');
      assertEqual(question.keywords.length, 3);
      assert(question.explanation.length > 0, 'explanation 不应为空');
    });
  });

  await test('generateQuestions 对越界数量 / 难度 / 重复关键词归一化', async () => {
    withBase(`${V1}/mock-overflow`);
    const result = await AI.generateQuestions({
      text: '材料',
      count: 3,
      difficulty: 0
    });
    assertEqual(result.questions.length, 3, '不应超过 count');
    result.questions.forEach((question) => {
      assert(
        question.difficulty >= 1 && question.difficulty <= 3,
        'difficulty 应限制在 1-3：' + question.difficulty
      );
      assertEqual(new Set(question.keywords.map(String)).size, question.keywords.length, '关键词应去重');
      assert(question.keywords.length <= 8, '关键词最多 8 个');
      assert(Array.isArray(question.tags), '字符串 tags 应转为数组');
      assertEqual(question.tags.length, 2);
    });
  });

  await test('generateQuestions count 上限 30', async () => {
    configure();
    const result = await AI.generateQuestions({ text: '材料', count: 99 });
    assertEqual(result.questions.length, 30);
  });

  await test('generateQuestions 缺少材料与主题抛 CONFIG', async () => {
    configure();
    await expectReject(() => AI.generateQuestions({}), 'CONFIG', '生成缺输入');
  });

  await test('generateQuestions 解析失败抛 PARSE', async () => {
    withBase(`${V1}/mock-bad-json`);
    await expectReject(
      () => AI.generateQuestions({ text: '材料', count: 3 }),
      'PARSE',
      '生成非 JSON'
    );
  });

  /* ---------- 错误码映射 ---------- */

  await test('HTTP 401 映射为 AUTH', async () => {
    await expectReject(() => reviewOn(`${V1}/mock-status-401`), 'AUTH', '401');
  });

  await test('HTTP 404 映射为 MODEL', async () => {
    await expectReject(() => reviewOn(`${V1}/mock-status-404`), 'MODEL', '404');
  });

  await test('HTTP 429 映射为 RATE', async () => {
    await expectReject(() => reviewOn(`${V1}/mock-status-429`), 'RATE', '429');
  });

  await test('HTTP 500 映射为 HTTP 且带状态码', async () => {
    const err = await expectReject(() => reviewOn(`${V1}/mock-status-500`), 'HTTP', '500');
    assert(err.message.indexOf('500') >= 0, '错误消息应带状态码');
  });

  await test('非法 URL 抛 CONFIG', async () => {
    withBase('not-a-url');
    await expectReject(
      () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: 'a' }),
      'CONFIG',
      '非法 URL'
    );
  });

  await test('空 baseUrl 抛 CONFIG', async () => {
    configure({ baseUrl: '' });
    await expectReject(
      () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: 'a' }),
      'CONFIG',
      '空 baseUrl'
    );
  });

  await test('未启用时调用抛 CONFIG', async () => {
    configure({ enabled: false });
    const err = await expectReject(
      () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: 'a' }),
      'CONFIG',
      '未启用'
    );
    assert(err.message.indexOf('未启用') >= 0, '提示应说明未启用：' + err.message);
  });

  await test('网络失败映射为 NETWORK', async () => {
    configure({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 3000 });
    await expectReject(
      () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: 'a' }),
      'NETWORK',
      '网络失败'
    );
  });

  await test('超时映射为 TIMEOUT（AbortController 生效）', async () => {
    configure({ timeoutMs: 200 });
    const realFetch = currentFetch;
    currentFetch = hangingFetch;
    const startedAt = Date.now();
    try {
      const err = await expectReject(
        () => AI.reviewAnswer({ question: 'q', reference: 'r', userAnswer: 'a' }),
        'TIMEOUT',
        '请求超时'
      );
      const elapsed = Date.now() - startedAt;
      assert(elapsed < 3000, '超时应快速触发，实际耗时 ' + elapsed + 'ms');
      assert(err.message.indexOf('超时') >= 0, '提示应说明超时');
    } finally {
      currentFetch = realFetch;
    }
  });

  /* ---------- mock 协议 ---------- */

  await test('mock OPTIONS 返回 204 与 CORS *', async () => {
    const res = await fetch(`${V1}/chat/completions`, { method: 'OPTIONS' });
    assertEqual(res.status, 204);
    assertEqual(res.headers.get('access-control-allow-origin'), '*');
    assert((res.headers.get('access-control-allow-methods') || '').indexOf('POST') >= 0);
  });

  await test('mock x-mock-status 返回指定状态码', async () => {
    const res = await fetch(`${V1}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mock-status': '429' },
      body: JSON.stringify({ messages: [{ role: 'system', content: '[TASK:PING]' }] })
    });
    assertEqual(res.status, 429);
    const body = await res.json();
    assert(body && body.error && body.error.message, '应返回 error.message');
  });

  await test('mock x-mock-bad-json 返回非 JSON 的 assistant content', async () => {
    const res = await fetch(`${V1}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mock-bad-json': '1' },
      body: JSON.stringify({ messages: [{ role: 'system', content: '[TASK:REVIEW]' }] })
    });
    assertEqual(res.status, 200);
    const body = await res.json();
    const content = body.choices[0].message.content;
    let parsed = false;
    try {
      JSON.parse(content);
      parsed = true;
    } catch {
      parsed = false;
    }
    assertEqual(parsed, false, 'content 应不是合法 JSON');
  });

  await test('mock 未知路径返回 404，GET 返回 405', async () => {
    const notFound = await fetch(`${BASE}/v1/unknown`, { method: 'POST' });
    assertEqual(notFound.status, 404);
    const wrongMethod = await fetch(`${V1}/chat/completions`, { method: 'GET' });
    assertEqual(wrongMethod.status, 405);
  });

  await test('mock 端口被占用时以非 0 退出', async () => {
    const second = spawn(process.execPath, [MOCK_PATH, '--port', String(PORT)], {
      stdio: 'ignore',
      windowsHide: true
    });
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          second.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        reject(new Error('第二个 mock 未在 5 秒内退出'));
      }, 5000);
      second.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      second.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    assertEqual(exitCode, 1, '端口占用时退出码应为 1');
  });

  /* ---------- 安全 ---------- */

  await test('console 不打印 API Key', () => {
    const leaked = logs.some((line) => String(line).indexOf(KEY) >= 0 || String(line).indexOf('sk-test-secret') >= 0);
    assertEqual(leaked, false, 'console 输出不应包含 API Key');
  });
}

/* ------------------------------ 主流程 ------------------------------ */

try {
  await startMock();
  await runTests();
} catch (err) {
  failed.push({ name: '运行环境', error: err });
  console.log('FAIL 运行环境 -> ' + (err && err.message ? err.message : String(err)));
} finally {
  await stopMock();
}

console.log('');
console.log(`${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('失败用例：');
  failed.forEach((item) => {
    console.log('  - ' + item.name + '：' + (item.error && item.error.message ? item.error.message : item.error));
  });
  process.exitCode = 1;
}
