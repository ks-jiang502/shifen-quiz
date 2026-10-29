/* =========================================================================
   拾分 · AI 服务层（window.ShifenAI）
   -------------------------------------------------------------------------
   - 纯原生 IIFE，零依赖，不操作 DOM，不读取 / 写入 localStorage。
   - 只负责「调用 OpenAI 兼容接口 + 解析 + 归一化」，配置由 app 保存与传入。
   - 支持的接口：POST {baseUrl}/chat/completions
   - 错误统一为带 code 的 Error，code 取值：
     CONFIG / AUTH / MODEL / RATE / NETWORK / TIMEOUT / HTTP / PARSE
   - 不会把 apiKey 打印到 console，也不会放进错误消息。
   ========================================================================= */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------
     0. 环境与常量
     ---------------------------------------------------------------------- */

  var hasWindow = typeof window !== 'undefined';
  var globalScope =
    (typeof globalThis !== 'undefined' && globalThis) ||
    (hasWindow ? window : null) ||
    (typeof self !== 'undefined' ? self : null) ||
    {};

  var VERSION = '1.0.0';

  var PRESETS = {
    deepseek: {
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      requiresKey: true
    },
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      requiresKey: true
    },
    ollama: {
      label: 'Ollama（本地）',
      // 用 127.0.0.1 而不是 localhost，避免部分浏览器优先解析到 IPv6 ::1 导致连不上。
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      requiresKey: false
    },
    custom: {
      label: '自定义代理',
      baseUrl: '',
      model: '',
      requiresKey: false
    }
  };

  // 对 PRESETS 做只读保护，避免业务代码误改预设。
  Object.keys(PRESETS).forEach(function (key) {
    Object.freeze(PRESETS[key]);
  });
  Object.freeze(PRESETS);

  var VERDICTS = ['掌握', '基本掌握', '还需巩固', '未掌握'];
  var PROVIDER_KEYS = Object.keys(PRESETS);
  var MAX_KEYWORDS = 8;
  var MAX_QUESTIONS = 30;
  var BATCH_SIZE = 8;
  var MAX_TEXT_CHARS = 30000; // 生成题时发送的材料上限，避免一次请求过大

  // 默认超时（毫秒），契约：点评/关键词 45s，批量 60s，生成 120s。
  var TIMEOUTS = {
    ping: 15000,
    review: 45000,
    keywords: 45000,
    batch: 60000,
    generate: 120000
  };

  // 最大输出 token（仅作为请求参数，兼容各家实现）。
  var MAX_TOKENS = {
    ping: 8,
    review: 1000,
    keywords: 400,
    batch: 1600,
    generate: 4096
  };

  // 契约中的默认设置（app 首次加载可参考）。
  var DEFAULT_CONFIG = {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.3
  };

  /* ----------------------------------------------------------------------
     1. 通用小工具
     ---------------------------------------------------------------------- */

  function now() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function toStr(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && isFinite(value)) return String(value);
    return '';
  }

  function clampNumber(value, min, max, fallback) {
    var num = typeof value === 'number' ? value : parseFloat(String(value));
    if (!isFinite(num)) num = fallback;
    num = Math.round(num);
    if (num < min) num = min;
    if (num > max) num = max;
    return num;
  }

  function summarize(text, max) {
    var str = String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim();
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function splitTokens(value, allowWhitespace) {
    var str = toStr(value);
    if (!str) return [];
    var re = allowWhitespace
      ? /[,，、;；|\r\n\t ]+/
      : /[,，、;；|\r\n]+/;
    return str
      .split(re)
      .map(function (item) {
        return item.trim();
      })
      .filter(Boolean);
  }

  function uniqueStrings(list, max) {
    var out = [];
    var seen = {};
    var limit = typeof max === 'number' ? max : Infinity;
    for (var i = 0; i < list.length; i += 1) {
      var str = toStr(list[i]);
      if (!str) continue;
      var key = str.replace(/\s+/g, '').toLowerCase();
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push(str);
      if (out.length >= limit) break;
    }
    return out;
  }

  // 把数组 / 字符串 / 换行分隔文本统一成去重后的字符串数组
  function normalizeStringList(value, max) {
    var list;
    if (Array.isArray(value)) {
      list = value;
    } else if (typeof value === 'string') {
      list = splitTokens(value, false);
    } else {
      list = [];
    }
    return uniqueStrings(list, max);
  }

  function normalizeKeywordList(value, max) {
    var list;
    if (Array.isArray(value)) {
      list = value;
    } else if (typeof value === 'string') {
      list = splitTokens(value, false);
    } else {
      list = [];
    }
    return uniqueStrings(list, typeof max === 'number' ? max : MAX_KEYWORDS);
  }

  function normalizeTagList(value) {
    var list;
    if (Array.isArray(value)) {
      list = value;
    } else if (typeof value === 'string') {
      list = splitTokens(value, true);
    } else {
      list = [];
    }
    return uniqueStrings(list, MAX_KEYWORDS);
  }

  /* ----------------------------------------------------------------------
     2. 错误对象：统一带 code，message 一律中文
     ---------------------------------------------------------------------- */

  function aiError(code, message, extra) {
    var err = new Error(message);
    err.name = 'ShifenAIError';
    err.code = code || 'HTTP';
    if (isPlainObject(extra)) {
      Object.keys(extra).forEach(function (key) {
        err[key] = extra[key];
      });
    }
    return err;
  }

  function detailSuffix(detail) {
    return detail ? ' 服务返回：' + detail : '';
  }

  function httpError(status, bodyText) {
    var detail = summarize(bodyText, 200);
    if (status === 401 || status === 403) {
      return aiError(
        'AUTH',
        '鉴权失败（HTTP ' + status + '）：请检查 API Key 是否正确、是否过期，或该 Key 是否有调用权限。' +
          detailSuffix(detail),
        { status: status }
      );
    }
    if (status === 404) {
      return aiError(
        'MODEL',
        '模型或接口不存在（HTTP 404）：请检查 Base URL（通常以 /v1 结尾）和模型名称是否正确。' +
          detailSuffix(detail),
        { status: status }
      );
    }
    if (status === 429) {
      return aiError(
        'RATE',
        '请求过于频繁或额度不足（HTTP 429）：请稍后重试，或检查账户余额与限流设置。' +
          detailSuffix(detail),
        { status: status }
      );
    }
    return aiError(
      'HTTP',
      '接口返回异常状态（HTTP ' + status + '）：' + (detail || '响应内容为空'),
      { status: status }
    );
  }

  /* ----------------------------------------------------------------------
     3. 配置
     ---------------------------------------------------------------------- */

  function normalizeBaseUrl(value) {
    return toStr(value).replace(/\/+$/, '');
  }

  function normalizeProvider(value, fallback) {
    var provider = toStr(value).toLowerCase();
    if (!provider) return fallback;
    return PRESETS[provider] ? provider : 'custom';
  }

  /**
   * 合并并规范化配置。
   * @param {Object} input  用户传入的增量配置
   * @param {Object} base   作为基准的旧配置
   */
  function normalizeConfig(input, base) {
    var patch = isPlainObject(input) ? input : {};
    var prev = base || DEFAULT_CONFIG;

    var provider = hasOwn(patch, 'provider')
      ? normalizeProvider(patch.provider, 'custom')
      : normalizeProvider(prev.provider, 'deepseek');
    var providerChanged = provider !== prev.provider;
    var preset = PRESETS[provider] || PRESETS.custom;

    // 切换服务商且没有显式给出地址/模型时，自动带入预设。
    var baseUrl = hasOwn(patch, 'baseUrl')
      ? normalizeBaseUrl(patch.baseUrl)
      : providerChanged
        ? preset.baseUrl
        : normalizeBaseUrl(prev.baseUrl);
    var model = hasOwn(patch, 'model')
      ? toStr(patch.model)
      : providerChanged
        ? preset.model
        : toStr(prev.model);

    var temperature = hasOwn(patch, 'temperature')
      ? Number(patch.temperature)
      : Number(prev.temperature);
    if (!isFinite(temperature)) temperature = 0.3;
    temperature = Math.min(2, Math.max(0, temperature));

    var config = {
      enabled: hasOwn(patch, 'enabled') ? !!patch.enabled : !!prev.enabled,
      provider: provider,
      baseUrl: baseUrl,
      model: model,
      apiKey: hasOwn(patch, 'apiKey') ? toStr(patch.apiKey) : toStr(prev.apiKey),
      temperature: temperature
    };

    // timeoutMs 是调试用扩展：未显式给出时恢复默认，不随 merge 残留。
    if (hasOwn(patch, 'timeoutMs')) {
      var timeout = Number(patch.timeoutMs);
      if (isFinite(timeout) && timeout >= 50) {
        config.timeoutMs = Math.round(timeout);
      }
    }

    return config;
  }

  var currentConfig = normalizeConfig(DEFAULT_CONFIG, DEFAULT_CONFIG);

  function cloneConfig(config) {
    var copy = {
      enabled: config.enabled,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      temperature: config.temperature
    };
    if (typeof config.timeoutMs === 'number') copy.timeoutMs = config.timeoutMs;
    return copy;
  }

  function resolveConfig(override) {
    if (!override) return cloneConfig(currentConfig);
    return normalizeConfig(override, currentConfig);
  }

  function providerRequiresKey(provider) {
    var preset = PRESETS[provider];
    return !!(preset && preset.requiresKey);
  }

  function isHttpUrl(url) {
    var str = toStr(url);
    if (!str) return false;
    if (typeof URL === 'function') {
      try {
        var parsed = new URL(str);
        return /^https?:$/.test(parsed.protocol) && !!parsed.host;
      } catch (err) {
        return false;
      }
    }
    return /^https?:\/\/[^\s]+$/i.test(str);
  }

  function ensureConnectionConfig(config) {
    if (!config.baseUrl) {
      throw aiError('CONFIG', '尚未配置 Base URL：请填写 OpenAI 兼容接口地址（例如 https://api.deepseek.com/v1）。');
    }
    if (!isHttpUrl(config.baseUrl)) {
      throw aiError('CONFIG', 'Base URL 格式不正确：请填写以 http:// 或 https:// 开头的完整地址，例如 https://api.openai.com/v1。');
    }
    if (!config.model) {
      throw aiError('CONFIG', '尚未配置模型名称：请填写服务商提供的模型 ID（例如 deepseek-chat、gpt-4o-mini）。');
    }
    if (providerRequiresKey(config.provider) && !config.apiKey) {
      throw aiError('CONFIG', '缺少 API Key：当前服务商需要鉴权，请先填写有效的 Key。');
    }
    return config;
  }

  function ensureReady(config) {
    if (!config.enabled) {
      throw aiError('CONFIG', 'AI 功能尚未启用：请先在「设置 → AI 服务」中启用并保存配置。');
    }
    return ensureConnectionConfig(config);
  }

  /* ----------------------------------------------------------------------
     4. HTTP 调用
     ---------------------------------------------------------------------- */

  function getFetch() {
    if (globalScope && typeof globalScope.fetch === 'function') {
      return function (url, options) {
        return globalScope.fetch(url, options);
      };
    }
    if (typeof fetch === 'function') {
      return function (url, options) {
        return fetch(url, options);
      };
    }
    return null;
  }

  function getAbortController() {
    if (globalScope && typeof globalScope.AbortController === 'function') {
      return globalScope.AbortController;
    }
    if (typeof AbortController === 'function') return AbortController;
    return null;
  }

  function endpointOf(baseUrl) {
    return normalizeBaseUrl(baseUrl) + '/chat/completions';
  }

  function buildHeaders(config) {
    var headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
    return headers;
  }

  function timeoutFor(config, task) {
    if (config && typeof config.timeoutMs === 'number') return config.timeoutMs;
    return TIMEOUTS[task] || TIMEOUTS.review;
  }

  function extractMessageContent(data) {
    if (!data || typeof data !== 'object') return null;
    var choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) return null;
    var message = choice.message || choice.delta || null;
    var content = message ? message.content : choice.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i += 1) {
        var part = content[i];
        if (typeof part === 'string') {
          parts.push(part);
        } else if (part && typeof part.text === 'string') {
          parts.push(part.text);
        } else if (part && typeof part.content === 'string') {
          parts.push(part.content);
        }
      }
      return parts.join('');
    }
    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }
    return null;
  }

  /**
   * 发一次 chat/completions 请求。
   * @returns {Promise<{content:string, latency:number, model:string, raw:Object}>}
   */
  async function requestChat(config, messages, task, maxTokens) {
    var fetchFn = getFetch();
    if (!fetchFn) {
      throw aiError('CONFIG', '当前环境不支持 fetch，无法调用 AI 服务。');
    }
    var AbortCtl = getAbortController();
    if (!AbortCtl) {
      throw aiError('CONFIG', '当前环境不支持 AbortController，无法安全地设置请求超时。');
    }

    var timeoutMs = timeoutFor(config, task);
    var controller = new AbortCtl();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      try {
        controller.abort();
      } catch (err) {
        /* 忽略 abort 自身异常 */
      }
    }, timeoutMs);

    var startedAt = now();
    var response = null;
    var bodyText = '';

    var body = {
      model: config.model,
      messages: messages,
      temperature: config.temperature,
      max_tokens: maxTokens || MAX_TOKENS[task] || 1000,
      stream: false
    };

    try {
      response = await fetchFn(endpointOf(config.baseUrl), {
        method: 'POST',
        headers: buildHeaders(config),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      bodyText = await response.text();
    } catch (err) {
      if (timedOut) {
        throw aiError(
          'TIMEOUT',
          '请求超时（超过 ' + Math.max(1, Math.round(timeoutMs / 1000)) + ' 秒）：模型响应较慢或网络不稳定，请重试或换用更快的模型。'
        );
      }
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw aiError('TIMEOUT', '请求已超时并被中止：请重试，或检查网络与接口响应速度。');
      }
      throw aiError(
        'NETWORK',
        '网络请求失败：请检查网络连接；浏览器直连第三方接口可能被 CORS 拦截；' +
          '使用本地 Ollama 时请确认服务已启动，并设置 OLLAMA_ORIGINS=*。' +
          (err && err.message ? '（' + summarize(err.message, 160) + '）' : '')
      );
    } finally {
      clearTimeout(timer);
    }

    var latency = Math.max(0, now() - startedAt);

    if (!response.ok) {
      throw httpError(response.status, bodyText);
    }

    var data;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      throw aiError(
        'PARSE',
        '接口返回的不是合法 JSON（HTTP ' + response.status + '）：' + (summarize(bodyText, 120) || '空响应')
      );
    }

    var content = extractMessageContent(data);
    if (content === null || typeof content === 'undefined') {
      throw aiError(
        'PARSE',
        '接口响应缺少 choices[0].message.content：' + (summarize(bodyText, 120) || '空响应')
      );
    }

    return {
      content: content,
      latency: latency,
      model: toStr(data.model) || config.model,
      raw: data
    };
  }

  /* ----------------------------------------------------------------------
     5. 模型输出 JSON 解析（容忍代码围栏 / 前后说明）
     ---------------------------------------------------------------------- */

  function parseModelJson(content) {
    if (content && typeof content === 'object') return content;

    var text = toStr(content);
    if (!text) throw aiError('PARSE', '模型返回内容为空，无法解析为 JSON。');

    var candidates = [text];
    var fenceRe = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
    var match;
    while ((match = fenceRe.exec(text)) !== null) {
      var fenced = (match[1] || '').trim();
      if (fenced) candidates.push(fenced);
    }

    var braceStart = text.indexOf('{');
    var braceEnd = text.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      candidates.push(text.slice(braceStart, braceEnd + 1));
    }

    var bracketStart = text.indexOf('[');
    var bracketEnd = text.lastIndexOf(']');
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
      candidates.push(text.slice(bracketStart, bracketEnd + 1));
    }

    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i].trim();
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch (err) {
        /* 尝试下一个候选片段 */
      }
    }

    throw aiError('PARSE', '无法解析模型返回的 JSON：' + summarize(text, 160));
  }

  /* ----------------------------------------------------------------------
     6. Prompt（system prompt 必须包含固定任务标记）
     ---------------------------------------------------------------------- */

  var JSON_ONLY_HINT =
    '用户消息是 JSON 数据。最终只输出一个 JSON 对象（可以放在 ```json 代码块里），不要输出额外说明。';

  function reviewSystemPrompt() {
    return (
      '你是「拾分」学习应用里的简答题点评助手。只根据用户消息中提供的内容作答，不编造材料之外的事实。\n' +
      '任务标记：[TASK:REVIEW]\n' +
      '任务：以参考答案为准，点评用户对一道简答题的回答。\n' +
      '要求：\n' +
      '1. matchedPoints 写用户答案已覆盖的要点，missedPoints 写遗漏的要点；表述不同不直接判错。\n' +
      '2. score 是 0-100 的覆盖度估计，不是考试分数。\n' +
      '3. verdict 只能是「掌握」「基本掌握」「还需巩固」「未掌握」之一。\n' +
      '4. suggestions 给出 2-4 条可执行的改进建议；improvedAnswer 给出更完整的参考答案（不超过 300 字）。\n' +
      JSON_ONLY_HINT +
      '\n输出示例：{"score":76,"verdict":"基本掌握","matchedPoints":["..."],"missedPoints":["..."],"summary":"...","suggestions":["..."],"improvedAnswer":"..."}'
    );
  }

  function keywordsSystemPrompt() {
    return (
      '你是「拾分」学习应用里的关键词提取助手。只根据用户消息中提供的内容作答。\n' +
      '任务标记：[TASK:KEYWORDS]\n' +
      '任务：从参考答案中提取可用于自检的核心术语 / 要点关键词。\n' +
      '要求：3-8 个；每个不超过 16 字；不要整句；排除「因为、所以、重要、方法、内容」等泛词；不要与已有关键词重复；按重要性排序。\n' +
      JSON_ONLY_HINT +
      '\n输出示例：{"keywords":["关键词1","关键词2"]}'
    );
  }

  function batchKeywordsSystemPrompt() {
    return (
      '你是「拾分」学习应用里的关键词提取助手。只根据用户消息中提供的内容作答。\n' +
      '任务标记：[TASK:KEYWORDS_BATCH]\n' +
      '任务：用户消息 JSON 里的 items 是多道简答题，请为每一道题分别提取关键词。\n' +
      '要求：每项 3-6 个关键词（最多 8 个）；每个不超过 16 字；不要整句；不要与该项的 existingKeywords 重复。\n' +
      '必须原样保留每一项的 index，不能遗漏任何一项，也不要新增题目。\n' +
      JSON_ONLY_HINT +
      '\n输出示例：{"items":[{"index":0,"keywords":["关键词1","关键词2"]}]}'
    );
  }

  function generateSystemPrompt() {
    return (
      '你是「拾分」学习应用里的出题助手。只根据用户消息中的材料或主题出题，不编造材料之外的事实。\n' +
      '任务标记：[TASK:GENERATE]\n' +
      '任务：根据 text（材料）或 topic（主题）生成简答题。\n' +
      '要求：覆盖核心概念；题目清晰可作答；答案 80-220 字；每道题关键词 3-6 个；' +
      '给出解析 explanation、标签 tags（数组）、难度 difficulty（1=基础，2=中等，3=挑战）；' +
      '生成最多 count 道题，count 缺失或为 0 时最多生成 10 道。\n' +
      JSON_ONLY_HINT +
      '\n输出示例：{"questions":[{"question":"...","answer":"...","keywords":["..."],"explanation":"...","tags":["..."],"difficulty":2}]}'
    );
  }

  function pingSystemPrompt() {
    return (
      '你是「拾分」学习应用的连接测试助手。\n' +
      '任务标记：[TASK:PING]\n' +
      '这是一次连接测试：请只回复 OK 两个字符，不要输出其他任何内容。'
    );
  }

  /* ----------------------------------------------------------------------
     7. 输出归一化
     ---------------------------------------------------------------------- */

  function normalizeVerdict(value, score) {
    var str = toStr(value);
    if (VERDICTS.indexOf(str) >= 0) return str;
    if (str) {
      if (str.indexOf('未') >= 0) return '未掌握';
      if (str.indexOf('基本') >= 0) return '基本掌握';
      if (str.indexOf('巩固') >= 0 || str.indexOf('还需') >= 0) return '还需巩固';
      if (str.indexOf('掌握') >= 0) return '掌握';
    }
    // 与 app.js 的 verdictForScore 保持同一套兜底阈值。
    if (score >= 85) return '掌握';
    if (score >= 65) return '基本掌握';
    if (score >= 40) return '还需巩固';
    return '未掌握';
  }

  function normalizeReview(raw, config) {
    if (!isPlainObject(raw)) {
      throw aiError('PARSE', '模型返回的点评结果不是 JSON 对象。');
    }
    var score = clampNumber(raw.score, 0, 100, 0);
    var matchedPoints = normalizeStringList(
      raw.matchedPoints || raw.matched || raw.hitPoints || raw.hits,
      16
    );
    var missedPoints = normalizeStringList(
      raw.missedPoints || raw.missed || raw.missPoints || raw.missing,
      16
    );
    var suggestions = normalizeStringList(raw.suggestions || raw.advice || raw.tips, 8);
    var summary = toStr(raw.summary || raw.comment || raw.overall);
    var improvedAnswer = toStr(raw.improvedAnswer || raw.improved || raw.betterAnswer);

    return {
      score: score,
      verdict: normalizeVerdict(raw.verdict, score),
      matchedPoints: matchedPoints,
      missedPoints: missedPoints,
      summary: summary,
      suggestions: suggestions,
      improvedAnswer: improvedAnswer,
      at: now(),
      model: config.model
    };
  }

  function normalizeQuestion(raw, fallbackDifficulty) {
    if (!isPlainObject(raw)) return null;
    var questionText = toStr(raw.question || raw.title || raw.q || raw.prompt);
    var answerText = toStr(raw.answer || raw.reference || raw.a);
    if (!questionText || !answerText) return null;
    return {
      question: questionText,
      answer: answerText,
      keywords: normalizeKeywordList(raw.keywords || raw.keyPoints, MAX_KEYWORDS),
      explanation: toStr(raw.explanation || raw.analysis || raw.parse),
      tags: normalizeTagList(raw.tags || raw.tag),
      difficulty: clampNumber(raw.difficulty, 1, 3, fallbackDifficulty)
    };
  }

  /* ----------------------------------------------------------------------
     8. 公开 API
     ---------------------------------------------------------------------- */

  var api = {
    version: VERSION,
    PRESETS: PRESETS,

    /** 合并并保存配置到模块内，返回规范化后的 config。 */
    configure: function (config) {
      currentConfig = normalizeConfig(config, currentConfig);
      return cloneConfig(currentConfig);
    },

    /** 返回当前配置的副本（不暴露内部引用）。 */
    getConfig: function () {
      return cloneConfig(currentConfig);
    },

    /**
     * 是否具备调用条件：enabled && baseUrl && model && (不需要 key 或已填 key)。
     * 传入 config 时只检查传入对象，不读写模块内配置。
     */
    isConfigured: function (config) {
      var target = isPlainObject(config) ? config : currentConfig;
      if (!target.enabled || !toStr(target.baseUrl) || !toStr(target.model)) return false;
      var provider = toStr(target.provider) || 'custom';
      if (providerRequiresKey(provider) && !toStr(target.apiKey)) return false;
      return true;
    },

    /**
     * 连接测试：发一条极短消息（不要求 JSON）。
     * 永不抛错，失败时返回 { ok:false, code, message, latency, model }。
     */
    testConnection: async function (configOverride) {
      var startedAt = now();
      var config = null;
      try {
        config = resolveConfig(configOverride);
        ensureConnectionConfig(config);
        var res = await requestChat(
          config,
          [
            { role: 'system', content: pingSystemPrompt() },
            { role: 'user', content: '连接测试，请只回复 OK' }
          ],
          'ping',
          MAX_TOKENS.ping
        );
        var message = toStr(res.content) || '连接成功';
        return {
          ok: true,
          latency: res.latency,
          model: res.model || config.model,
          message: message,
          at: now()
        };
      } catch (err) {
        return {
          ok: false,
          latency: Math.max(0, now() - startedAt),
          model: (config && config.model) || '',
          message: (err && err.message) || '连接失败',
          code: (err && err.code) || 'ERROR',
          at: now()
        };
      }
    },

    /** 单题点评。返回分值、覆盖/遗漏要点、建议与改进答案。 */
    reviewAnswer: async function (input) {
      var data = isPlainObject(input) ? input : {};
      var userAnswer = toStr(data.userAnswer);
      if (!userAnswer) {
        throw aiError('CONFIG', '请先填写你的答案，再进行 AI 点评。');
      }
      var config = currentConfig;
      ensureReady(config);

      var payload = {
        question: toStr(data.question),
        reference: toStr(data.reference),
        keywords: normalizeKeywordList(data.keywords, MAX_KEYWORDS),
        userAnswer: userAnswer
      };

      var res = await requestChat(
        config,
        [
          { role: 'system', content: reviewSystemPrompt() },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        'review',
        MAX_TOKENS.review
      );

      return normalizeReview(parseModelJson(res.content), config);
    },

    /** 从参考答案提取关键词，返回 { keywords }（最多 8 个、已去重）。 */
    extractKeywords: async function (input) {
      var data = isPlainObject(input) ? input : {};
      var question = toStr(data.question);
      var reference = toStr(data.reference);
      if (!reference && !question) {
        throw aiError('CONFIG', '缺少题目或参考答案，无法提取关键词。');
      }
      var config = currentConfig;
      ensureReady(config);

      var payload = {
        question: question,
        reference: reference,
        existingKeywords: normalizeKeywordList(data.existingKeywords, MAX_KEYWORDS)
      };

      var res = await requestChat(
        config,
        [
          { role: 'system', content: keywordsSystemPrompt() },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        'keywords',
        MAX_TOKENS.keywords
      );

      var raw = parseModelJson(res.content);
      var list = Array.isArray(raw)
        ? raw
        : isPlainObject(raw)
          ? raw.keywords || raw.items || raw.result
          : [];
      var keywords = normalizeKeywordList(list, MAX_KEYWORDS);
      if (!keywords.length) {
        throw aiError('PARSE', '模型没有返回可用的关键词。');
      }
      return { keywords: keywords };
    },

    /**
     * 批量补关键词：每 8 个一批调用，返回与输入顺序一致的 [{ index, keywords }]。
     * 任一批次失败时抛出可读错误，错误上带 partial（已成功的批次结果）。
     */
    completeKeywordsBatch: async function (items) {
      var list = Array.isArray(items) ? items : [];
      if (!list.length) return [];

      var config = currentConfig;
      ensureReady(config);

      var chunks = [];
      for (var i = 0; i < list.length; i += BATCH_SIZE) {
        chunks.push(list.slice(i, i + BATCH_SIZE));
      }

      var results = [];
      for (var b = 0; b < chunks.length; b += 1) {
        var chunk = chunks[b];
        var offset = b * BATCH_SIZE;
        var payloadItems = chunk.map(function (item, indexInChunk) {
          var source = isPlainObject(item) ? item : {};
          var idx = hasOwn(source, 'index') ? source.index : offset + indexInChunk;
          return {
            index: idx,
            question: toStr(source.question),
            reference: toStr(source.reference),
            existingKeywords: normalizeKeywordList(source.existingKeywords, MAX_KEYWORDS)
          };
        });

        try {
          var res = await requestChat(
            config,
            [
              { role: 'system', content: batchKeywordsSystemPrompt() },
              { role: 'user', content: JSON.stringify({ items: payloadItems }) }
            ],
            'batch',
            MAX_TOKENS.batch
          );

          var raw = parseModelJson(res.content);
          var entries = Array.isArray(raw)
            ? raw
            : isPlainObject(raw) && Array.isArray(raw.items)
              ? raw.items
              : null;
          if (!entries) {
            throw aiError('PARSE', '模型返回的批量关键词结果格式不正确（缺少 items 数组）。');
          }

          var used = {};
          var takeEntry = function (idx, position) {
            // 优先按 index 精确匹配，其次按位置回退，保证结果不丢题。
            for (var k = 0; k < entries.length; k += 1) {
              if (used[k]) continue;
              var entry = entries[k];
              var entryIndex = isPlainObject(entry) ? entry.index : undefined;
              if (typeof entryIndex !== 'undefined' && String(entryIndex) === String(idx)) {
                used[k] = true;
                return entry;
              }
            }
            if (position < entries.length && !used[position]) {
              used[position] = true;
              return entries[position];
            }
            for (var j = 0; j < entries.length; j += 1) {
              if (!used[j]) {
                used[j] = true;
                return entries[j];
              }
            }
            return null;
          };

          for (var p = 0; p < payloadItems.length; p += 1) {
            var payloadItem = payloadItems[p];
            var entry = takeEntry(payloadItem.index, p);
            var keywords;
            if (Array.isArray(entry)) {
              keywords = normalizeKeywordList(entry, MAX_KEYWORDS);
            } else if (isPlainObject(entry)) {
              keywords = normalizeKeywordList(entry.keywords || entry.words || entry.keyPoints, MAX_KEYWORDS);
            } else if (typeof entry === 'string') {
              keywords = normalizeKeywordList([entry], MAX_KEYWORDS);
            } else {
              keywords = [];
            }
            results.push({ index: payloadItem.index, keywords: keywords });
          }
        } catch (err) {
          var wrapped = aiError(
            err && err.code ? err.code : 'HTTP',
            '批量补全关键词失败（第 ' + (b + 1) + '/' + chunks.length + ' 批）：' +
              ((err && err.message) || '未知错误')
          );
          wrapped.partial = results.slice();
          throw wrapped;
        }
      }

      return results;
    },

    /** 根据材料 / 主题生成题目。 */
    generateQuestions: async function (input) {
      var data = isPlainObject(input) ? input : {};
      var text = toStr(data.text);
      var topic = toStr(data.topic);
      if (!text && !topic) {
        throw aiError('CONFIG', '请提供材料或主题后再生成题目。');
      }
      var config = currentConfig;
      ensureReady(config);

      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
      }

      var count = clampNumber(data.count, 1, MAX_QUESTIONS, 10);
      var difficulty = clampNumber(data.difficulty, 0, 3, 0);
      var tags = normalizeTagList(data.tags);
      var instructions = toStr(data.instructions).slice(0, 2000);

      var payload = {
        text: text,
        topic: topic,
        count: count,
        difficulty: difficulty,
        tags: tags,
        instructions: instructions
      };

      var res = await requestChat(
        config,
        [
          { role: 'system', content: generateSystemPrompt() },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        'generate',
        MAX_TOKENS.generate
      );

      var raw = parseModelJson(res.content);
      var list = Array.isArray(raw)
        ? raw
        : isPlainObject(raw)
          ? raw.questions || raw.items
          : null;
      if (!Array.isArray(list)) {
        throw aiError('PARSE', '模型返回的题目格式不正确（缺少 questions 数组）。');
      }

      var questions = [];
      for (var i = 0; i < list.length && questions.length < count; i += 1) {
        var question = normalizeQuestion(list[i], difficulty || 2);
        if (question) questions.push(question);
      }

      if (!questions.length) {
        throw aiError('PARSE', '模型没有返回可用的题目（题目与答案不能为空）。');
      }

      return { questions: questions };
    }
  };

  // 浏览器环境挂到 window；同时挂到全局，便于测试沙箱与其他运行环境。
  if (hasWindow) window.ShifenAI = api;
  if (globalScope && (!hasWindow || globalScope !== window)) {
    globalScope.ShifenAI = api;
  }
})();
