#!/usr/bin/env node
/* =========================================================================
   拾分 · AI mock 服务（仅测试用，零依赖）
   -------------------------------------------------------------------------
   启动：
     node tests/mock-ai-server.mjs --port 18765
   接口：
     OPTIONS *                        -> 204 + CORS
     POST   /v1/chat/completions      -> OpenAI 兼容响应
   任务识别（读取 system prompt 中的标记）：
     [TASK:PING]            -> content 为 OK
     [TASK:REVIEW]          -> 固定点评 JSON（score 76）
     [TASK:KEYWORDS]        -> 固定 4 个关键词
     [TASK:KEYWORDS_BATCH]  -> 按 user 消息中的 items 每项返回 3 个关键词
     [TASK:GENERATE]        -> 按 count 返回题目
   错误 / 特殊模式：
     x-mock-status: 401     指定 HTTP 状态码
     x-mock-bad-json: 1     HTTP 200，但 assistant content 不是 JSON
     x-mock-delay: 1500     延迟指定毫秒再响应
     x-mock-overflow: 1     返回越界数据（score 150 / 10 个关键词 / 更多题且难度 9），
                            用于验证服务层归一化
   路径模式（服务层调用无法自定义请求头时使用）：
     /mock-status-401/chat/completions
     /mock-bad-json/chat/completions
     /mock-overflow/chat/completions
     /mock-delay-1500/chat/completions
     /mock-require-auth/chat/completions  缺少 Authorization 时返回 401
   其他测试钩子：
     请求体中出现 __MOCK_FAIL__ -> 返回 500（用于批量部分失败用例）
   ========================================================================= */

import http from 'node:http';

const DEFAULT_PORT = 18765;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DELAY_MS = 60000;

/* ------------------------------ 参数与工具 ------------------------------ */

function readPort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') return Number(argv[i + 1]);
    if (arg.startsWith('--port=')) return Number(arg.slice('--port='.length));
  }
  return DEFAULT_PORT;
}

function parseIntHeader(value) {
  if (typeof value !== 'string') return null;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 2MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-mock-status, x-mock-bad-json, x-mock-delay, x-mock-overflow'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  setCors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendChat(res, content) {
  sendJson(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 16, completion_tokens: 32, total_tokens: 48 }
  });
}

function decodeUserJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------ 响应内容 ------------------------------ */

const REVIEW_JSON = {
  score: 76,
  verdict: '基本掌握',
  matchedPoints: ['覆盖了主动学习的定义', '提到间隔重复有助于长期记忆'],
  missedPoints: ['未说明自我测试的作用', '缺少可执行的学习计划'],
  summary: '答案抓住了主要概念，但遗漏了两个关键点，表述可以更具体。',
  suggestions: ['补充自我测试对记忆的作用', '给出可执行的学习计划', '用例子说明间隔重复'],
  improvedAnswer:
    '主动学习强调学习者在阅读后主动回忆、提问与总结，而不是被动重读。间隔重复把复习分散到多天进行，能在遗忘发生前强化记忆。自我测试通过提取练习检验掌握程度，并暴露薄弱点。三者结合时，应制定具体计划：学完一节先合上材料复述要点，隔天与一周后各做一次自测，根据错题调整复习间隔。'
};

const REVIEW_OVERFLOW_JSON = {
  score: 150,
  verdict: '非常优秀',
  matchedPoints: [
    '要点一',
    '要点二',
    '要点三',
    '要点四',
    '要点五',
    '要点一',
    '要点二',
    '要点三',
    '要点四',
    '要点五'
  ],
  missedPoints: ['遗漏一', '遗漏二', '遗漏三', '遗漏四'],
  summary: '越界测试用点评。',
  suggestions: ['建议一', '建议二', '建议三', '建议四', '建议五'],
  improvedAnswer: '越界测试用改进答案。'
};

const KEYWORDS_NORMAL = ['主动学习', '间隔重复', '自我测试', '记忆保持率'];
const KEYWORDS_OVERFLOW = [
  '主动学习',
  '间隔重复',
  '自我测试',
  '记忆保持率',
  '主动学习',
  '间隔重复',
  '刻意练习',
  '反馈',
  '迁移',
  '复习计划'
];

function reviewContent(overflow) {
  const data = overflow ? REVIEW_OVERFLOW_JSON : REVIEW_JSON;
  // 故意加前后说明 + 代码围栏，验证服务层能容忍。
  return '下面是对这道题的点评结果：\n```json\n' + JSON.stringify(data, null, 2) + '\n```\n以上仅供参考。';
}

function keywordsContent(overflow) {
  const data = { keywords: overflow ? KEYWORDS_OVERFLOW : KEYWORDS_NORMAL };
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

function batchKeywordsContent(userText, overflow) {
  const payload = decodeUserJson(userText) || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const result = items.map((item, position) => {
    const index =
      item && Object.prototype.hasOwnProperty.call(item, 'index') ? item.index : position;
    // 关键词里带上 index，方便测试确认「结果没有串题 / 没丢 index」。
    if (overflow) {
      return {
        index,
        keywords: ['重复关键词', '重复关键词', '要点' + index + '甲', '要点' + index + '乙']
      };
    }
    return {
      index,
      keywords: ['要点' + index + '甲', '要点' + index + '乙', '要点' + index + '丙']
    };
  });
  return '```json\n' + JSON.stringify({ items: result }, null, 2) + '\n```';
}

function generateContent(userText, overflow) {
  const payload = decodeUserJson(userText) || {};
  let count = Number(payload.count);
  if (!Number.isFinite(count) || count < 1) count = 3;
  count = Math.min(30, Math.floor(count));
  if (overflow) count = Math.min(30, count + 2);

  const requestedDifficulty = Number(payload.difficulty);
  const questions = [];
  for (let i = 0; i < count; i += 1) {
    const difficulty = overflow
      ? 9
      : requestedDifficulty >= 1 && requestedDifficulty <= 3
        ? requestedDifficulty
        : (i % 3) + 1;
    questions.push({
      question: '模拟题目 ' + (i + 1) + '：请简述材料中的核心概念及其作用。',
      answer:
        '这是第 ' +
        (i + 1) +
        ' 道模拟题目的参考答案。它覆盖了材料中的核心概念、基本原理和实际应用，并说明不同条件之间的关系：概念界定了问题范围，原理解释了因果机制，应用则把原理落到具体场景中。学习者可据此对照自查，检查自己是否遗漏了关键环节。',
      keywords: overflow
        ? ['重复关键词', '重复关键词', '概念' + (i + 1), '要点' + (i + 1)]
        : ['概念' + (i + 1), '原理' + (i + 1), '应用' + (i + 1)],
      explanation: '解析 ' + (i + 1) + '：围绕材料中的核心概念、原理与应用展开。',
      tags: overflow ? '标签A、标签B' : ['AI 生成', '模拟题'],
      difficulty
    });
  }
  return '```json\n' + JSON.stringify({ questions }, null, 2) + '\n```';
}

/* ------------------------------ 路径模式 ------------------------------ */

function parsePathModes(pathname) {
  const modes = {
    status: null,
    badJson: false,
    delayMs: 0,
    overflow: false,
    requireAuth: false
  };
  const statusMatch = /\/mock-status-(\d{3})(?:\/|$)/.exec(pathname);
  if (statusMatch) modes.status = Number(statusMatch[1]);
  if (/\/mock-bad-json(?:\/|$)/.test(pathname)) modes.badJson = true;
  const delayMatch = /\/mock-delay-(\d+)(?:\/|$)/.exec(pathname);
  if (delayMatch) modes.delayMs = Number(delayMatch[1]);
  if (/\/mock-overflow(?:\/|$)/.test(pathname)) modes.overflow = true;
  if (/\/mock-require-auth(?:\/|$)/.test(pathname)) modes.requireAuth = true;
  return modes;
}

/* ------------------------------ 请求处理 ------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleChat(req, res, pathname) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: err.message, type: 'mock_bad_request' } });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'mock_bad_request' } });
    return;
  }

  const modes = parsePathModes(pathname);
  const headerStatus = parseIntHeader(req.headers['x-mock-status']);
  if (headerStatus && headerStatus >= 100 && headerStatus <= 599) modes.status = headerStatus;
  if (String(req.headers['x-mock-bad-json'] || '') === '1') modes.badJson = true;
  if (String(req.headers['x-mock-overflow'] || '') === '1') modes.overflow = true;
  const headerDelay = parseIntHeader(req.headers['x-mock-delay']);
  if (headerDelay && headerDelay > 0) modes.delayMs = Math.min(headerDelay, MAX_DELAY_MS);

  if (modes.delayMs > 0) {
    await sleep(modes.delayMs);
  }

  if (modes.status) {
    sendJson(res, modes.status, {
      error: {
        message: 'mock 模拟错误状态 ' + modes.status,
        type: 'mock_error',
        code: 'mock_' + modes.status
      }
    });
    return;
  }

  if (modes.requireAuth) {
    const authorization = req.headers.authorization || '';
    if (!/^Bearer\s+\S+/i.test(authorization)) {
      sendJson(res, 401, {
        error: { message: 'mock 要求 Authorization: Bearer <key>', type: 'mock_auth' }
      });
      return;
    }
  }

  if (modes.badJson) {
    sendChat(res, '抱歉，这次模型没有按 JSON 输出，只是一段普通文本。');
    return;
  }

  if (raw.includes('__MOCK_FAIL__')) {
    sendJson(res, 500, {
      error: { message: 'mock 模拟服务端失败（__MOCK_FAIL__）', type: 'mock_error' }
    });
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemText = messages
    .filter((message) => message && message.role === 'system')
    .map((message) => contentToText(message.content))
    .join('\n');
  const userMessages = messages.filter((message) => message && message.role === 'user');
  const userText = contentToText(userMessages.length ? userMessages[userMessages.length - 1].content : '');

  if (systemText.includes('[TASK:KEYWORDS_BATCH]')) {
    sendChat(res, batchKeywordsContent(userText, modes.overflow));
    return;
  }
  if (systemText.includes('[TASK:KEYWORDS]')) {
    sendChat(res, keywordsContent(modes.overflow));
    return;
  }
  if (systemText.includes('[TASK:REVIEW]')) {
    sendChat(res, reviewContent(modes.overflow));
    return;
  }
  if (systemText.includes('[TASK:GENERATE]')) {
    sendChat(res, generateContent(userText, modes.overflow));
    return;
  }
  if (systemText.includes('[TASK:PING]')) {
    sendChat(res, 'OK');
    return;
  }

  sendChat(res, '未识别的任务标记；请检查 system prompt 是否包含 [TASK:*]。');
}

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      return req.url || '/';
    }
  })();

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (!pathname.endsWith('/chat/completions')) {
    sendJson(res, 404, {
      error: { message: 'mock 仅支持 POST /v1/chat/completions', path: pathname }
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'mock 仅支持 POST', method: req.method } });
    return;
  }

  handleChat(req, res, pathname).catch((err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, {
      error: { message: 'mock 内部错误：' + (err && err.message ? err.message : '未知错误') }
    });
  });
});

const port = readPort(process.argv.slice(2));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[mock-ai] 端口参数不合法：' + port + '。用法：node tests/mock-ai-server.mjs --port 18765');
  process.exit(2);
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[mock-ai] 启动失败：端口 ' + port + ' 已被占用。请换一个端口：node tests/mock-ai-server.mjs --port 18766');
  } else {
    console.error('[mock-ai] 启动失败：' + (err && err.message ? err.message : String(err)));
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log('[mock-ai] listening on http://127.0.0.1:' + port);
  console.log('[mock-ai] endpoint: http://127.0.0.1:' + port + '/v1/chat/completions');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
