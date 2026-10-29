/* =========================================================================
   拾分 · 简答练习室
   纯前端、离线优先。数据保存在 localStorage。
   ========================================================================= */
(() => {
  'use strict';

  /* ---------------------------------------------------------------------
     常量与基础工具
     --------------------------------------------------------------------- */
  const STORAGE_KEY = 'shifen.v1';
  const VIEWS = ['dashboard', 'practice', 'banks', 'wrong', 'favorites', 'stats'];
  const VIEW_TITLES = {
    dashboard: '今日',
    practice: '练习',
    banks: '题库',
    wrong: '错题本',
    favorites: '收藏',
    stats: '统计'
  };
  const RATING_LABELS = ['忘记', '模糊', '掌握', '熟练'];
  const RATING_SHORT = ['忘', '模', '会', '熟'];
  const RATING_MASTERY = [15, 45, 78, 100];
  const DIFFICULTY_LABELS = { 1: '基础', 2: '中等', 3: '挑战' };
  const MODE_LABELS = {
    bank: '顺序练习',
    wrong: '错题重练',
    favorites: '收藏练习',
    tag: '知识点专练',
    all: '全部练习'
  };
  const MODE_SHORT = { bank: '顺序', wrong: '错题', favorites: '收藏', tag: '专题', all: '全部' };
  const DAILY_PRESETS = [5, 10, 15, 20, 30];
  const THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };
  const DEFAULT_AI = {
    enabled: false,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.3,
    autoKeywords: false
  };
  const AI_PROVIDER_FALLBACK = {
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', requiresKey: true },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresKey: true },
    ollama: { label: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', requiresKey: false },
    custom: { label: '自定义代理', baseUrl: '', model: '', requiresKey: false }
  };
  const AI_SOURCE_LIMIT = 20000;
  const AI_VERDICTS = ['掌握', '基本掌握', '还需巩固', '未掌握'];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const uid = (prefix = 'q') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const nowIso = () => new Date().toISOString();

  function formatLongDate(d = new Date()) {
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${week}`;
  }

  function formatShortDate(d = new Date()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function relativeTime(ts) {
    if (!ts) return '尚未练习';
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 9) return '早上好';
    if (h < 12) return '上午好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function normalizeForMatch(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[\s\u3000，。、；：！？,.;:!?（）()【】\[\]“”"'‘’`~～\-—…·]/g, '');
  }

  function splitKeywords(value) {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    if (typeof value === 'string') {
      return value.split(/[,，、;；\n]/).map((v) => v.trim()).filter(Boolean);
    }
    return [];
  }

  function splitTags(value) {
    return splitKeywords(value).slice(0, 12);
  }

  function clampDifficulty(value) {
    const n = Number(value);
    return n >= 1 && n <= 3 ? Math.round(n) : 2;
  }

  function masteryLabel(value) {
    if (value >= 90) return '熟练';
    if (value >= 70) return '掌握';
    if (value >= 40) return '巩固';
    if (value > 0) return '初识';
    return '未练';
  }

  function masteryTone(value) {
    if (value >= 70) return 'good';
    if (value >= 40) return 'mid';
    if (value > 0) return 'low';
    return 'none';
  }

  function difficultyDots(level) {
    const n = clampDifficulty(level);
    return `<span class="difficulty-dots" aria-label="${DIFFICULTY_LABELS[n]}难度">${
      [1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')
    }</span><span>${DIFFICULTY_LABELS[n]}</span>`;
  }

  function tagHTML(tags) {
    return (tags || []).slice(0, 6).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  }

  function excerpt(text, max = 120) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  /* ---------------------------------------------------------------------
     内置示例题库
     --------------------------------------------------------------------- */
  const SAMPLE_QUESTIONS = [
    {
      question: '为什么“间隔练习”通常比集中练习更有效？',
      answer: '间隔练习把复习分散到不同的时间点。每次复习时，记忆已经部分衰减，大脑需要重新提取，这种“有难度的提取”会强化记忆痕迹；同时，间隔让遗忘与再学习交替发生，促使记忆被更新和巩固。它牺牲了短期流畅感，换取更稳固的长期保持。',
      keywords: ['分散复习', '重新提取', '必要难度', '长期保持'],
      explanation: '核心机制是“提取”而不是“重读”。间隔制造适度遗忘，让每一次成功提取都更有价值。',
      tags: ['记忆', '学习方法'],
      difficulty: 2
    },
    {
      question: '费曼学习法分为哪四个步骤？',
      answer: '第一，选定一个概念，把它写在纸上；第二，用尽量简单的语言向一个外行讲清楚；第三，卡壳或说不清时回到原始材料，补齐理解漏洞；第四，继续简化并使用类比，直到表达流畅、不依赖术语。',
      keywords: ['选定概念', '简单语言讲解', '发现漏洞', '简化与类比'],
      explanation: '费曼法的关键不是“讲一遍”，而是通过讲解暴露理解断点，再回到材料修补。',
      tags: ['学习方法', '输出'],
      difficulty: 1
    },
    {
      question: '什么是“测试效应”？可以怎样利用它提高复习效率？',
      answer: '测试效应指主动提取信息（如自测、默写、复述）比被动重读更能促进长期记忆。利用方式包括：学完一段后合上书回忆要点；用间隔自测代替反复划线和重读；对错题做延迟再测；把简答题当作提取练习，先作答再看答案。',
      keywords: ['主动提取', '长期记忆', '间隔自测', '先答后看'],
      explanation: '测试本身就是学习事件，而不只是评估手段。提取越费力，记忆收益通常越大。',
      tags: ['记忆', '复习策略'],
      difficulty: 2
    },
    {
      question: '什么是刻意练习？它通常具备哪四个特征？',
      answer: '刻意练习是有明确目标、有反馈、走出舒适区的针对性训练。四个特征：设定具体而清晰的目标；保持高度专注；获得即时反馈并及时纠正；反复练习薄弱环节并持续调整方法。它不等于简单重复。',
      keywords: ['明确目标', '高度专注', '即时反馈', '走出舒适区'],
      explanation: '刻意练习强调“针对性”和“反馈闭环”。没有反馈的重复，很容易把错误练得更熟练。',
      tags: ['学习方法', '技能'],
      difficulty: 2
    },
    {
      question: '什么是元认知？它包含哪些主要成分？',
      answer: '元认知是“对自己认知过程的认知”。主要包含三部分：元认知知识，即知道自己如何学习、任务难在哪里；元认知监控，即在学习中察觉自己是否理解；元认知调节，即根据监控结果调整策略、分配时间。',
      keywords: ['认知过程', '元认知知识', '监控', '调节'],
      explanation: '元认知让人能判断“我到底会不会”，从而决定继续、换方法还是求助。',
      tags: ['心理学', '元认知'],
      difficulty: 2
    },
    {
      question: '为什么“重读”容易让人产生能力错觉？',
      answer: '重读会带来熟悉感，而熟悉感常被误认为掌握。但熟悉不等于能在没有提示时提取出来。流畅地看懂材料，可能只是识别，而不是回忆。合书复述、自测和间隔练习会制造提取困难，也更能检验真实掌握程度。',
      keywords: ['熟悉感', '能力错觉', '提取', '自测'],
      explanation: '判断学习是否有效，要看“能否在没有材料的情况下说出来”，而不是“看着材料觉得都懂”。',
      tags: ['记忆', '学习方法'],
      difficulty: 2
    },
    {
      question: '如何把零散知识构建成可调用的知识网络？',
      answer: '第一，用自己的话做概念卡片；第二，寻找概念之间的因果、对比和层级关系，并画成关系图；第三，用例子和反例界定概念的边界；第四，把新知识连接到已有经验；第五，通过讲解和写作输出，暴露断点并补上缺失的链接。',
      keywords: ['概念卡片', '关系图', '例子与反例', '连接旧知', '输出'],
      explanation: '知识网络的价值在于“可检索、可迁移”。连接越多，提取线索越丰富。',
      tags: ['知识管理', '输出'],
      difficulty: 3
    },
    {
      question: '睡眠如何影响记忆？为了提高学习效率，应该怎样安排睡眠？',
      answer: '睡眠通过记忆巩固把新记忆整合进长期网络，慢波睡眠和快速眼动睡眠都参与其中，并有助于提取和创造性联结。熬夜学习牺牲的正是巩固环节。更有效的做法是规律作息、睡前做轻量回顾、避免长期用睡眠换学习时长。',
      keywords: ['记忆巩固', '慢波睡眠', '快速眼动睡眠', '规律作息'],
      explanation: '睡眠不是学习的暂停键，而是记忆加工的重要阶段。',
      tags: ['记忆', '健康'],
      difficulty: 1
    },
    {
      question: 'SQ3R 阅读法包含哪五个步骤？它的核心思想是什么？',
      answer: 'Survey 浏览标题、图表和结论；Question 把标题转成问题；Read 带着问题阅读；Recite 合书复述要点；Review 做间隔复习。核心思想是把被动阅读改造成“提问—提取—复习”的主动循环。',
      keywords: ['浏览', '提问', '阅读', '复述', '复习'],
      explanation: 'SQ3R 用问题驱动阅读，用复述检验理解，用复习对抗遗忘。',
      tags: ['阅读方法', '复习策略'],
      difficulty: 1
    },
    {
      question: '如何设计一个真正可执行的复习计划？',
      answer: '先确定截止日期和材料总量，按“间隔 + 自测”拆成每日小块；为每块设定可验证的输出，例如合书复述或做题；把复习安排在遗忘临界点，如 1 天、3 天、7 天、14 天；预留缓冲和补漏时间；每周根据错题调整复习权重，而不是平均用力。',
      keywords: ['截止日期', '间隔', '自测输出', '遗忘临界点', '每周调整'],
      explanation: '可执行的计划必须有“可验证的输出”和“可调整的反馈”，否则只是时间表。',
      tags: ['计划', '复习策略'],
      difficulty: 3
    },
    {
      question: '什么是成长型思维？它常被怎样误解？',
      answer: '成长型思维相信能力可以通过努力、策略和反馈不断发展，而不是固定不变。它影响人如何解释失败：把失败看作信息，而不是身份标签，因此更愿意挑战和坚持。常见误解是把它简化为“只夸努力”；实际上，它更强调有效策略、寻求帮助和持续调整。',
      keywords: ['能力可发展', '努力与策略', '反馈', '面对失败'],
      explanation: '成长型思维不是盲目乐观，而是相信“方法可以改变结果”。',
      tags: ['心理学', '动机'],
      difficulty: 1
    },
    {
      question: '怎样做错题复盘，才能真正避免下次再错？',
      answer: '不要只抄正确答案，而要回答四件事：错在哪一步，是知识、审题还是表达；正确思路的关键节点是什么；下次遇到同类题可以迁移的规则是什么；用一道变式题即时验证。复盘后把题加入间隔重练，直到能无提示完整作答。',
      keywords: ['错误归因', '关键节点', '可迁移规则', '变式验证', '间隔重练'],
      explanation: '错题的价值不在“看过答案”，而在找到可复用的判断规则。',
      tags: ['错题', '复习策略'],
      difficulty: 2
    }
  ];

  function createSampleState() {
    const bankId = 'bank_sample';
    const createdAt = Date.now();
    return normalizeState({
      version: 1,
      banks: [{
        id: bankId,
        name: '示例 · 认知与学习',
        createdAt,
        sourceType: '内置示例',
        description: '从记忆、复习到输出，12 个关于「如何学习」的核心问题。',
        isSample: true
      }],
      questions: SAMPLE_QUESTIONS.map((q, i) => ({
        id: `sample_${i + 1}`,
        bankId,
        question: q.question,
        answer: q.answer,
        keywords: q.keywords,
        explanation: q.explanation,
        tags: q.tags,
        difficulty: q.difficulty,
        source: '拾分 · 内置示例',
        createdAt: createdAt + i
      })),
      progress: {},
      sessions: { [bankId]: { cursor: 0, updatedAt: createdAt } },
      settings: { dailyGoal: 10, theme: 'light', autoNext: true, shuffle: false, ai: DEFAULT_AI },
      activity: {},
      drafts: {},
      aiReviews: {},
      ui: { lastBankId: bankId }
    });
  }

  /* ---------------------------------------------------------------------
     状态与持久化
     --------------------------------------------------------------------- */
  const DEFAULT_SETTINGS = { dailyGoal: 10, theme: 'light', autoNext: true, shuffle: false };

  function normalizeAIFields(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const provider = ['deepseek', 'openai', 'ollama', 'custom'].includes(source.provider)
      ? source.provider
      : DEFAULT_AI.provider;
    const preset = AI_PROVIDER_FALLBACK[provider] || AI_PROVIDER_FALLBACK.custom;
    return {
      enabled: Boolean(source.enabled),
      provider,
      baseUrl: String(source.baseUrl || preset.baseUrl || '').trim().replace(/\/+$/, ''),
      model: String(source.model || preset.model || '').trim(),
      apiKey: String(source.apiKey || '').trim(),
      temperature: clamp(Number(source.temperature) || DEFAULT_AI.temperature, 0, 1.5),
      autoKeywords: Boolean(source.autoKeywords)
    };
  }

  function verdictForScore(score) {
    const n = Number(score) || 0;
    if (n >= 85) return '掌握';
    if (n >= 65) return '基本掌握';
    if (n >= 40) return '还需巩固';
    return '未掌握';
  }

  function normalizeAIReview(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const score = clamp(Math.round(Number(raw.score) || 0), 0, 100);
    const stringArray = (value, limit = 12) => Array.isArray(value)
      ? value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, limit)
      : [];
    return {
      score,
      verdict: AI_VERDICTS.includes(raw.verdict) ? raw.verdict : verdictForScore(score),
      matchedPoints: stringArray(raw.matchedPoints || raw.matched, 12),
      missedPoints: stringArray(raw.missedPoints || raw.missed, 12),
      summary: String(raw.summary || '').trim().slice(0, 1200),
      suggestions: stringArray(raw.suggestions, 10),
      improvedAnswer: String(raw.improvedAnswer || '').trim().slice(0, 4000),
      at: Number(raw.at) || Date.now(),
      model: String(raw.model || '').slice(0, 80)
    };
  }

  function normalizeState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const banks = (Array.isArray(source.banks) ? source.banks : [])
      .filter((b) => b && typeof b === 'object' && b.id)
      .map((b) => ({
        id: String(b.id),
        name: String(b.name || '未命名题库').slice(0, 80),
        createdAt: Number(b.createdAt) || Date.now(),
        sourceType: String(b.sourceType || '导入'),
        description: String(b.description || ''),
        isSample: Boolean(b.isSample)
      }));

    const bankIds = new Set(banks.map((b) => b.id));
    const questions = (Array.isArray(source.questions) ? source.questions : [])
      .filter((q) => q && typeof q === 'object' && q.id && q.question && bankIds.has(String(q.bankId)))
      .map((q) => ({
        id: String(q.id),
        bankId: String(q.bankId),
        question: String(q.question),
        answer: String(q.answer || ''),
        keywords: splitKeywords(q.keywords),
        explanation: String(q.explanation || ''),
        tags: splitTags(q.tags),
        difficulty: clampDifficulty(q.difficulty),
        source: String(q.source || ''),
        createdAt: Number(q.createdAt) || Date.now()
      }));
    const questionIds = new Set(questions.map((q) => q.id));

    const progress = {};
    if (source.progress && typeof source.progress === 'object') {
      Object.keys(source.progress).forEach((qid) => {
        if (!questionIds.has(qid)) return;
        const p = source.progress[qid] || {};
        const attempts = Math.max(0, Number(p.attempts) || 0);
        progress[qid] = {
          attempts,
          lastRating: p.lastRating == null ? null : clamp(Number(p.lastRating) || 0, 0, 3),
          lastAt: Number(p.lastAt) || 0,
          mastery: clamp(Number(p.mastery) || 0, 0, 100),
          favorite: Boolean(p.favorite),
          favoriteAt: Number(p.favoriteAt) || 0,
          note: String(p.note || ''),
          history: Array.isArray(p.history)
            ? p.history.slice(-50).filter((h) => h && h.at).map((h) => ({ at: Number(h.at), rating: clamp(Number(h.rating) || 0, 0, 3) }))
            : []
        };
      });
    }

    const sessions = {};
    if (source.sessions && typeof source.sessions === 'object') {
      Object.keys(source.sessions).forEach((bid) => {
        if (!bankIds.has(bid)) return;
        const s = source.sessions[bid] || {};
        sessions[bid] = { cursor: Math.max(0, Number(s.cursor) || 0), updatedAt: Number(s.updatedAt) || Date.now() };
      });
    }

    const settings = {
      ...DEFAULT_SETTINGS,
      ...(source.settings && typeof source.settings === 'object' ? source.settings : {})
    };
    settings.dailyGoal = clamp(Number(settings.dailyGoal) || 10, 1, 200);
    settings.autoNext = Boolean(settings.autoNext);
    settings.shuffle = Boolean(settings.shuffle);
    if (!['auto', 'light', 'dark'].includes(settings.theme)) settings.theme = 'light';
    settings.ai = normalizeAIFields(settings.ai);

    const activity = {};
    if (source.activity && typeof source.activity === 'object') {
      Object.keys(source.activity).forEach((key) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
        const a = source.activity[key];
        const count = typeof a === 'number' ? a : Number(a && a.count);
        if (count > 0) activity[key] = { count: Math.round(count) };
      });
    }

    const drafts = {};
    if (source.drafts && typeof source.drafts === 'object') {
      Object.keys(source.drafts).forEach((qid) => {
        if (questionIds.has(qid) && typeof source.drafts[qid] === 'string') drafts[qid] = source.drafts[qid].slice(0, 20000);
      });
    }

    const aiReviews = {};
    if (source.aiReviews && typeof source.aiReviews === 'object') {
      Object.keys(source.aiReviews).forEach((qid) => {
        if (!questionIds.has(qid)) return;
        const review = normalizeAIReview(source.aiReviews[qid]);
        if (review) aiReviews[qid] = review;
      });
    }

    let lastBankId = source.ui && source.ui.lastBankId;
    if (!bankIds.has(lastBankId)) lastBankId = banks[0] ? banks[0].id : null;

    return {
      version: 1,
      banks,
      questions,
      progress,
      sessions,
      settings,
      activity,
      drafts,
      aiReviews,
      ui: { lastBankId }
    };
  }

  let state;
  let ui = {
    view: 'dashboard',
    session: null,
    selectedBankId: null,
    bankQuery: '',
    importDraft: null,
    aiBusy: { review: false, keywords: false, importKeywords: false },
    autoNextTimer: null,
    draftTimer: null
  };
  let saveTimer = null;
  let storageWarned = false;
  const modalStack = [];

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      if (!storageWarned) {
        storageWarned = true;
        setTimeout(() => toast('浏览器不允许本地存储，本次进度可能在刷新后丢失。', 'error', 5000), 800);
      }
    }

    if (!raw) {
      state = createSampleState();
      saveNow();
      return;
    }

    try {
      state = normalizeState(JSON.parse(raw));
    } catch (err) {
      console.error('读取本地数据失败', err);
      state = createSampleState();
      saveNow();
      setTimeout(() => toast('本地数据读取失败，已载入示例题库。', 'error', 5000), 800);
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      if (!storageWarned) {
        storageWarned = true;
        toast('保存失败：浏览器本地存储空间不足或被禁用。', 'error', 5000);
      }
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 180);
  }

  /* ---------------------------------------------------------------------
     AI 配置
     --------------------------------------------------------------------- */
  function syncAIConfig() {
    if (!window.ShifenAI) return;
    try {
      window.ShifenAI.configure(state.settings.ai);
    } catch (error) {
      console.warn('AI 配置同步失败', error);
    }
  }

  function aiPresets() {
    return window.ShifenAI?.PRESETS || AI_PROVIDER_FALLBACK;
  }

  function aiReady() {
    return Boolean(window.ShifenAI && window.ShifenAI.isConfigured(state.settings.ai));
  }

  function aiStatusInfo() {
    if (!window.ShifenAI) return { ready: false, text: 'AI 组件未加载', tone: 'off' };
    if (!state.settings.ai.enabled) return { ready: false, text: '未启用', tone: 'off' };
    if (!window.ShifenAI.isConfigured(state.settings.ai)) return { ready: false, text: '待配置', tone: 'warn' };
    return { ready: true, text: `已启用 · ${state.settings.ai.model || 'AI'}`, tone: 'on' };
  }

  function ensureAIReady() {
    if (aiReady()) return true;
    if (!window.ShifenAI) {
      toast('AI 组件未加载，请确认 js/ai.js 存在后刷新页面。', 'error', 4200);
      return false;
    }
    toast('先配置 AI 服务，才能使用 AI 功能。', 'info', 3200);
    openAISettings();
    return false;
  }

  function refreshAIStatus() {
    const status = aiStatusInfo();
    ['#aiStatus', '#aiSettingsStatus', '#aiModalStatus', '#aiImportStatus'].forEach((selector) => {
      const el = $(selector);
      if (!el) return;
      el.textContent = status.text;
      el.classList.toggle('is-on', status.ready);
      el.classList.toggle('is-warn', status.tone === 'warn');
    });
    const tools = $('#aiTools');
    if (tools) tools.classList.toggle('is-ready', status.ready);
    const generateBtn = $('#aiGenerateBtn');
    if (generateBtn) generateBtn.disabled = ui.importDraft?.aiBusy || false;
    const reviewBtn = $('#aiReviewBtn');
    const keywordsBtn = $('#aiKeywordsBtn');
    const practiceBusy = Boolean(ui.aiBusy?.review || ui.aiBusy?.keywords);
    if (reviewBtn) reviewBtn.disabled = practiceBusy;
    if (keywordsBtn) keywordsBtn.disabled = practiceBusy;
    const aiImportBtn = $('#aiKeywordsImportBtn');
    if (aiImportBtn) aiImportBtn.disabled = Boolean(ui.aiBusy?.importKeywords);
  }

  /* ---------------------------------------------------------------------
     数据查询
     --------------------------------------------------------------------- */
  const getBank = (id) => state.banks.find((b) => b.id === id) || null;
  const getQuestion = (id) => state.questions.find((q) => q.id === id) || null;
  const getBankQuestions = (bankId) => state.questions.filter((q) => q.bankId === bankId);
  const getProgress = (qid) => state.progress[qid] || null;

  function ensureProgress(qid) {
    if (!state.progress[qid]) {
      state.progress[qid] = {
        attempts: 0, lastRating: null, lastAt: 0, mastery: 0,
        favorite: false, favoriteAt: 0, note: '', history: []
      };
    }
    return state.progress[qid];
  }

  function getActiveBank() {
    const active = getBank(state.ui.lastBankId);
    if (active) return active;
    return state.banks[0] || null;
  }

  function getWrongQuestions() {
    return state.questions
      .filter((q) => {
        const p = getProgress(q.id);
        return p && p.attempts > 0 && p.lastRating !== null && p.lastRating <= 1;
      })
      .sort((a, b) => (getProgress(b.id)?.lastAt || 0) - (getProgress(a.id)?.lastAt || 0));
  }

  function getFavoriteQuestions() {
    return state.questions
      .filter((q) => getProgress(q.id)?.favorite)
      .sort((a, b) => (getProgress(b.id)?.favoriteAt || 0) - (getProgress(a.id)?.favoriteAt || 0));
  }

  function getTagQuestions(tag) {
    return state.questions.filter((q) => q.tags.includes(tag));
  }

  function bankStats(bankId) {
    const qs = getBankQuestions(bankId);
    const attempted = qs.filter((q) => (getProgress(q.id)?.attempts || 0) > 0);
    const mastery = attempted.length
      ? Math.round(attempted.reduce((sum, q) => sum + (getProgress(q.id)?.mastery || 0), 0) / attempted.length)
      : 0;
    return {
      total: qs.length,
      attempted: attempted.length,
      mastery,
      wrong: qs.filter((q) => {
        const p = getProgress(q.id);
        return p && p.attempts > 0 && p.lastRating <= 1;
      }).length
    };
  }

  function statsSnapshot() {
    const qs = state.questions;
    const attempted = qs.filter((q) => (getProgress(q.id)?.attempts || 0) > 0);
    const masteryValues = attempted.map((q) => getProgress(q.id)?.mastery || 0);
    const avgMastery = masteryValues.length
      ? Math.round(masteryValues.reduce((a, b) => a + b, 0) / masteryValues.length)
      : 0;
    const buckets = [
      { key: 'untouched', label: '未练习', color: 'var(--line-strong)', count: qs.length - attempted.length },
      { key: 'new', label: '初识', color: 'var(--rating-0)', count: 0 },
      { key: 'solid', label: '巩固', color: 'var(--rating-1)', count: 0 },
      { key: 'mastered', label: '掌握', color: 'var(--rating-2)', count: 0 },
      { key: 'fluent', label: '熟练', color: 'var(--rating-3)', count: 0 }
    ];
    attempted.forEach((q) => {
      const m = getProgress(q.id)?.mastery || 0;
      if (m >= 90) buckets[4].count += 1;
      else if (m >= 70) buckets[3].count += 1;
      else if (m >= 40) buckets[2].count += 1;
      else buckets[1].count += 1;
    });
    const total = Math.max(qs.length, 1);
    let acc = 0;
    const stops = buckets.map((b) => {
      const start = acc;
      acc += (b.count / total) * 100;
      return `${b.color} ${start.toFixed(2)}% ${acc.toFixed(2)}%`;
    });
    return {
      total: qs.length,
      attempted: attempted.length,
      mastered: attempted.filter((q) => (getProgress(q.id)?.mastery || 0) >= 70).length,
      avgMastery,
      wrong: getWrongQuestions().length,
      favorites: getFavoriteQuestions().length,
      buckets,
      donut: qs.length ? `conic-gradient(${stops.join(',')})` : 'var(--line)',
      attempts: qs.reduce((sum, q) => sum + (getProgress(q.id)?.attempts || 0), 0)
    };
  }

  function activitySeries(days) {
    const out = [];
    const base = new Date();
    base.setHours(12, 0, 0, 0);
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      const key = dateKey(d);
      out.push({
        key,
        count: state.activity[key]?.count || 0,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        week: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()],
        isToday: i === 0
      });
    }
    return out;
  }

  function calcStreak() {
    let streak = 0;
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    if (!state.activity[dateKey(d)]?.count) d.setDate(d.getDate() - 1);
    while (state.activity[dateKey(d)]?.count) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  function tagStats() {
    const map = new Map();
    state.questions.forEach((q) => {
      q.tags.forEach((tag) => {
        if (!map.has(tag)) map.set(tag, { tag, total: 0, attempted: 0, masterySum: 0 });
        const item = map.get(tag);
        item.total += 1;
        const p = getProgress(q.id);
        if (p && p.attempts > 0) {
          item.attempted += 1;
          item.masterySum += p.mastery || 0;
        }
      });
    });
    return Array.from(map.values())
      .map((item) => ({ ...item, mastery: item.attempted ? Math.round(item.masterySum / item.attempted) : 0 }))
      .sort((a, b) => {
        if (a.attempted && b.attempted) return a.mastery - b.mastery;
        if (a.attempted) return -1;
        if (b.attempted) return 1;
        return b.total - a.total;
      });
  }

  function bumpActivity() {
    const key = dateKey();
    const current = state.activity[key]?.count || 0;
    state.activity[key] = { count: current + 1 };
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 400);
    const cutoffKey = dateKey(cutoff);
    Object.keys(state.activity).forEach((k) => {
      if (k < cutoffKey) delete state.activity[k];
    });
  }

  /* ---------------------------------------------------------------------
     主题
     --------------------------------------------------------------------- */
  function resolvedTheme() {
    if (state.settings.theme === 'auto') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return state.settings.theme;
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#171B17' : '#F4EFE6');
    const themeBtn = $('#themeBtn');
    if (themeBtn) {
      const next = theme === 'dark' ? 'light' : 'dark';
      themeBtn.setAttribute('aria-label', `切换为${next === 'dark' ? '深色' : '浅色'}主题`);
      themeBtn.setAttribute('title', `切换为${next === 'dark' ? '深色' : '浅色'}主题`);
      themeBtn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    }
  }

  function setTheme(theme) {
    state.settings.theme = ['auto', 'light', 'dark'].includes(theme) ? theme : 'light';
    applyTheme();
    saveSoon();
  }

  /* ---------------------------------------------------------------------
     路由与外壳
     --------------------------------------------------------------------- */
  function parseHash() {
    const match = (location.hash || '').match(/^#\/([a-z-]+)/);
    return match && VIEWS.includes(match[1]) ? match[1] : 'dashboard';
  }

  function go(view, opts = {}) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    if (view === 'practice' && !ui.session) ensureResumeSession();
    ui.view = view;
    closeSidebar();
    const target = `#/${view}`;
    if (parseHash() === view || opts.replace) {
      history.replaceState(null, '', target);
      renderAll();
      window.scrollTo({ top: 0, behavior: 'auto' });
    } else {
      location.hash = `/${view}`;
    }
  }

  function route() {
    const view = parseHash();
    if (view === 'practice' && !ui.session) ensureResumeSession();
    ui.view = view;
    renderAll();
    closeSidebar();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function renderAll() {
    renderShell();
    renderCurrentView();
    document.title = `${VIEW_TITLES[ui.view] || '今日'} · 拾分`;
  }

  function renderShell() {
    $$('.nav-item').forEach((btn) => {
      const active = btn.dataset.view === ui.view;
      btn.classList.toggle('is-active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    const wrong = getWrongQuestions().length;
    const fav = getFavoriteQuestions().length;
    const wrongEl = $('#navWrongCount');
    const favEl = $('#navFavCount');
    if (wrongEl) {
      wrongEl.textContent = String(wrong);
      wrongEl.hidden = wrong === 0;
    }
    if (favEl) {
      favEl.textContent = String(fav);
      favEl.hidden = fav === 0;
    }

    const todayCount = state.activity[dateKey()]?.count || 0;
    const goal = state.settings.dailyGoal;
    const pct = clamp(Math.round((todayCount / goal) * 100), 0, 100);
    const goalLabel = $('#dailyGoalLabel');
    const goalFill = $('#dailyGoalFill');
    const goalTrack = $('#dailyGoalTrack');
    const goalNote = $('#dailyGoalNote');
    if (goalLabel) goalLabel.textContent = `${todayCount} / ${goal}`;
    if (goalFill) goalFill.style.width = `${pct}%`;
    if (goalTrack) {
      goalTrack.setAttribute('aria-valuenow', String(Math.min(todayCount, goal)));
      goalTrack.setAttribute('aria-valuemax', String(goal));
    }
    if (goalNote) {
      goalNote.textContent = todayCount >= goal
        ? '今日目标完成，保持这个节奏。'
        : `再答 ${goal - todayCount} 题，就完成今天的小目标。`;
    }
  }

  function renderCurrentView() {
    VIEWS.forEach((view) => {
      const el = $(`#view-${view}`);
      if (el) el.hidden = view !== ui.view;
    });
    const root = $(`#view-${ui.view}`);
    if (!root) return;
    if (ui.view === 'dashboard') renderDashboard(root);
    else if (ui.view === 'practice') renderPractice();
    else if (ui.view === 'banks') renderBanks(root);
    else if (ui.view === 'wrong') renderReview(root, 'wrong');
    else if (ui.view === 'favorites') renderReview(root, 'favorites');
    else if (ui.view === 'stats') renderStats(root);
  }

  /* ---------------------------------------------------------------------
     练习会话
     --------------------------------------------------------------------- */
  function shuffleArray(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function ensureResumeSession() {
    if (ui.session) return true;
    const bank = getActiveBank();
    if (!bank) return false;
    const qs = getBankQuestions(bank.id);
    if (!qs.length) return false;
    const stored = state.sessions[bank.id]?.cursor || 0;
    const index = stored >= qs.length ? 0 : stored;
    ui.session = {
      mode: 'bank',
      bankId: bank.id,
      title: bank.name,
      queue: qs.map((q) => q.id),
      index,
      revealed: false,
      ratings: {},
      startedAt: Date.now()
    };
    if (state.ui.lastBankId !== bank.id) {
      state.ui.lastBankId = bank.id;
      saveSoon();
    }
    return true;
  }

  function startSession(options = {}) {
    clearTimeout(ui.autoNextTimer);
    const mode = options.mode || 'bank';
    let bank = options.bankId ? getBank(options.bankId) : null;
    let qs = [];
    let title = options.title || MODE_LABELS[mode] || '练习';

    if (mode === 'bank') {
      if (!bank) bank = getActiveBank();
      if (!bank) {
        toast('还没有题库，先导入一份吧。', 'info');
        return false;
      }
      qs = getBankQuestions(bank.id);
      title = bank.name;
    } else if (mode === 'wrong') {
      qs = getWrongQuestions();
      title = '错题本';
    } else if (mode === 'favorites') {
      qs = getFavoriteQuestions();
      title = '收藏夹';
    } else if (mode === 'tag') {
      qs = getTagQuestions(options.tag || '');
      title = `知识点 · ${options.tag || ''}`;
    } else if (mode === 'all') {
      qs = state.questions.slice();
      title = '全部题目';
    }

    if (!qs.length) {
      const messages = {
        wrong: '错题本还是空的。先去做几道题，把不会的留下。',
        favorites: '还没有收藏的题目。练习时点右上角的星标即可收藏。',
        tag: '这个知识点下还没有题目。',
        bank: '这个题库还没有题目，先导入题目吧。'
      };
      toast(messages[mode] || '这里还没有可以练习的题目。', 'info');
      return false;
    }

    if (state.settings.shuffle) qs = shuffleArray(qs);
    let index = 0;
    if (options.startId) {
      const found = qs.findIndex((q) => q.id === options.startId);
      if (found >= 0) index = found;
    } else if (mode === 'bank' && bank && !options.restart) {
      const stored = state.sessions[bank.id]?.cursor || 0;
      index = stored >= qs.length ? 0 : stored;
    }

    ui.session = {
      mode,
      bankId: bank ? bank.id : (options.bankId || null),
      tag: options.tag || null,
      title,
      queue: qs.map((q) => q.id),
      index,
      revealed: false,
      ratings: {},
      startedAt: Date.now()
    };
    if (bank) {
      state.ui.lastBankId = bank.id;
      saveSoon();
    }
    go('practice');
    return true;
  }

  function currentQuestion() {
    if (!ui.session) return null;
    return getQuestion(ui.session.queue[ui.session.index]) || null;
  }

  function persistCursor() {
    const s = ui.session;
    if (!s) return;
    if (s.mode === 'bank' && s.bankId) {
      state.sessions[s.bankId] = { cursor: s.index, updatedAt: Date.now() };
    }
    saveSoon();
  }

  function renderPractice() {
    const stage = $('#practiceStage');
    const empty = $('#practiceEmpty');
    const complete = $('#practiceComplete');
    const s = ui.session;

    if (!s) {
      stage.hidden = true;
      complete.hidden = true;
      empty.hidden = false;
      renderPracticeEmpty(empty);
      updatePracticeTop(null);
      return;
    }

    if (s.index >= s.queue.length) {
      stage.hidden = true;
      empty.hidden = true;
      complete.hidden = false;
      renderPracticeComplete(complete, s);
      updatePracticeTop(s, true);
      return;
    }

    let q = currentQuestion();
    while (!q && s.index < s.queue.length) {
      s.index += 1;
      q = currentQuestion();
    }
    if (!q) {
      stage.hidden = true;
      complete.hidden = false;
      empty.hidden = true;
      renderPracticeComplete(complete, s);
      updatePracticeTop(s, true);
      return;
    }

    stage.hidden = false;
    empty.hidden = true;
    complete.hidden = true;
    const bank = getBank(q.bankId);
    updatePracticeTop(s);

    $('#qIndex').textContent = `第 ${s.index + 1} 题`;
    $('#qDifficulty').innerHTML = difficultyDots(q.difficulty);
    $('#qType').textContent = '简答';
    const tags = $('#qTags');
    tags.replaceChildren(...(q.tags || []).map((tag) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      return span;
    }));
    tags.hidden = !q.tags.length;

    const source = $('#qSource');
    source.textContent = q.source ? `来源 · ${q.source}` : (bank ? `来自 · ${bank.name}` : '');
    source.title = q.source || '';
    source.hidden = !source.textContent;

    $('#questionText').textContent = q.question;
    const answerInput = $('#answerInput');
    const draft = state.drafts[q.id] || '';
    answerInput.value = draft;
    answerInput.placeholder = '先别急着看答案，用自己的话写下来。哪怕只记得两三点，也比直接翻看更有用。';
    $('#charCount').textContent = `${draft.trim().length} 字`;
    $('#draftStatus').textContent = draft ? '已自动保存' : '自动保存';

    const noteInput = $('#noteInput');
    noteInput.value = getProgress(q.id)?.note || '';
    resetAIPanel(q);

    $('#referencePanel').hidden = true;
    $('#ratingBlock').hidden = true;
    $('.reveal-row').hidden = false;
    $('#revealBtn').innerHTML = `${icon('eye')}查看参考答案`;

    const favBtn = $('#practiceFavorite');
    const isFav = Boolean(getProgress(q.id)?.favorite);
    favBtn.classList.toggle('is-active', isFav);
    favBtn.setAttribute('aria-pressed', String(isFav));
    favBtn.setAttribute('aria-label', isFav ? '取消收藏本题' : '收藏本题');
    favBtn.title = isFav ? '取消收藏' : '收藏本题';

    $('#prevBtn').disabled = s.index === 0;
    $('#skipBtn').disabled = false;
    const isLast = s.index >= s.queue.length - 1;
    $('#nextBtn').innerHTML = isLast ? `完成本轮${icon('check')}` : `下一题${icon('arrow-right')}`;
    $('#nextBtn').classList.toggle('btn-accent', isLast);

    const card = $('#questionCard');
    card.dataset.questionId = q.id;
    card.dataset.bankId = q.bankId;
    if (s.mode === 'bank' && s.bankId && state.ui.lastBankId !== s.bankId) {
      state.ui.lastBankId = s.bankId;
      saveSoon();
    }
    card.classList.remove('is-entering');
    void card.offsetWidth;
    card.classList.add('is-entering');

    updatePracticeProgress(s);
    updatePracticeAside(s);
    announce(`第 ${s.index + 1} 题：${q.question}`);

    if (s.revealed) restoreRevealed(q);
    else window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function updatePracticeTop(s, finished = false) {
    const bankName = $('#practiceBankName');
    const modeEl = $('#practiceMode');
    const progressMeta = $('#sessionProgress');
    const progressPercent = $('#progressPercent');
    const progressFill = $('#progressFill');
    const favBtn = $('#practiceFavorite');

    if (!s) {
      modeEl.textContent = '练习';
      bankName.textContent = '还没有可练习的题目';
      progressMeta.textContent = '第 0 / 0 题';
      progressPercent.textContent = '0%';
      progressFill.style.width = '0%';
      favBtn.hidden = true;
      return;
    }

    modeEl.textContent = MODE_LABELS[s.mode] || '练习';
    bankName.textContent = s.title || '练习';
    favBtn.hidden = false;
    const done = Object.keys(s.ratings).length;
    const total = s.queue.length;
    if (finished || s.index >= total) {
      progressMeta.textContent = `已完成 ${total} 题`;
      progressPercent.textContent = '100%';
      progressFill.style.width = '100%';
    } else {
      progressMeta.textContent = `第 ${s.index + 1} / ${total} 题`;
      const pct = total ? Math.round((Math.min(s.index, total) / total) * 100) : 0;
      progressPercent.textContent = `${pct}%`;
      progressFill.style.width = `${pct}%`;
    }
    progressFill.parentElement?.classList.toggle('is-done', done === total && total > 0);
  }

  function updatePracticeProgress(s) {
    const total = s.queue.length;
    const done = Object.keys(s.ratings).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const progressFill = $('#progressFill');
    const percent = $('#progressPercent');
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (percent) percent.textContent = `${pct}%`;
  }

  function updatePracticeAside(s) {
    const done = Object.keys(s.ratings).length;
    const total = s.queue.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const masteryValues = Object.keys(s.ratings).map((qid) => getProgress(qid)?.mastery || 0);
    const avg = masteryValues.length
      ? Math.round(masteryValues.reduce((a, b) => a + b, 0) / masteryValues.length)
      : null;

    $('#asideMode').textContent = MODE_SHORT[s.mode] || '顺序';
    $('#asideDone').textContent = String(done);
    $('#asideLeft').textContent = String(Math.max(0, total - done));
    $('#asideMastery').textContent = avg == null ? '—' : `${avg}%`;
    const ring = $('#sessionRing');
    ring.style.setProperty('--p', String(pct));
    $('#sessionRingValue').textContent = `${pct}%`;
  }

  function renderPracticeEmpty(root) {
    if (!state.banks.length) {
      root.innerHTML = `
        <div class="empty-state">
          ${emptyArt()}
          <h2>从一份题库开始</h2>
          <p>导入 Excel、Word 或 CSV，拾分会自动识别题目与参考答案。也可以先试试内置示例。</p>
          <div class="empty-actions">
            <button class="btn btn-primary" data-action="import">${icon('upload')}导入题库</button>
            <button class="btn btn-ghost" data-action="load-sample">载入示例题库</button>
          </div>
          <p class="empty-hint">支持 .xlsx / .docx / .csv / .txt / .md / .json</p>
        </div>`;
      return;
    }
    const bank = getActiveBank();
    if (bank && !getBankQuestions(bank.id).length) {
      root.innerHTML = `
        <div class="empty-state">
          ${emptyArt()}
          <h2>这个题库还是空的</h2>
          <p>“${esc(bank.name)}”里还没有题目。导入一份文档，或在题库页面切换其他题库。</p>
          <div class="empty-actions">
            <button class="btn btn-primary" data-action="import">${icon('upload')}导入题目</button>
            <button class="btn btn-ghost" data-action="go-banks">查看题库</button>
          </div>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="empty-state">
        ${emptyArt()}
        <h2>暂时没有可练习的题目</h2>
        <p>换一个题库，或先导入一些简答题。</p>
        <div class="empty-actions">
          <button class="btn btn-primary" data-action="go-banks">去题库</button>
          <button class="btn btn-ghost" data-action="import">${icon('upload')}导入题库</button>
        </div>
      </div>`;
  }

  function renderPracticeComplete(root, s) {
    const ratedEntries = s.queue
      .map((qid) => ({ q: getQuestion(qid), rating: s.ratings[qid] }))
      .filter((item) => item.q && item.rating != null);
    const done = ratedEntries.length;
    const avgRating = done ? ratedEntries.reduce((sum, item) => sum + item.rating, 0) / done : 0;
    const strong = ratedEntries.filter((item) => item.rating >= 2).length;
    const minutes = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
    const avgMastery = done
      ? Math.round(ratedEntries.reduce((sum, item) => sum + (getProgress(item.q.id)?.mastery || 0), 0) / done)
      : 0;
    const title = s.mode === 'wrong' ? '错题，又少了一点。' : s.mode === 'favorites' ? '收藏的题，都过了一遍。' : '这一轮，答完了。';
    const sub = done
      ? (avgRating >= 2.5
        ? '状态很好。隔一天再回来快速自测一次，记忆会更牢。'
        : avgRating >= 1.5
          ? '大部分题已经有印象。把还模糊的题再写一遍，比单纯重读更有用。'
          : '这轮有些吃力，很正常。把忘记的题收进错题本，间隔一天再练。')
      : '这一轮没有留下自评记录。下次试着写下答案，再做一次判断。';

    root.innerHTML = `
      <div class="complete-card card">
        <div class="complete-seal" aria-hidden="true">成</div>
        <p class="eyebrow">${MODE_LABELS[s.mode] || '练习'} · 完成</p>
        <h2>${title}</h2>
        <p class="complete-sub">${sub}</p>
        <div class="complete-metrics">
          <div><strong>${done}</strong><span>完成自评</span></div>
          <div><strong>${avgMastery}%</strong><span>本轮平均掌握</span></div>
          <div><strong>${strong}</strong><span>掌握及以上</span></div>
          <div><strong>${minutes}<small> 分</small></strong><span>用时</span></div>
        </div>
        <div class="complete-mastery">
          <div class="meta-row"><span>题库当前平均掌握度</span><strong>${avgMastery}%</strong></div>
          <div class="mastery-track"><span style="width:${avgMastery}%"></span></div>
        </div>
        <div class="complete-actions">
          <button class="btn btn-primary" data-action="restart-session">${icon('rotate')}再练一轮</button>
          <button class="btn btn-ghost" data-action="go-dashboard">回到今日</button>
          ${wrongCountSafe() ? `<button class="btn btn-quiet" data-action="practice-wrong">去错题本${icon('arrow-right')}</button>` : ''}
        </div>
      </div>`;
  }

  function wrongCountSafe() {
    try { return getWrongQuestions().length; } catch (e) { return 0; }
  }

  function restoreRevealed(q) {
    ui.session.revealed = true;
    $('.reveal-row').hidden = true;
    $('#referencePanel').hidden = false;
    $('#ratingBlock').hidden = false;
    $('#referenceText').textContent = q.answer || '本题暂无参考答案。';
    const expBox = $('#explanationBox');
    expBox.hidden = !q.explanation;
    $('#explanationText').textContent = q.explanation || '';
    renderKeywordChips(q, $('#answerInput').value);
    renderRatingState(q);
    restoreAIForQuestion(q);
  }

  function revealReference() {
    const s = ui.session;
    const q = currentQuestion();
    if (!s || !q) return;
    if (!s.revealed && !$('#answerInput').value.trim()) {
      toast('先写下自己的思路，再对照答案，效果会更好。', 'info', 2600);
    }
    s.revealed = true;
    $('.reveal-row').hidden = true;
    const panel = $('#referencePanel');
    panel.hidden = false;
    $('#ratingBlock').hidden = false;
    $('#referenceText').textContent = q.answer || '本题暂无参考答案。';
    const expBox = $('#explanationBox');
    expBox.hidden = !q.explanation;
    $('#explanationText').textContent = q.explanation || '';
    renderKeywordChips(q, $('#answerInput').value);
    renderRatingState(q);
    restoreAIForQuestion(q);
    panel.classList.remove('is-revealing');
    void panel.offsetWidth;
    panel.classList.add('is-revealing');
    if (window.innerWidth < 700) {
      setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 120);
    }
  }

  function renderKeywordChips(q, answer) {
    const box = $('#keywordBox');
    const chips = $('#keywordChips');
    const score = $('#keywordScore');
    const keywords = splitKeywords(q.keywords);
    chips.replaceChildren();
    if (!keywords.length) {
      box.hidden = false;
      score.textContent = '未设置关键词';
      const tip = document.createElement('p');
      tip.className = 'kw-empty';
      tip.textContent = '这道题没有关键词。可以在导入表的「关键词」列补充，之后就能逐点自检。';
      chips.appendChild(tip);
      return;
    }
    box.hidden = false;
    const normalizedAnswer = normalizeForMatch(answer);
    let hits = 0;
    keywords.forEach((kw) => {
      const hit = normalizedAnswer.includes(normalizeForMatch(kw));
      if (hit) hits += 1;
      const chip = document.createElement('span');
      chip.className = `kw-chip ${hit ? 'is-hit' : 'is-miss'}`;
      chip.innerHTML = `${icon(hit ? 'check' : 'circle', 'kw-icon')}<span></span>`;
      chip.querySelector('span').textContent = kw;
      chip.title = hit ? '你的答案中出现了这个要点' : '你的答案中暂未匹配到这个要点';
      chips.appendChild(chip);
    });
    score.textContent = `命中 ${hits} / ${keywords.length}`;
    score.classList.toggle('is-good', hits === keywords.length);
  }

  function renderRatingState(q) {
    const s = ui.session;
    const selected = s?.ratings[q.id];
    $$('#ratingBar .rating-btn').forEach((btn) => {
      const rating = Number(btn.dataset.rating);
      btn.classList.toggle('is-selected', selected === rating);
      btn.classList.remove('is-dim');
      if (selected != null && selected !== rating) btn.classList.add('is-dim');
    });
    const saved = $('#ratingSaved');
    const p = getProgress(q.id);
    if (selected != null) {
      saved.textContent = `已记录 · 掌握度 ${p?.mastery ?? 0}`;
      saved.classList.add('is-visible');
    } else if (p && p.attempts > 0) {
      saved.textContent = `上次自评：${RATING_LABELS[p.lastRating] || '—'}`;
      saved.classList.add('is-visible');
    } else {
      saved.textContent = '';
      saved.classList.remove('is-visible');
    }
  }

  /* ---------------------------------------------------------------------
     练习页 AI 助手
     --------------------------------------------------------------------- */
  function setAIBusy(type, busy) {
    ui.aiBusy[type] = busy;
    refreshAIStatus();
  }

  function updateAIButtons(q) {
    const reviewBtn = $('#aiReviewBtn');
    const keywordsBtn = $('#aiKeywordsBtn');
    if (reviewBtn) {
      reviewBtn.innerHTML = `${icon('spark')}${state.aiReviews?.[q.id] ? '重新 AI 点评' : 'AI 点评我的答案'}`;
    }
    if (keywordsBtn) {
      keywordsBtn.innerHTML = `${icon('layers')}${q.keywords?.length ? 'AI 补充关键词' : 'AI 提取关键词'}`;
    }
    refreshAIStatus();
  }

  function resetAIPanel(q) {
    const output = $('#aiOutput');
    if (output) {
      output.hidden = true;
      output.innerHTML = '';
      output.classList.remove('is-error');
    }
    updateAIButtons(q);
  }

  function restoreAIForQuestion(q) {
    const review = state.aiReviews?.[q.id];
    if (review) renderAIReview(q, review, true);
    else {
      const output = $('#aiOutput');
      if (output) {
        output.hidden = true;
        output.innerHTML = '';
        output.classList.remove('is-error');
      }
    }
    updateAIButtons(q);
  }

  function aiLoadingHTML(title, detail = '通常需要 10–30 秒，请稍候。') {
    return `<div class="ai-loading"><span class="spinner" aria-hidden="true"></span><div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div></div>`;
  }

  function renderAIError(message, retry) {
    const output = $('#aiOutput');
    if (!output) return;
    output.hidden = false;
    output.classList.add('is-error');
    output.innerHTML = `<div class="ai-error-card">
      ${icon('alert')}
      <div class="ai-error-main">
        <strong>AI 调用没有成功</strong>
        <p>${esc(message || '请检查 AI 配置和网络后重试。')}</p>
        <div class="ai-error-actions">
          <button class="btn btn-soft btn-sm" type="button" data-ai-retry>${icon('refresh')}重试</button>
          <button class="btn btn-ghost btn-sm" type="button" data-ai-settings>${icon('settings')}AI 设置</button>
        </div>
      </div>
    </div>`;
    output.querySelector('[data-ai-retry]')?.addEventListener('click', retry);
    output.querySelector('[data-ai-settings]')?.addEventListener('click', openAISettings);
  }

  function renderAIReview(q, review, cached = false) {
    const output = $('#aiOutput');
    if (!output) return;
    const score = clamp(Math.round(Number(review.score) || 0), 0, 100);
    const tone = score >= 65 ? 'good' : score >= 40 ? 'mid' : 'low';
    const pointChips = (points, kind) => {
      if (!points.length) {
        return `<span class="ai-none">${kind === 'hit' ? '没有识别到明确的命中要点' : '没有发现明显遗漏'}</span>`;
      }
      return points.map((point) => `<span class="ai-point ${kind}">${esc(point)}</span>`).join('');
    };
    output.hidden = false;
    output.classList.remove('is-error');
    output.innerHTML = `<div class="ai-review-card">
      <div class="ai-review-top">
        <div class="ai-score ${tone}" style="--score:${score}" role="img" aria-label="AI 覆盖率 ${score} 分">
          <span class="ai-score-inner"><strong>${score}</strong><small>覆盖率</small></span>
        </div>
        <div class="ai-review-head">
          <div class="ai-review-kicker">
            <span class="ai-verdict ${tone}">${esc(review.verdict || 'AI 点评')}</span>
            ${cached ? '<span class="ai-cached">上次点评</span>' : ''}
          </div>
          <p class="ai-summary">${esc(review.summary || 'AI 已完成对照，请结合参考答案查看。')}</p>
        </div>
      </div>
      <div class="ai-points">
        <div class="ai-point-group">
          <span class="ai-point-label is-hit">${icon('check')}命中的要点</span>
          <div class="ai-point-list">${pointChips(review.matchedPoints || [], 'hit')}</div>
        </div>
        <div class="ai-point-group">
          <span class="ai-point-label is-miss">${icon('alert')}还可以补充</span>
          <div class="ai-point-list">${pointChips(review.missedPoints || [], 'miss')}</div>
        </div>
      </div>
      ${review.suggestions?.length ? `<div class="ai-suggestions"><span class="ai-point-label">改进建议</span><ul>${review.suggestions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
      ${review.improvedAnswer ? `<details class="ai-improved"><summary>看看 AI 给出的改进版答案</summary><div class="ai-improved-text">${esc(review.improvedAnswer)}</div></details>` : ''}
      <div class="ai-review-foot">
        <span>${esc(review.model || state.settings.ai.model || 'AI')} · ${esc(relativeTime(review.at))}</span>
        <span class="ai-review-foot-actions">
          <button class="text-link" type="button" data-ai-retry>重新点评</button>
          <button class="text-link" type="button" data-ai-settings>AI 设置</button>
        </span>
      </div>
      <p class="ai-disclaimer">AI 覆盖率是表达完整度的粗略估计，不是考试分数；请以参考答案和自己的判断为准。</p>
    </div>`;
    output.querySelector('[data-ai-retry]')?.addEventListener('click', runAIReview);
    output.querySelector('[data-ai-settings]')?.addEventListener('click', openAISettings);
  }

  async function runAIReview() {
    const q = currentQuestion();
    const s = ui.session;
    if (!q || !s || !s.revealed) return;
    if (!ensureAIReady() || ui.aiBusy.review) return;
    const userAnswer = $('#answerInput').value.trim();
    if (!userAnswer) {
      toast('先写下你的答案，再让 AI 对照参考答案。', 'info', 2800);
      $('#answerInput').focus();
      return;
    }
    if (!q.answer) {
      toast('这道题没有参考答案，暂时无法点评。', 'info');
      return;
    }
    const output = $('#aiOutput');
    if (output) {
      output.hidden = false;
      output.classList.remove('is-error');
      output.innerHTML = aiLoadingHTML('AI 正在对照参考答案…');
    }
    setAIBusy('review', true);
    try {
      const raw = await window.ShifenAI.reviewAnswer({
        question: q.question,
        reference: q.answer,
        keywords: q.keywords,
        userAnswer
      });
      const review = normalizeAIReview({
        ...(raw && typeof raw === 'object' ? raw : {}),
        at: Date.now(),
        model: state.settings.ai.model
      });
      if (!review) throw new Error('AI 返回的点评内容为空。');
      state.aiReviews[q.id] = review;
      saveNow();
      if (currentQuestion()?.id === q.id) renderAIReview(q, review, false);
      toast('AI 点评完成，仅供参考。', 'success', 2600);
    } catch (error) {
      const message = error?.message || 'AI 调用失败，请检查配置。';
      if (currentQuestion()?.id === q.id) renderAIError(message, runAIReview);
      toast(message, 'error', 4200);
    } finally {
      setAIBusy('review', false);
      if (currentQuestion()?.id === q.id) updateAIButtons(q);
    }
  }

  async function runAIKeywords() {
    const q = currentQuestion();
    if (!q || !ui.session?.revealed) return;
    if (!ensureAIReady() || ui.aiBusy.keywords) return;
    if (!q.answer) {
      toast('这道题没有参考答案，暂时无法提取关键词。', 'info');
      return;
    }
    const output = $('#aiOutput');
    if (output && output.hidden) {
      output.hidden = false;
      output.classList.remove('is-error');
      output.innerHTML = aiLoadingHTML('AI 正在提取关键词…', '会提取 3–8 个可用于自检的要点。');
    }
    setAIBusy('keywords', true);
    try {
      const raw = await window.ShifenAI.extractKeywords({
        question: q.question,
        reference: q.answer,
        existingKeywords: q.keywords || []
      });
      const list = Array.isArray(raw) ? raw : (raw?.keywords || []);
      const existing = new Set((q.keywords || []).map((k) => normalizeForMatch(k)));
      let added = 0;
      list.forEach((keyword) => {
        const text = String(keyword || '').trim();
        const key = normalizeForMatch(text);
        if (!text || !key || existing.has(key) || q.keywords.length >= 8) return;
        existing.add(key);
        q.keywords.push(text);
        added += 1;
      });
      q.keywords = q.keywords.slice(0, 8);
      saveNow();
      if (currentQuestion()?.id === q.id) {
        renderKeywordChips(q, $('#answerInput').value);
        updateAIButtons(q);
        if (output) {
          output.hidden = false;
          output.classList.remove('is-error');
          output.innerHTML = `<div class="ai-inline-success">${icon('check')}已${added ? `补充 ${added} 个` : '检查'}关键词：${q.keywords.length ? q.keywords.map((k) => `<span>${esc(k)}</span>`).join('') : '暂无'}</div>`;
        }
      }
      toast(added ? `AI 已补充 ${added} 个关键词。` : 'AI 没有返回新的关键词。', added ? 'success' : 'info', 3000);
    } catch (error) {
      const message = error?.message || 'AI 提取关键词失败。';
      if (currentQuestion()?.id === q.id) renderAIError(message, runAIKeywords);
      toast(message, 'error', 4200);
    } finally {
      setAIBusy('keywords', false);
      if (currentQuestion()?.id === q.id) updateAIButtons(q);
    }
  }

  function rateQuestion(rating) {
    const s = ui.session;
    const q = currentQuestion();
    if (!s || !q || !s.revealed) return;
    if (rating < 0 || rating > 3) return;
    clearTimeout(ui.autoNextTimer);
    const p = ensureProgress(q.id);
    const oldMastery = p.attempts > 0 ? p.mastery : null;
    const targetMastery = RATING_MASTERY[rating];
    p.mastery = oldMastery == null
      ? targetMastery
      : Math.round(oldMastery * 0.35 + targetMastery * 0.65);
    p.attempts += 1;
    p.lastRating = rating;
    p.lastAt = Date.now();
    p.history = (p.history || []).concat({ at: p.lastAt, rating }).slice(-50);
    s.ratings[q.id] = rating;
    bumpActivity();
    saveNow();
    renderShell();
    renderRatingState(q);
    updatePracticeProgress(s);
    updatePracticeAside(s);
    const saved = $('#ratingSaved');
    saved.classList.remove('is-visible');
    void saved.offsetWidth;
    saved.classList.add('is-visible');
    const btn = document.querySelector(`#ratingBar .rating-btn[data-rating="${rating}"]`);
    if (btn) {
      btn.classList.remove('just-rated');
      void btn.offsetWidth;
      btn.classList.add('just-rated');
    }
    if (state.settings.autoNext && s.index < s.queue.length - 1) {
      ui.autoNextTimer = setTimeout(() => nextQuestion(), 850);
    }
  }

  function nextQuestion() {
    clearTimeout(ui.autoNextTimer);
    const s = ui.session;
    if (!s) return;
    if (s.index < s.queue.length) {
      s.index += 1;
      s.revealed = false;
      persistCursor();
      if (s.index >= s.queue.length) {
        renderPractice();
      } else {
        renderPractice();
      }
    }
  }

  function previousQuestion() {
    clearTimeout(ui.autoNextTimer);
    const s = ui.session;
    if (!s || s.index <= 0) return;
    s.index -= 1;
    s.revealed = false;
    persistCursor();
    renderPractice();
  }

  function toggleFavorite(qid = null) {
    const q = qid ? getQuestion(qid) : currentQuestion();
    if (!q) return;
    const p = ensureProgress(q.id);
    p.favorite = !p.favorite;
    p.favoriteAt = p.favorite ? Date.now() : 0;
    saveSoon();
    renderShell();
    if (ui.view === 'practice' && q.id === currentQuestion()?.id) {
      const favBtn = $('#practiceFavorite');
      favBtn.classList.toggle('is-active', p.favorite);
      favBtn.setAttribute('aria-pressed', String(p.favorite));
      favBtn.setAttribute('aria-label', p.favorite ? '取消收藏本题' : '收藏本题');
      favBtn.title = p.favorite ? '取消收藏' : '收藏本题';
    }
    if (ui.view === 'favorites') renderCurrentView();
    toast(p.favorite ? '已收藏这道题' : '已取消收藏', 'success', 1600);
  }

  /* ---------------------------------------------------------------------
     仪表盘
     --------------------------------------------------------------------- */
  function renderDashboard(root) {
    const bank = getActiveBank();
    const daily = state.activity[dateKey()]?.count || 0;
    const goal = state.settings.dailyGoal;
    const goalPct = clamp(Math.round((daily / goal) * 100), 0, 100);
    const streak = calcStreak();
    const snapshot = statsSnapshot();
    const wrong = getWrongQuestions().length;
    const recentBanks = state.banks.slice().sort((a, b) => {
      if (a.id === state.ui.lastBankId) return -1;
      if (b.id === state.ui.lastBankId) return 1;
      return b.createdAt - a.createdAt;
    }).slice(0, 3);
    const series = activitySeries(7);
    const maxCount = Math.max(1, ...series.map((d) => d.count));
    const weakTags = tagStats().filter((t) => t.attempted > 0).slice(0, 5);

    let hero;
    if (!bank) {
      hero = `
        <section class="hero hero-empty card">
          <div class="hero-main">
            <span class="hero-kicker">开始之前</span>
            <h2>把要背的简答题，<br>变成会答的题。</h2>
            <p>导入现有的 Excel 或 Word 题库，拾分会自动整理题目、答案和关键词。</p>
            <div class="hero-actions">
              <button class="btn btn-accent" data-action="import">${icon('upload')}导入题库</button>
              <button class="btn btn-ghost" data-action="load-sample">先看看示例</button>
            </div>
          </div>
          <div class="hero-art" aria-hidden="true"><div class="hero-glyph">学</div><div class="hero-vertical">温故而知新</div></div>
        </section>`;
    } else if (!getBankQuestions(bank.id).length) {
      hero = `
        <section class="hero card">
          <div class="hero-main">
            <span class="hero-kicker">题库已就绪</span>
            <h2>${esc(bank.name)}</h2>
            <p>这个题库还没有题目。导入一份文档，开始第一轮练习。</p>
            <div class="hero-actions">
              <button class="btn btn-accent" data-action="import">${icon('upload')}导入题目</button>
              <button class="btn btn-ghost" data-action="open-bank" data-bank-id="${esc(bank.id)}">查看题库</button>
            </div>
          </div>
          <div class="hero-art" aria-hidden="true"><div class="hero-glyph">答</div><div class="hero-vertical">温故而知新</div></div>
        </section>`;
    } else {
      const bs = bankStats(bank.id);
      const cursor = state.sessions[bank.id]?.cursor || 0;
      const left = cursor >= bs.total ? 0 : bs.total - cursor;
      const roundDone = cursor >= bs.total;
      const started = bs.attempted > 0 || cursor > 0;
      hero = `
        <section class="hero card">
          <div class="hero-main">
            <span class="hero-kicker">${roundDone ? '上一轮已完成' : started ? '继续上次练习' : '开始新一轮'}</span>
            <h2>${esc(bank.name)}</h2>
            <p>${esc(bank.description || '按自己的节奏，一道一道把答案写出来。')}</p>
            <div class="hero-progress">
              <div class="meta-row"><span>本轮进度</span><strong>${roundDone ? '已完成' : `${cursor} / ${bs.total}`}</strong></div>
              <div class="mastery-track"><span style="width:${bs.total ? Math.round((cursor / bs.total) * 100) : 0}%"></span></div>
            </div>
            <div class="hero-actions">
              <button class="btn btn-accent" data-action="start-bank" data-bank-id="${esc(bank.id)}" data-restart="${roundDone ? '1' : '0'}">
                ${roundDone ? `${icon('rotate')}再练一轮` : `${icon('play')}${started ? `继续练习 · 还剩 ${left} 题` : `开始练习 · ${bs.total} 题`}`}
              </button>
              <span class="hero-hint">${bs.attempted ? `${bs.attempted} 题已练 · 平均掌握 ${bs.mastery}%` : `共 ${bs.total} 题 · 预计 ${Math.max(3, Math.round(bs.total * 1.2))} 分钟`}</span>
            </div>
          </div>
          <div class="hero-art" aria-hidden="true">
            <div class="hero-glyph">答</div>
            <div class="hero-vertical">温故而知新</div>
            <div class="hero-stamp">拾分</div>
          </div>
        </section>`;
    }

    root.innerHTML = `
      <div class="page-head dashboard-head">
        <div>
          <p class="eyebrow">${formatLongDate()}</p>
          <h1>${greeting()}，<em>今天也来答几题。</em></h1>
          <p class="lede">${daily >= goal ? '今天的目标已经完成，继续加练也很好。' : `今天已经答了 ${daily} 题，离小目标还差 ${goal - daily} 题。`}</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-action="import">${icon('upload')}导入题库</button>
          <button class="btn btn-ghost" data-action="open-settings">${icon('target')}每日 ${goal} 题</button>
        </div>
      </div>

      ${hero}

      <div class="stat-grid">
        <article class="stat-card card">
          <div class="stat-icon">${icon('target')}</div>
          <span class="stat-label">今日已练</span>
          <strong class="stat-value">${daily}<small> 题</small></strong>
          <div class="mini-track"><span style="width:${goalPct}%"></span></div>
          <span class="stat-note">目标 ${goal} 题 · ${goalPct}%</span>
        </article>
        <article class="stat-card card">
          <div class="stat-icon">${icon('flame')}</div>
          <span class="stat-label">连续学习</span>
          <strong class="stat-value">${streak}<small> 天</small></strong>
          <div class="stat-foot">${streak > 0 ? '保持节奏，比一次练很久更重要' : '从今天开始，点亮第一天'}</div>
        </article>
        <article class="stat-card card">
          <div class="stat-icon">${icon('chart')}</div>
          <span class="stat-label">平均掌握度</span>
          <strong class="stat-value">${snapshot.attempted ? snapshot.avgMastery : '—'}<small>${snapshot.attempted ? '%' : ''}</small></strong>
          <div class="stat-foot">${snapshot.attempted} 道题参与统计</div>
        </article>
        <article class="stat-card card">
          <div class="stat-icon is-alert">${icon('alert')}</div>
          <span class="stat-label">待复习</span>
          <strong class="stat-value">${wrong}<small> 道</small></strong>
          <div class="stat-foot">${wrong ? `<button class="text-link" data-action="practice-wrong">去清一清错题 ${icon('arrow-right')}</button>` : '暂时没有错题，很好'}</div>
        </article>
      </div>

      <div class="dashboard-grid">
        <section class="card recent-card">
          <div class="card-head">
            <div><p class="eyebrow">题库</p><h3>最近在练</h3></div>
            <button class="text-link" data-action="go-banks">全部题库${icon('arrow-right')}</button>
          </div>
          ${recentBanks.length ? `<div class="bank-mini-list">${recentBanks.map((b) => {
            const bs = bankStats(b.id);
            return `<button class="bank-mini" data-action="open-bank" data-bank-id="${esc(b.id)}">
              <span class="bank-mini-mark">${esc(Array.from(b.name)[0] || '题')}</span>
              <span class="bank-mini-main"><strong>${esc(b.name)}</strong><small>${bs.total} 题 · ${bs.attempted} 题已练</small></span>
              <span class="bank-mini-meter"><span style="width:${bs.mastery}%"></span></span>
              <span class="bank-mini-pct">${bs.mastery}%</span>
              ${icon('chevron-right', 'bank-mini-arrow')}
            </button>`;
          }).join('')}</div>` : `<div class="mini-empty">还没有题库，导入第一份吧。<button class="text-link" data-action="import">去导入 ${icon('arrow-right')}</button></div>`}
          <div class="recent-foot">
            <button class="btn btn-ghost btn-sm" data-action="import">${icon('plus')}添加题库</button>
            <span class="muted">数据只保存在这台电脑的浏览器里</span>
          </div>
        </section>

        <section class="card week-card">
          <div class="card-head"><div><p class="eyebrow">节奏</p><h3>最近 7 天</h3></div><span class="week-total">${series.reduce((s, d) => s + d.count, 0)} 次练习</span></div>
          <div class="bar-chart" role="img" aria-label="最近七天练习次数">
            ${series.map((d) => {
              const h = d.count ? Math.max(8, Math.round((d.count / maxCount) * 100)) : 0;
              return `<div class="bar-col ${d.isToday ? 'is-today' : ''} ${d.count ? '' : 'is-zero'}" title="${d.label} · ${d.count} 次">
                <span class="bar-value">${d.count || ''}</span>
                <div class="bar-track"><span class="bar-fill" style="height:${h}%"></span></div>
                <span class="bar-label">${d.isToday ? '今天' : `周${d.week}`}</span>
              </div>`;
            }).join('')}
          </div>
          <div class="week-note">${daily >= goal ? '今日目标已完成，给自己留一点间隔。' : '少量、多次、带自测，比一次刷很久更有效。'}</div>
        </section>
      </div>

      <div class="dashboard-grid lower">
        <section class="card weak-card">
          <div class="card-head"><div><p class="eyebrow">关注</p><h3>需要再巩固的知识点</h3></div>${weakTags.length ? `<button class="text-link" data-action="go-stats">看统计${icon('arrow-right')}</button>` : ''}</div>
          ${weakTags.length ? `<div class="weak-list">${weakTags.map((t) => `
            <button class="weak-item" data-action="practice-tag" data-tag="${esc(t.tag)}">
              <span class="weak-name">${esc(t.tag)}</span>
              <span class="weak-meter"><span style="width:${t.mastery}%"></span></span>
              <span class="weak-pct">${t.mastery}%</span>
              ${icon('arrow-right', 'weak-arrow')}
            </button>`).join('')}</div>` : `<div class="mini-empty">练习几道题后，这里会按知识点显示你的掌握情况。</div>`}
        </section>

        <section class="card tip-card">
          <div class="tip-mark" aria-hidden="true">法</div>
          <div>
            <p class="eyebrow">今日小建议</p>
            <h3>${wrong ? '先清错题，再刷新题' : daily < goal ? '先写，再对答案' : '去散个步，让记忆沉淀'}</h3>
            <p>${wrong ? `有 ${wrong} 道题上次没想起来。先不急着看答案，试着回忆一次，再对照。` : daily < goal ? '简答题的价值在“提取”。哪怕只记得两三点，也先写下来，再打开参考答案。' : '睡眠和间隔会帮助巩固。今天到这里就很好，明天再回来自测一次。'}</p>
            <div class="tip-actions">
              ${wrong ? `<button class="btn btn-soft btn-sm" data-action="practice-wrong">错题重练 ${icon('arrow-right')}</button>` : `<button class="btn btn-soft btn-sm" data-action="practice">继续练习 ${icon('arrow-right')}</button>`}
            </div>
          </div>
        </section>
      </div>`;
  }

  /* ---------------------------------------------------------------------
     题库视图
     --------------------------------------------------------------------- */
  function renderBanks(root) {
    if (ui.selectedBankId) {
      const bank = getBank(ui.selectedBankId);
      if (bank) {
        renderBankDetail(root, bank);
        return;
      }
      ui.selectedBankId = null;
    }

    const banks = state.banks.slice().sort((a, b) => b.createdAt - a.createdAt);
    const templateHref = window.ShifenAndroid ? 'templates/template.xlsx' : 'templates/简答题导入模板.xlsx';
    root.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">你的资料库</p>
          <h1>题库<em>（${state.questions.length} 题）</em></h1>
          <p class="lede">从 Excel、Word 里导入题目，拾分会把题干、答案和关键词整理好。</p>
        </div>
        <div class="head-actions">
          <a class="btn btn-ghost" href="${templateHref}" download>${icon('download')}下载模板</a>
          <button class="btn btn-primary" data-action="import">${icon('upload')}导入题库</button>
        </div>
      </div>

      ${banks.length ? `
      <div class="toolbar">
        <label class="search-box">${icon('search')}<input id="bankSearch" type="search" placeholder="搜索题库、标签或来源" autocomplete="off" value="${esc(ui.bankQuery)}"><kbd>/</kbd></label>
        <span class="toolbar-note">${banks.length} 个题库</span>
      </div>
      <div class="bank-grid" id="bankGrid">
        ${banks.map((bank, i) => {
          const bs = bankStats(bank.id);
          const tone = (i % 3) + 1;
          const searchText = [
            bank.name,
            bank.sourceType,
            bank.description,
            ...getBankQuestions(bank.id).flatMap((q) => q.tags)
          ].join(' ').toLowerCase();
          return `<article class="bank-card card tone-${tone}" data-action="open-bank" data-bank-id="${esc(bank.id)}" data-search="${esc(searchText)}">
            <div class="bank-card-top">
              <span class="bank-spine"><span>${esc(Array.from(bank.name)[0] || '题')}</span></span>
              <div class="bank-title-wrap">
                <div class="bank-title-line"><h3>${esc(bank.name)}</h3>${bank.isSample ? '<span class="sample-badge">示例</span>' : ''}</div>
                <p>${bs.total} 题 · ${esc(bank.sourceType || '导入')}</p>
              </div>
            </div>
            <p class="bank-desc">${esc(bank.description || '一份属于你的简答题库。')}</p>
            <div class="bank-meter-head"><span>平均掌握</span><strong>${bs.attempted ? `${bs.mastery}%` : '未开始'}</strong></div>
            <div class="mastery-track"><span style="width:${bs.mastery}%"></span></div>
            <div class="bank-card-foot">
              <span class="muted">${bs.attempted} / ${bs.total} 题已练</span>
              <button class="btn btn-sm btn-soft" data-action="start-bank" data-bank-id="${esc(bank.id)}" data-restart="0">${icon('play')}练习</button>
            </div>
          </article>`;
        }).join('')}
        <article class="bank-import-card card">
          <span class="bank-import-icon">${icon('upload')}</span>
          <div class="bank-import-copy">
            <h3>再把一份资料变成题库</h3>
            <p>Excel、Word、CSV 或纯文本都可以。表头里有「题目 / 参考答案」就能识别。</p>
          </div>
          <div class="bank-import-actions">
            <button class="btn btn-primary btn-sm" data-action="import">${icon('plus')}导入题库</button>
            <button class="text-link" data-action="download-template">${icon('download')}下载模板</button>
          </div>
        </article>
      </div>
      <div class="mini-empty search-empty" id="bankSearchEmpty" hidden>没有找到匹配的题库。换个关键词，或导入新的题库。</div>
      ` : `<div class="empty-state card">${emptyArt()}<h2>还没有自己的题库</h2><p>把要背的简答题整理成一份 Excel，或者直接导入现有的 Word 资料。</p><div class="empty-actions"><button class="btn btn-primary" data-action="import">${icon('upload')}导入第一份题库</button><button class="btn btn-ghost" data-action="load-sample">载入示例题库</button></div><p class="empty-hint">常见格式：.xlsx / .docx / .csv / .txt / .md / .json</p></div>`}`;

    const search = $('#bankSearch');
    if (search) {
      const applyFilter = () => {
        ui.bankQuery = search.value;
        const term = search.value.trim().toLowerCase();
        let visible = 0;
        $$('#bankGrid .bank-card').forEach((card) => {
          const match = !term || (card.dataset.search || '').includes(term);
          card.hidden = !match;
          if (match) visible += 1;
        });
        const empty = $('#bankSearchEmpty');
        if (empty) empty.hidden = visible > 0 || !term;
      };
      search.addEventListener('input', applyFilter);
      if (ui.bankQuery) applyFilter();
    }
  }

  function renderBankDetail(root, bank) {
    const qs = getBankQuestions(bank.id);
    const bs = bankStats(bank.id);
    const cursor = state.sessions[bank.id]?.cursor || 0;
    const progressPct = bs.total ? Math.round((bs.attempted / bs.total) * 100) : 0;

    root.innerHTML = `
      <button class="back-link" data-action="back-banks">${icon('arrow-left')}全部题库</button>
      <div class="bank-detail-head">
        <div class="bank-detail-title">
          <span class="bank-spine bank-spine-lg"><span>${esc(Array.from(bank.name)[0] || '题')}</span></span>
          <div>
            <p class="eyebrow">${esc(bank.sourceType || '题库')}${bank.isSample ? ' · 内置示例' : ''}</p>
            <h1>${esc(bank.name)}</h1>
            <p class="lede">${esc(bank.description || '按自己的节奏，把每一道题答成自己的。')}</p>
          </div>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-action="export-bank" data-bank-id="${esc(bank.id)}">${icon('download')}导出</button>
          <button class="btn btn-ghost" data-action="rename-bank" data-bank-id="${esc(bank.id)}">${icon('edit')}重命名</button>
          <button class="icon-btn danger-hover" data-action="delete-bank" data-bank-id="${esc(bank.id)}" title="删除题库" aria-label="删除题库">${icon('trash')}</button>
          <button class="btn btn-primary" data-action="start-bank" data-bank-id="${esc(bank.id)}" data-restart="0">${icon('play')}${cursor > 0 && cursor < qs.length ? '继续练习' : '开始练习'}</button>
        </div>
      </div>

      <div class="detail-metrics">
        <div class="detail-metric card"><span>题目总数</span><strong>${bs.total}</strong></div>
        <div class="detail-metric card"><span>已练习</span><strong>${bs.attempted}<small> / ${bs.total}</small></strong></div>
        <div class="detail-metric card"><span>平均掌握</span><strong>${bs.attempted ? `${bs.mastery}%` : '—'}</strong></div>
        <div class="detail-metric card"><span>错题</span><strong>${bs.wrong}</strong></div>
      </div>

      <div class="card detail-progress-card">
        <div class="meta-row"><span>练习覆盖率</span><strong>${progressPct}%</strong></div>
        <div class="mastery-track"><span style="width:${progressPct}%"></span></div>
      </div>

      <section class="card question-table-card">
        <div class="card-head table-card-head">
          <div><p class="eyebrow">题目列表</p><h3>共 ${qs.length} 道简答题</h3></div>
          <label class="search-box search-box-sm">${icon('search')}<input id="bankQuestionSearch" type="search" placeholder="搜索题干或标签" autocomplete="off"></label>
        </div>
        ${qs.length ? `<div class="question-rows" id="bankQuestionRows">
          ${qs.map((q, i) => {
            const p = getProgress(q.id);
            const m = p?.attempts ? p.mastery : null;
            const searchText = `${q.question} ${q.tags.join(' ')} ${q.answer}`.toLowerCase();
            return `<div class="question-row" data-search="${esc(searchText)}">
              <span class="row-index">${String(i + 1).padStart(2, '0')}</span>
              <div class="row-main">
                <p class="row-question">${esc(q.question)}</p>
                <div class="row-meta"><span>${difficultyDots(q.difficulty)}</span>${(q.tags || []).slice(0, 3).map((t) => `<span class="tag tag-sm">${esc(t)}</span>`).join('')}</div>
              </div>
              <div class="row-side">
                <span class="mastery-pill tone-${masteryTone(m || 0)}">${m == null ? '未练' : `${m}% · ${masteryLabel(m)}`}</span>
                <button class="btn btn-sm btn-ghost" data-action="practice-one" data-mode="bank" data-bank-id="${esc(bank.id)}" data-id="${esc(q.id)}">练这题</button>
              </div>
            </div>`;
          }).join('')}
        </div>` : `<div class="mini-empty table-empty">这个题库还没有题目。<button class="text-link" data-action="import">导入题目 ${icon('arrow-right')}</button></div>`}
        <div class="mini-empty search-empty" id="bankQuestionEmpty" hidden>没有匹配的题目。</div>
      </section>`;

    const search = $('#bankQuestionSearch');
    if (search) {
      search.addEventListener('input', () => {
        const term = search.value.trim().toLowerCase();
        let visible = 0;
        $$('#bankQuestionRows .question-row').forEach((row) => {
          const match = !term || (row.dataset.search || '').includes(term);
          row.hidden = !match;
          if (match) visible += 1;
        });
        const empty = $('#bankQuestionEmpty');
        if (empty) empty.hidden = visible > 0;
      });
    }
  }

  /* ---------------------------------------------------------------------
     错题 / 收藏
     --------------------------------------------------------------------- */
  function renderReview(root, mode) {
    const isWrong = mode === 'wrong';
    const items = isWrong ? getWrongQuestions() : getFavoriteQuestions();
    const title = isWrong ? '错题本' : '收藏夹';
    const eyebrow = isWrong ? '把不会的，变成会的' : '留住值得再看的题';
    const desc = isWrong
      ? '这里收着上次自评“忘记”或“模糊”的题。间隔一天再来，比重读答案更有效。'
      : '练习时点右上角的星标，题目就会出现在这里。';

    root.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">${eyebrow}</p>
          <h1>${title}<em>（${items.length} 题）</em></h1>
          <p class="lede">${desc}</p>
        </div>
        <div class="head-actions">
          ${items.length ? `<button class="btn btn-primary" data-action="practice-${isWrong ? 'wrong' : 'favorites'}">${icon('play')}全部重练</button>` : ''}
          <button class="btn btn-ghost" data-action="import">${icon('upload')}导入题库</button>
        </div>
      </div>

      ${items.length ? `
        <div class="toolbar">
          <label class="search-box">${icon('search')}<input id="reviewSearch" type="search" placeholder="搜索题目、答案或标签" autocomplete="off"></label>
          <span class="toolbar-note">${isWrong ? '自评“忘记 / 模糊”的题会自动收进来' : '收藏的题不会自动移出'}</span>
        </div>
        <div class="review-list card" id="reviewList">
          ${items.map((q, i) => {
            const p = getProgress(q.id) || {};
            const bank = getBank(q.bankId);
            const rating = p.lastRating != null ? p.lastRating : 0;
            const searchText = `${q.question} ${q.answer} ${q.tags.join(' ')} ${bank?.name || ''}`.toLowerCase();
            return `<article class="review-row" data-search="${esc(searchText)}">
              <span class="review-index">${String(i + 1).padStart(2, '0')}</span>
              <div class="review-main">
                <div class="review-top">
                  <span class="tag tag-sm">${esc(bank?.name || '未知题库')}</span>
                  <span class="rating-pill rating-${rating}">${isWrong ? RATING_LABELS[rating] : RATING_LABELS[rating] || '已收藏'}</span>
                  ${p.favorite && !isWrong ? `<span class="favorite-mark">${icon('star')}已收藏</span>` : ''}
                </div>
                <p class="review-question">${esc(q.question)}</p>
                <div class="review-meta"><span>${relativeTime(p.lastAt)}</span><span class="dot" aria-hidden="true"></span><span>掌握度 ${p.mastery || 0}%</span><span class="dot" aria-hidden="true"></span><span>${esc(q.tags.slice(0, 3).join(' · '))}</span></div>
              </div>
              <div class="review-side">
                <div class="mastery-track review-track"><span style="width:${p.mastery || 0}%"></span></div>
                <button class="btn btn-sm btn-soft" data-action="practice-one" data-mode="${mode}" data-id="${esc(q.id)}">重练 ${icon('arrow-right')}</button>
              </div>
            </article>`;
          }).join('')}
        </div>
        <div class="mini-empty search-empty" id="reviewSearchEmpty" hidden>没有匹配的题目。</div>
      ` : `<div class="empty-state card">${emptyArt(isWrong ? 'wrong' : 'star')}<h2>${isWrong ? '错题本还是空的' : '还没有收藏的题'}</h2><p>${isWrong ? '去练习几道题。自评时选“忘记”或“模糊”，题目会自动收进这里。' : '练习时点右上角的星标，或打开参考答案后收藏，之后随时回来复习。'}</p><div class="empty-actions"><button class="btn btn-primary" data-action="practice">去练习</button><button class="btn btn-ghost" data-action="go-banks">看看题库</button></div></div>`}`;

    const search = $('#reviewSearch');
    if (search) {
      search.addEventListener('input', () => {
        const term = search.value.trim().toLowerCase();
        let visible = 0;
        $$('#reviewList .review-row').forEach((row) => {
          const match = !term || (row.dataset.search || '').includes(term);
          row.hidden = !match;
          if (match) visible += 1;
        });
        const empty = $('#reviewSearchEmpty');
        if (empty) empty.hidden = visible > 0;
      });
    }
  }

  /* ---------------------------------------------------------------------
     统计视图
     --------------------------------------------------------------------- */
  function renderStats(root) {
    const snapshot = statsSnapshot();
    const series = activitySeries(14);
    const max = Math.max(1, ...series.map((d) => d.count));
    const tags = tagStats();
    const attemptedTags = tags.filter((t) => t.attempted > 0).slice(0, 8);
    const streak = calcStreak();
    const weekCount = series.slice(-7).reduce((sum, d) => sum + d.count, 0);
    const weekGoal = state.settings.dailyGoal * 7;

    root.innerHTML = `
      <div class="page-head">
        <div>
          <p class="eyebrow">看见积累</p>
          <h1>学习统计</h1>
          <p class="lede">不追求一次记住，关注“有没有在回来”。</p>
        </div>
        <div class="head-actions">
          <button class="btn btn-ghost" data-action="open-settings">${icon('target')}调整目标</button>
          <button class="btn btn-primary" data-action="practice">${icon('play')}继续练习</button>
        </div>
      </div>

      <section class="stats-hero card">
        <div class="donut-wrap">
          <div class="donut" style="background:${snapshot.donut}">
            <div class="donut-hole"><strong>${snapshot.total}</strong><span>道题</span></div>
          </div>
        </div>
        <div class="stats-hero-main">
          <div class="stats-hero-head">
            <div><p class="eyebrow">总体掌握</p><h2>${snapshot.attempted ? `${snapshot.avgMastery}%` : '从第一题开始'}</h2></div>
            <span class="streak-badge">${icon('flame')}连续 ${streak} 天</span>
          </div>
          <p class="stats-summary-text">${snapshot.attempted ? `已练 ${snapshot.attempted} 道，其中 ${snapshot.mastered} 道达到掌握以上。继续保持“先写再对”的节奏。` : '还没有练习记录。选一个题库，先答三道题，统计就会开始生长。'}</p>
          <div class="legend">
            ${snapshot.buckets.map((b) => `<span class="legend-item"><i style="background:${b.color}"></i>${b.label}<strong>${b.count}</strong></span>`).join('')}
          </div>
          <div class="stats-kpis">
            <div><strong>${snapshot.attempts}</strong><span>累计作答</span></div>
            <div><strong>${snapshot.wrong}</strong><span>待复习错题</span></div>
            <div><strong>${snapshot.favorites}</strong><span>收藏题目</span></div>
            <div><strong>${weekCount}<small> / ${weekGoal}</small></strong><span>本周练习</span></div>
          </div>
        </div>
      </section>

      <div class="stats-grid">
        <section class="card chart-card">
          <div class="card-head"><div><p class="eyebrow">节奏</p><h3>最近 14 天</h3></div><span class="week-total">${series.reduce((s, d) => s + d.count, 0)} 次</span></div>
          <div class="bar-chart bar-chart-wide" role="img" aria-label="最近十四天练习次数">
            ${series.map((d, i) => {
              const h = d.count ? Math.max(6, Math.round((d.count / max) * 100)) : 0;
              return `<div class="bar-col ${d.isToday ? 'is-today' : ''} ${d.count ? '' : 'is-zero'}" title="${d.label} · ${d.count} 次">
                <span class="bar-value">${d.count || ''}</span>
                <div class="bar-track"><span class="bar-fill" style="height:${h}%"></span></div>
                <span class="bar-label">${i % 2 === 0 || d.isToday ? (d.isToday ? '今天' : d.label) : ''}</span>
              </div>`;
            }).join('')}
          </div>
          <p class="chart-note">${weekCount ? `本周已经练习 ${weekCount} 次，目标是 ${weekGoal} 次。` : '本周还没有记录，今天答一道也算开始。'}</p>
        </section>

        <section class="card tag-card">
          <div class="card-head"><div><p class="eyebrow">知识点</p><h3>掌握度分布</h3></div></div>
          ${attemptedTags.length ? `<div class="tag-stats">${attemptedTags.map((t) => `
            <div class="tag-stat">
              <div class="tag-stat-head"><span>${esc(t.tag)}</span><strong class="tone-${masteryTone(t.mastery)}">${t.mastery}%</strong></div>
              <div class="mastery-track"><span style="width:${t.mastery}%"></span></div>
              <small>${t.total} 题 · 已练 ${t.attempted}</small>
            </div>`).join('')}</div>` : `<div class="mini-empty">练习并自评后，这里会显示各知识点的掌握度。</div>`}
        </section>
      </div>

      <section class="card bank-stats-card">
        <div class="card-head"><div><p class="eyebrow">题库</p><h3>各题库进度</h3></div><button class="text-link" data-action="go-banks">管理题库${icon('arrow-right')}</button></div>
        ${state.banks.length ? `<div class="bank-stat-table">
          <div class="bank-stat-head"><span>题库</span><span>题量</span><span>已练</span><span>平均掌握</span><span></span></div>
          ${state.banks.map((b) => {
            const bs = bankStats(b.id);
            return `<div class="bank-stat-row">
              <span class="bank-stat-name">${esc(b.name)}${b.isSample ? ' <em>示例</em>' : ''}</span>
              <span>${bs.total}</span>
              <span>${bs.attempted}</span>
              <span class="bank-stat-meter"><span class="mastery-track"><span style="width:${bs.mastery}%"></span></span><strong>${bs.attempted ? `${bs.mastery}%` : '—'}</strong></span>
              <button class="text-link" data-action="open-bank" data-bank-id="${esc(b.id)}">查看${icon('chevron-right')}</button>
            </div>`;
          }).join('')}
        </div>` : `<div class="mini-empty">还没有题库。<button class="text-link" data-action="import">导入一份 ${icon('arrow-right')}</button></div>`}
      </section>`;
  }

  /* ---------------------------------------------------------------------
     空状态插画
     --------------------------------------------------------------------- */
  function emptyArt(kind = 'cards') {
    const glyph = kind === 'wrong' ? '!' : kind === 'star' ? '★' : '答';
    return `<div class="empty-art" aria-hidden="true">
      <svg viewBox="0 0 200 150" fill="none">
        <ellipse cx="100" cy="132" rx="58" ry="8" fill="var(--line)" opacity=".55"/>
        <rect x="42" y="46" width="96" height="70" rx="10" transform="rotate(-6 90 81)" fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="1.4"/>
        <rect x="56" y="34" width="96" height="72" rx="10" transform="rotate(3 104 70)" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.4"/>
        <path d="M76 60h48M76 72h34M76 84h42" stroke="var(--line-strong)" stroke-width="3" stroke-linecap="round" opacity=".65"/>
        <circle cx="151" cy="36" r="19" fill="var(--accent)"/>
        <text x="151" y="42" text-anchor="middle" font-size="16" font-family="Georgia, 'Songti SC', serif" fill="var(--seal-text)">${glyph}</text>
      </svg>
    </div>`;
  }

  /* ---------------------------------------------------------------------
     弹窗基础设施
     --------------------------------------------------------------------- */
  function openModal({ size = 'md', html, onMount, onClose, labelledBy = '' }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal modal-${size}" role="dialog" aria-modal="true" ${labelledBy ? `aria-labelledby="${labelledBy}"` : ''} tabindex="-1">${html}</div>`;
    $('#modalRoot').appendChild(overlay);
    const modal = overlay.querySelector('.modal');
    const previousFocus = document.activeElement;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      overlay.classList.remove('is-open');
      const entry = modalStack.find((item) => item.overlay === overlay);
      if (entry) modalStack.splice(modalStack.indexOf(entry), 1);
      if (!modalStack.length) document.body.classList.remove('modal-open');
      setTimeout(() => overlay.remove(), 180);
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
      if (typeof onClose === 'function') onClose();
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
      if (event.target.closest('[data-close]')) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        const focusables = $$('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
          .filter((el) => el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    document.body.classList.add('modal-open');
    modalStack.push({ overlay, close });
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      const autofocus = overlay.querySelector('[autofocus]');
      if (autofocus) autofocus.focus();
      else modal.focus();
    });

    if (typeof onMount === 'function') onMount({ overlay, modal, close });
    return { overlay, modal, close };
  }

  function modalHead({ eyebrow = '', title, subtitle = '', id = '' }) {
    return `<div class="modal-head">
      <div>${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}<h2 ${id ? `id="${id}"` : ''}>${esc(title)}</h2>${subtitle ? `<p class="modal-sub">${esc(subtitle)}</p>` : ''}</div>
      <button class="icon-btn modal-close" data-close aria-label="关闭">${icon('close')}</button>
    </div>`;
  }

  function confirmDialog({ title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false }) {
    return new Promise((resolve) => {
      let result = false;
      const { overlay } = openModal({
        size: 'sm',
        html: `${modalHead({ eyebrow: danger ? '请确认' : '提示', title })}
          <div class="modal-body"><p class="confirm-message">${esc(message)}</p></div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-close>${esc(cancelLabel)}</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm>${esc(confirmLabel)}</button>
          </div>`,
        onClose: () => resolve(result)
      });
      overlay.querySelector('[data-confirm]').addEventListener('click', () => {
        result = true;
        const entry = modalStack.find((item) => item.overlay === overlay);
        if (entry) entry.close();
      });
    });
  }

  function promptDialog({ title, eyebrow = '', message = '', label = '名称', value = '', placeholder = '', confirmLabel = '保存' }) {
    return new Promise((resolve) => {
      let result = null;
      const { overlay } = openModal({
        size: 'sm',
        html: `${modalHead({ eyebrow, title })}
          <form id="promptForm">
            <div class="modal-body">
              ${message ? `<p class="confirm-message">${esc(message)}</p>` : ''}
              <label class="field"><span>${esc(label)}</span><input id="promptInput" type="text" maxlength="80" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus></label>
            </div>
            <div class="modal-foot">
              <button type="button" class="btn btn-ghost" data-close>取消</button>
              <button type="submit" class="btn btn-primary">${esc(confirmLabel)}</button>
            </div>
          </form>`,
        onClose: () => resolve(result)
      });
      const form = overlay.querySelector('#promptForm');
      const input = overlay.querySelector('#promptInput');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value2 = input.value.trim();
        if (!value2) {
          input.classList.add('is-invalid');
          input.focus();
          return;
        }
        result = value2;
        const entry = modalStack.find((item) => item.overlay === overlay);
        if (entry) entry.close();
      });
    });
  }

  /* ---------------------------------------------------------------------
     导入
     --------------------------------------------------------------------- */
  function downloadBlob(blob, filename) {
    if (window.ShifenAndroid && typeof window.ShifenAndroid.saveBase64 === 'function') {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const dataUrl = String(reader.result || '');
          const comma = dataUrl.indexOf(',');
          window.ShifenAndroid.saveBase64(filename, comma >= 0 ? dataUrl.slice(comma + 1) : '', blob.type || '');
        } catch (error) {
          toast('保存文件失败，请检查存储空间。', 'error');
        }
      };
      reader.onerror = () => toast('保存文件失败，请检查存储空间。', 'error');
      reader.readAsDataURL(blob);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function downloadText(text, filename, type = 'text/plain;charset=utf-8') {
    downloadBlob(new Blob([text], { type }), filename);
  }

  function buildTemplateCSVFallback() {
    const header = '题目,参考答案,关键词,解析,标签,难度\n';
    const rows = [
      '什么是间隔练习？,"把复习分散到不同时间点，每次都需要重新提取，从而增强长期记忆。","分散复习,重新提取,长期保持","核心是提取，不是重读。","记忆,学习方法",2',
      '请简述费曼学习法的步骤。,"选定概念；用简单语言讲给外行；发现漏洞后回到材料；简化并类比。","选定概念,简单讲解,发现漏洞,简化类比","讲解能暴露理解断点。","学习方法,输出",1'
    ];
    return `\uFEFF${header}${rows.join('\n')}\n`;
  }

  function downloadTemplate() {
    try {
      const text = (window.ShifenImport && typeof window.ShifenImport.buildTemplateCSV === 'function')
        ? window.ShifenImport.buildTemplateCSV()
        : buildTemplateCSVFallback();
      downloadText(text, '拾分-简答题导入模板.csv', 'text/csv;charset=utf-8');
      toast('模板已下载，填好后直接拖回来导入。', 'success');
    } catch (err) {
      console.error(err);
      toast('模板生成失败，请稍后重试。', 'error');
    }
  }

  function deriveBankName(files) {
    if (files.length === 1) {
      return files[0].name.replace(/\.[^.]+$/, '').slice(0, 60) || '导入题库';
    }
    return `导入题库 · ${formatShortDate()}`;
  }

  function openImportModal() {
    closeSidebar();
    ui.importDraft = {
      files: [],
      items: [],
      selected: new Set(),
      mode: 'new',
      bankName: '',
      bankId: state.banks[0]?.id || '',
      warnings: [],
      errors: [],
      loading: false,
      tab: 'file',
      sourceKind: 'file',
      aiSource: { name: '', text: '', warnings: [] },
      aiBusy: false
    };

    const supported = window.ShifenImport?.SUPPORTED_EXTENSIONS || ['xlsx', 'docx', 'csv', 'txt', 'md', 'json'];
    const templateHref = window.ShifenAndroid ? 'templates/template.xlsx' : 'templates/简答题导入模板.xlsx';
    const { overlay } = openModal({
      size: 'xl',
      labelledBy: 'importTitle',
      html: `${modalHead({
        eyebrow: '扩展你的题库',
        title: '导入题库',
        subtitle: '本地解析已有题库，或让你配置的 AI 从资料中生成简答题。',
        id: 'importTitle'
      })}
        <div class="modal-body import-body">
          <div class="import-tabs" role="tablist" aria-label="导入方式">
            <button class="import-tab is-active" data-import-tab="file" role="tab" aria-selected="true">${icon('upload')}上传文件</button>
            <button class="import-tab" data-import-tab="paste" role="tab" aria-selected="false">${icon('file')}粘贴文本</button>
            <button class="import-tab" data-import-tab="ai" role="tab" aria-selected="false">${icon('spark')}AI 生成</button>
          </div>

          <div id="importFilePane">
            <div class="dropzone" id="dropZone" tabindex="0" role="button" aria-label="点击或拖入文件">
              <input type="file" id="fileInput" multiple hidden accept=".xlsx,.docx,.csv,.txt,.md,.markdown,.json">
              <span class="drop-icon">${icon('upload')}</span>
              <strong>把文件拖到这里，或点击选择</strong>
              <span class="drop-sub">可一次选择多个文件 · 支持 ${supported.map((e) => `.${e}`).join(' / ')}</span>
            </div>
            <div class="format-row">
              <span class="format-chip">Excel<small>.xlsx</small></span>
              <span class="format-chip">Word<small>.docx</small></span>
              <span class="format-chip">CSV<small>.csv</small></span>
              <span class="format-chip">纯文本<small>.txt / .md</small></span>
              <span class="format-chip">JSON<small>.json</small></span>
            </div>
            <div class="template-row">
              <span>第一次导入？先拿一份模板：</span>
              <button class="text-link" data-action="download-template">${icon('download')}下载 CSV 模板</button>
              <a class="text-link" href="${templateHref}" download>${icon('download')}下载 Excel 模板</a>
              <a class="text-link" href="docs/import-guide.md" target="_blank" rel="noopener">${icon('book')}查看导入指南</a>
            </div>
          </div>

          <div id="importPastePane" hidden>
            <div class="paste-head">
              <label for="pasteFormat">内容格式</label>
              <select id="pasteFormat">
                <option value="text">纯文本 / 带题号与“答案：”</option>
                <option value="csv">CSV（含表头）</option>
                <option value="json">JSON 数组</option>
              </select>
            </div>
            <textarea id="pasteInput" class="paste-input" rows="9" placeholder="1. 什么是间隔练习？&#10;答案：把复习分散到不同时间点……&#10;关键词：分散复习、重新提取&#10;解析：核心是提取，不是重读。&#10;标签：记忆，学习方法&#10;难度：2"></textarea>
            <div class="paste-actions">
              <span class="muted">支持题号、答案、关键词、解析、标签、难度等标记。</span>
              <button class="btn btn-soft btn-sm" id="parsePasteBtn">${icon('spark')}识别文本</button>
            </div>
          </div>

          <div id="importAiPane" hidden>
            <div class="ai-import-banner">
              ${icon('spark')}
              <div><strong>用资料生成题库</strong><p>上传课堂笔记 / 教材段落 / 已有题库，AI 会整理成简答题。生成后仍会先预览，不会直接入库。</p></div>
              <span class="ai-status" id="aiImportStatus">未配置</span>
            </div>
            <div class="ai-source-grid">
              <div class="ai-source-drop" id="aiSourceDrop" tabindex="0" role="button" aria-label="上传 AI 生成题目的素材">
                <input type="file" id="aiSourceInput" hidden accept=".docx,.xlsx,.csv,.txt,.md,.markdown,.json">
                <span class="drop-icon">${icon('upload')}</span>
                <strong id="aiSourceName">拖入 Word / Excel / 文本</strong>
                <span>支持 .docx / .xlsx / .csv / .txt / .md / .json</span>
              </div>
              <div class="ai-source-paste">
                <textarea id="aiSourceText" class="paste-input" rows="6" placeholder="或者直接粘贴资料，例如：&#10;第三章 认知负荷……&#10;（也可以只填下方主题，让 AI 直接出题）"></textarea>
              </div>
            </div>
            <div class="ai-source-meta">
              <span id="aiSourceMeta">0 字 · 未选择文件</span>
              <button class="text-link" type="button" id="aiClearSource">清空素材</button>
            </div>
            <div class="ai-options">
              <label class="ai-option"><span>生成题数</span>
                <select id="aiCount">
                  <option value="5">5 题</option>
                  <option value="10" selected>10 题</option>
                  <option value="15">15 题</option>
                  <option value="20">20 题</option>
                </select>
              </label>
              <label class="ai-option"><span>难度</span>
                <select id="aiDifficulty">
                  <option value="0">AI 自动</option>
                  <option value="1">基础</option>
                  <option value="2">中等</option>
                  <option value="3">挑战</option>
                </select>
              </label>
              <label class="ai-option"><span>标签 <small>可选</small></span>
                <input id="aiTags" type="text" placeholder="如：教育学、第三章">
              </label>
              <label class="ai-option ai-option-wide"><span>补充要求 / 主题 <small>可选</small></span>
                <input id="aiPrompt" type="text" placeholder="例如：围绕核心概念出题，优先考理解而不是记忆细节">
              </label>
            </div>
            <div class="ai-generate-row">
              <button class="btn btn-ai btn-sm" id="aiGenerateBtn" type="button">${icon('spark')}AI 生成题目</button>
              <button class="btn btn-ghost btn-sm" id="aiConfigInline" type="button">${icon('settings')}配置 AI</button>
              <span class="ai-generate-hint" id="aiGenerateHint">生成后可在下方预览、勾选并导入</span>
            </div>
            <div class="ai-generate-error" id="aiGenerateError" hidden></div>
          </div>

          <div class="import-preview" id="importPreview">
            <div class="import-placeholder">
              ${icon('layers')}
              <strong>题目识别结果会显示在这里</strong>
              <p>表格会自动匹配「题目 / 参考答案 / 关键词 / 解析 / 标签 / 难度」；没有表头时按列序识别。</p>
            </div>
          </div>
        </div>
        <div class="modal-foot import-foot">
          <span class="import-foot-note" id="importFootNote">${icon('shield')}普通导入全程本地处理，文件不会上传</span>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="confirmImport" disabled>导入 0 道题</button>
          </div>
        </div>`,
      onMount: ({ modal }) => bindImportModal(modal)
    });

    return overlay;
  }

  function bindImportModal(modal) {
    const fileInput = $('#fileInput', modal);
    const dropZone = $('#dropZone', modal);
    const preview = $('#importPreview', modal);
    const confirmBtn = $('#confirmImport', modal);
    const aiSourceInput = $('#aiSourceInput', modal);
    const aiSourceDrop = $('#aiSourceDrop', modal);
    const aiSourceText = $('#aiSourceText', modal);

    $$('.import-tab', modal).forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.import-tab', modal).forEach((t) => {
          t.classList.toggle('is-active', t === tab);
          t.setAttribute('aria-selected', String(t === tab));
        });
        const mode = tab.dataset.importTab;
        ui.importDraft.tab = mode;
        $('#importFilePane', modal).hidden = mode !== 'file';
        $('#importPastePane', modal).hidden = mode !== 'paste';
        $('#importAiPane', modal).hidden = mode !== 'ai';
        const footNote = $('#importFootNote', modal);
        if (footNote) {
          footNote.innerHTML = mode === 'ai'
            ? `${icon('spark')}AI 生成会把素材发送到你配置的 AI 服务`
            : `${icon('shield')}普通导入全程本地处理，文件不会上传`;
        }
        if (mode !== ui.importDraft.sourceKind) resetImportPreview(modal);
        if (mode === 'ai') {
          refreshAIStatus();
          updateAISourceMeta(modal);
        }
      });
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });
    ['dragenter', 'dragover'].forEach((type) => {
      dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        dropZone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        dropZone.classList.remove('is-dragover');
      });
    });
    dropZone.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) handleImportFiles(files, modal);
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      if (files.length) handleImportFiles(files, modal);
    });

    $('#parsePasteBtn', modal).addEventListener('click', () => {
      const text = $('#pasteInput', modal).value;
      const format = $('#pasteFormat', modal).value;
      if (!text.trim()) {
        toast('先粘贴一些内容吧。', 'info');
        return;
      }
      parsePastedText(text, format, modal);
    });

    aiSourceDrop.addEventListener('click', () => aiSourceInput.click());
    aiSourceDrop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        aiSourceInput.click();
      }
    });
    ['dragenter', 'dragover'].forEach((type) => {
      aiSourceDrop.addEventListener(type, (event) => {
        event.preventDefault();
        aiSourceDrop.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      aiSourceDrop.addEventListener(type, (event) => {
        event.preventDefault();
        aiSourceDrop.classList.remove('is-dragover');
      });
    });
    aiSourceDrop.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) handleAISourceFile(file, modal);
    });
    aiSourceInput.addEventListener('change', () => {
      const file = aiSourceInput.files?.[0];
      if (file) handleAISourceFile(file, modal);
    });
    aiSourceText.addEventListener('input', () => {
      const draft = ui.importDraft;
      if (draft.aiSource) draft.aiSource.text = aiSourceText.value;
      updateAISourceMeta(modal);
    });
    $('#aiClearSource', modal).addEventListener('click', () => {
      const draft = ui.importDraft;
      draft.aiSource = { name: '', text: '', warnings: [] };
      aiSourceText.value = '';
      aiSourceInput.value = '';
      $('#aiSourceName', modal).textContent = '拖入 Word / Excel / 文本';
      updateAISourceMeta(modal);
      $('#aiGenerateError', modal).hidden = true;
    });
    $('#aiConfigInline', modal).addEventListener('click', openAISettings);
    $('#aiGenerateBtn', modal).addEventListener('click', () => generateAIQuestions(modal));

    confirmBtn.addEventListener('click', () => confirmImport(modal));
    refreshAIStatus();
    updateAISourceMeta(modal);
    if (!window.ShifenImport) {
      preview.innerHTML = `<div class="import-error">${icon('alert')}<div><strong>导入组件没有加载</strong><p>请确认 js/importers.js 与 index.html 在同一目录下，然后刷新页面。</p></div></div>`;
      confirmBtn.disabled = true;
    }
  }

  async function handleImportFiles(files, modal) {
    const draft = ui.importDraft;
    if (!window.ShifenImport) {
      toast('导入组件未加载，请刷新页面后重试。', 'error');
      return;
    }
    draft.loading = true;
    draft.items = [];
    draft.selected = new Set();
    draft.warnings = [];
    draft.errors = [];
    draft.sourceKind = 'file';
    draft.files = files.map((f) => ({ name: f.name, size: f.size }));
    draft.bankName = deriveBankName(files);
    renderImportPreview(modal, true);

    try {
      const result = await window.ShifenImport.parseFiles(files);
      const questions = Array.isArray(result) ? result : (result?.questions || []);
      const failed = Array.isArray(result?.files) ? result.files.filter((f) => f && !f.ok) : [];
      draft.items = questions.map((q) => normalizeImportedQuestion(q));
      draft.selected = new Set(draft.items.map((_, i) => i));
      draft.warnings = [
        ...(Array.isArray(result?.warnings) ? result.warnings : []),
        ...failed.flatMap((f) => (f.errors || []).map((e) => `${f.name}：${e}`))
      ];
      draft.errors = failed.flatMap((f) => f.errors || []);
      if (!draft.items.length) {
        toast('没有识别到有效的简答题。请检查表头或文档格式。', 'error', 4200);
      }
      draft.loading = false;
      renderImportPreview(modal);
      maybeAutoAIKeywords(modal);
    } catch (err) {
      console.error('导入失败', err);
      draft.loading = false;
      draft.errors = [err && err.message ? err.message : '解析失败'];
      renderImportPreview(modal);
      toast('文件解析失败，请换一个文件或检查格式。', 'error', 4200);
    }
  }

  async function parsePastedText(text, format, modal) {
    if (!window.ShifenImport) {
      toast('导入组件未加载，请刷新页面后重试。', 'error');
      return;
    }
    const draft = ui.importDraft;
    draft.loading = true;
    renderImportPreview(modal, true);
    try {
      const result = window.ShifenImport.parseText(text, { filename: '粘贴导入.txt', format });
      const questions = Array.isArray(result) ? result : (result?.questions || []);
      const warnings = Array.isArray(result) ? [] : (result?.warnings || []);
      draft.files = [{ name: '粘贴导入', size: text.length }];
      draft.bankName = `粘贴导入 · ${formatShortDate()}`;
      draft.sourceKind = 'paste';
      draft.items = questions.map((q) => normalizeImportedQuestion(q));
      draft.selected = new Set(draft.items.map((_, i) => i));
      draft.warnings = warnings;
      draft.errors = [];
      draft.loading = false;
      if (!draft.items.length) toast('没有识别到题目，检查一下格式或表头。', 'error', 3600);
      renderImportPreview(modal);
      maybeAutoAIKeywords(modal);
    } catch (err) {
      console.error(err);
      draft.loading = false;
      draft.errors = [err?.message || '解析失败'];
      renderImportPreview(modal);
      toast('文本解析失败，请检查格式。', 'error');
    }
  }

  function normalizeImportedQuestion(raw) {
    return {
      question: String(raw?.question || '').trim(),
      answer: String(raw?.answer || '').trim(),
      keywords: splitKeywords(raw?.keywords),
      explanation: String(raw?.explanation || '').trim(),
      tags: splitTags(raw?.tags),
      difficulty: clampDifficulty(raw?.difficulty),
      source: String(raw?.source || '').trim()
    };
  }

  function resetImportPreview(modal) {
    const draft = ui.importDraft;
    if (!draft) return;
    draft.items = [];
    draft.selected.clear();
    draft.warnings = [];
    draft.errors = [];
    draft.sourceKind = draft.tab;
    const preview = $('#importPreview', modal);
    if (preview) {
      preview.innerHTML = `<div class="import-placeholder">
        ${icon(draft.tab === 'ai' ? 'spark' : 'layers')}
        <strong>${draft.tab === 'ai' ? 'AI 生成结果会显示在这里' : '题目识别结果会显示在这里'}</strong>
        <p>${draft.tab === 'ai' ? '上传或粘贴资料，设置题数后生成；生成后仍可预览、勾选和修改目标题库。' : '表格会自动匹配「题目 / 参考答案 / 关键词 / 解析 / 标签 / 难度」；没有表头时按列序识别。'}</p>
      </div>`;
    }
    const confirmBtn = $('#confirmImport', modal);
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '导入 0 道题';
    }
  }

  function updateAISourceMeta(modal) {
    const draft = ui.importDraft;
    if (!draft) return;
    const text = $('#aiSourceText', modal)?.value || '';
    const chars = text.trim().length;
    const name = draft.aiSource?.name || '';
    const meta = $('#aiSourceMeta', modal);
    if (meta) {
      meta.textContent = `${chars} 字${name ? ` · ${name}` : ''}${chars > AI_SOURCE_LIMIT ? ` · 超出 ${AI_SOURCE_LIMIT} 字，AI 只使用前 ${AI_SOURCE_LIMIT} 字` : ''}`;
      meta.classList.toggle('is-warn', chars > AI_SOURCE_LIMIT);
    }
  }

  function showAIGenerateError(modal, message) {
    const box = $('#aiGenerateError', modal);
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `${icon('alert')}<span>${esc(message || 'AI 生成失败，请稍后重试。')}</span>`;
  }

  async function handleAISourceFile(file, modal) {
    const draft = ui.importDraft;
    if (!draft) return;
    if (!window.ShifenImport?.extractText) {
      toast('导入组件未更新，请刷新页面后再试。', 'error', 4200);
      return;
    }
    const nameEl = $('#aiSourceName', modal);
    const meta = $('#aiSourceMeta', modal);
    const textArea = $('#aiSourceText', modal);
    if (nameEl) nameEl.textContent = file.name;
    if (meta) meta.textContent = '正在读取素材…';
    $('#aiGenerateError', modal).hidden = true;
    try {
      const result = await window.ShifenImport.extractText(file);
      if (!result || !result.ok) {
        throw new Error(result?.warnings?.[0] || '无法读取这个文件，请换一个格式。');
      }
      const text = String(result.text || '');
      if (!text.trim()) throw new Error('文件里没有可用的文字内容。');
      draft.aiSource = { name: file.name, text, warnings: result.warnings || [] };
      if (textArea) textArea.value = text;
      updateAISourceMeta(modal);
      if (result.warnings?.length) toast(result.warnings[0], 'info', 3600);
      else toast(`已读取 ${text.length} 字素材。`, 'success', 2400);
    } catch (error) {
      draft.aiSource = { name: '', text: '', warnings: [] };
      if (textArea) textArea.value = '';
      if (nameEl) nameEl.textContent = '拖入 Word / Excel / 文本';
      updateAISourceMeta(modal);
      showAIGenerateError(modal, error?.message || '素材读取失败。');
      toast(error?.message || '素材读取失败。', 'error', 4200);
    } finally {
      const input = $('#aiSourceInput', modal);
      if (input) input.value = '';
    }
  }

  async function generateAIQuestions(modal) {
    const draft = ui.importDraft;
    if (!draft || draft.aiBusy) return;
    if (!ensureAIReady()) return;
    const sourceText = ($('#aiSourceText', modal)?.value || '').trim();
    const prompt = ($('#aiPrompt', modal)?.value || '').trim();
    if (!sourceText && !prompt) {
      showAIGenerateError(modal, '先上传/粘贴一些资料，或在「补充要求 / 主题」里写一个主题。');
      toast('还没有可用于出题的内容。', 'info');
      return;
    }
    const count = clamp(Number($('#aiCount', modal)?.value) || 10, 1, 30);
    const difficulty = Number($('#aiDifficulty', modal)?.value) || 0;
    const tags = splitTags($('#aiTags', modal)?.value || '');
    const sourceName = draft.aiSource?.name || '';
    const sourceForAI = sourceText.slice(0, AI_SOURCE_LIMIT);
    const btn = $('#aiGenerateBtn', modal);
    const hint = $('#aiGenerateHint', modal);
    $('#aiGenerateError', modal).hidden = true;
    draft.aiBusy = true;
    refreshAIStatus();
    if (btn) btn.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span>AI 正在生成…`;
    if (hint) hint.textContent = `正在根据 ${sourceForAI.length || prompt.length} 字内容生成 ${count} 道题，通常 20–60 秒…`;
    try {
      const result = await window.ShifenAI.generateQuestions({
        text: sourceForAI,
        topic: prompt,
        count,
        difficulty,
        tags,
        instructions: prompt
      });
      const rawQuestions = Array.isArray(result) ? result : (result?.questions || []);
      const questions = rawQuestions
        .map((q) => normalizeImportedQuestion(q))
        .filter((q) => q.question && q.answer)
        .slice(0, count)
        .map((q) => ({
          ...q,
          source: `AI 生成${sourceName ? ` · ${sourceName}` : ''}`
        }));
      if (!questions.length) throw new Error('AI 没有生成有效题目，请调整素材或补充要求后重试。');
      draft.items = questions;
      draft.selected = new Set(questions.map((_, i) => i));
      draft.warnings = [
        ...(Array.isArray(result?.warnings) ? result.warnings : []),
        'AI 生成内容可能有误，导入后请核对题干和参考答案。'
      ];
      draft.errors = [];
      draft.sourceKind = 'ai';
      draft.files = [{ name: sourceName || `AI 生成 · ${formatShortDate()}`, size: sourceForAI.length }];
      const baseName = sourceName ? sourceName.replace(/\.[^.]+$/, '') : `AI 生成 · ${formatShortDate()}`;
      draft.bankName = (sourceName ? `${baseName} · AI` : baseName).slice(0, 60);
      renderImportPreview(modal);
      toast(`AI 生成了 ${questions.length} 道题，请预览后导入。`, 'success', 3400);
      setTimeout(() => $('#importPreview', modal)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
    } catch (error) {
      const message = error?.message || 'AI 生成失败，请检查配置或稍后重试。';
      showAIGenerateError(modal, message);
      toast(message, 'error', 4500);
    } finally {
      draft.aiBusy = false;
      refreshAIStatus();
      if (btn) btn.innerHTML = `${icon('spark')}AI 生成题目`;
      if (hint) hint.textContent = '生成后可在下方预览、勾选并导入';
    }
  }

  function maybeAutoAIKeywords(modal) {
    const draft = ui.importDraft;
    if (!draft || draft.sourceKind === 'ai') return;
    if (!state.settings.ai.autoKeywords || !aiReady()) return;
    const missing = draft.items.reduce((n, item, index) => n + (draft.selected.has(index) && !item.keywords.length ? 1 : 0), 0);
    if (!missing) return;
    if (missing > 20) {
      toast(`有 ${missing} 道题缺少关键词；数量较多，请手动点「AI 补全关键词」。`, 'info', 4200);
      return;
    }
    setTimeout(() => {
      if (document.body.contains(modal)) runImportAIKeywords(modal, { auto: true });
    }, 240);
  }

  async function runImportAIKeywords(modal, options = {}) {
    const draft = ui.importDraft;
    if (!draft || ui.aiBusy.importKeywords) return;
    if (!ensureAIReady()) return;
    const targets = draft.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => draft.selected.has(index) && !item.keywords.length);
    if (!targets.length) {
      toast('选中的题目都已经有关键词了。', 'info');
      return;
    }
    if (targets.length > 20) {
      if (options.auto) {
        toast(`有 ${targets.length} 道题缺少关键词；数量较多，请手动补全。`, 'info', 3800);
        return;
      }
      const ok = await confirmDialog({
        title: `为 ${targets.length} 道题补关键词？`,
        message: '这会向 AI 发送这些题目的题干和参考答案，可能需要一点时间，也可能产生调用费用。',
        confirmLabel: '继续',
        danger: false
      });
      if (!ok) return;
    }
    ui.aiBusy.importKeywords = true;
    refreshAIStatus();
    const preview = $('#importPreview', modal);
    if (preview) {
      preview.innerHTML = `<div class="import-loading"><span class="spinner" aria-hidden="true"></span><strong>AI 正在补全 ${targets.length} 道题的关键词…</strong><p>已有关键词不会覆盖，完成前不要关闭窗口。</p></div>`;
    }
    try {
      const result = await window.ShifenAI.completeKeywordsBatch(
        targets.map(({ item, index }) => ({
          index,
          question: item.question,
          reference: item.answer,
          existingKeywords: item.keywords
        }))
      );
      let updated = 0;
      (Array.isArray(result) ? result : []).forEach((entry) => {
        const index = Number(entry?.index);
        const item = draft.items[index];
        if (!item || !Array.isArray(entry.keywords)) return;
        if (item.keywords.length) return;
        const keywords = entry.keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 8);
        if (keywords.length) {
          item.keywords = keywords;
          updated += 1;
        }
      });
      renderImportPreview(modal);
      toast(`AI 已为 ${updated} 道题补充关键词。`, updated ? 'success' : 'info', 3200);
    } catch (error) {
      const message = error?.message || 'AI 补关键词失败。';
      renderImportPreview(modal);
      toast(message, 'error', 4200);
    } finally {
      ui.aiBusy.importKeywords = false;
      refreshAIStatus();
    }
  }

  function renderImportPreview(modal, loading = false) {
    const draft = ui.importDraft;
    const preview = $('#importPreview', modal);
    const confirmBtn = $('#confirmImport', modal);
    if (!preview || !draft) return;

    if (loading) {
      preview.innerHTML = `<div class="import-loading"><span class="spinner" aria-hidden="true"></span><strong>正在本地解析…</strong><p>文件不会上传，稍等片刻。</p></div>`;
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '正在解析…';
      }
      return;
    }

    if (!draft.items.length) {
      const aiMode = draft.sourceKind === 'ai';
      preview.innerHTML = `<div class="import-error">${icon('alert')}<div><strong>${aiMode ? 'AI 还没有生成有效题目' : '暂时没有识别到题目'}</strong>
        <p>${esc(draft.errors[0] || (aiMode ? '调整素材或补充要求后，再点一次「AI 生成题目」。' : '请检查文件是否有「题目」和「参考答案」两列，或文档中是否使用了「答案：」标记。'))}</p>
        ${aiMode ? '' : `<button class="text-link" data-action="download-template">${icon('download')}下载模板看看格式</button>`}</div></div>`;
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '导入 0 道题';
      }
      return;
    }

    const selectedCount = draft.selected.size;
    const targetOptions = state.banks.map((b) => `<option value="${esc(b.id)}" ${draft.bankId === b.id ? 'selected' : ''}>${esc(b.name)}（${getBankQuestions(b.id).length} 题）</option>`).join('');
    const warnings = draft.warnings.slice(0, 8);
    const fileLabel = draft.files.map((f) => f.name).join(' · ');
    const missingKeywords = draft.items.reduce((n, q, i) => n + (draft.selected.has(i) && !q.keywords.length ? 1 : 0), 0);
    const aiReadyNow = aiReady();

    preview.innerHTML = `
      <div class="import-summary">
        <div class="summary-stat"><strong>${draft.items.length}</strong><span>${draft.sourceKind === 'ai' ? '道题生成成功' : '道题识别成功'}</span></div>
        <div class="summary-stat"><strong>${selectedCount}</strong><span>道待导入</span></div>
        <div class="summary-stat ${warnings.length ? 'has-warning' : ''}"><strong>${warnings.length}</strong><span>条提示</span></div>
        <div class="summary-file" title="${esc(fileLabel)}">${icon(draft.sourceKind === 'ai' ? 'spark' : 'file')}${esc(fileLabel || '已读取内容')}</div>
      </div>
      ${warnings.length ? `<details class="import-warnings"><summary>${icon('alert')}有 ${warnings.length} 条提示，建议检查</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      ${missingKeywords ? `<div class="import-ai-strip">
        <span>${icon('spark')}${missingKeywords} 道选中的题缺少关键词</span>
        <button class="btn btn-ai-soft btn-sm" type="button" id="aiKeywordsImportBtn" ${aiReadyNow ? '' : 'title="先配置 AI 服务"'}'>${icon('layers')}AI 补全关键词（${missingKeywords}）</button>
        ${aiReadyNow ? '' : '<span class="ai-strip-hint">先配置 AI 服务</span>'}
      </div>` : ''}
      <div class="import-target">
        <div class="target-head">
          <span class="target-label">导入到</span>
          <div class="target-mode">
            <label class="${draft.mode === 'new' ? 'is-active' : ''}"><input type="radio" name="importMode" value="new" ${draft.mode === 'new' ? 'checked' : ''}>新建题库</label>
            <label class="${draft.mode === 'existing' ? 'is-active' : ''} ${state.banks.length ? '' : 'is-disabled'}"><input type="radio" name="importMode" value="existing" ${draft.mode === 'existing' ? 'checked' : ''} ${state.banks.length ? '' : 'disabled'}>追加到已有</label>
          </div>
        </div>
        ${draft.mode === 'new'
          ? `<input id="importBankName" class="text-input" type="text" maxlength="60" value="${esc(draft.bankName)}" placeholder="给这份题库起个名字">`
          : `<select id="importBankSelect" class="select-input">${targetOptions}</select>`}
      </div>
      <div class="preview-list-head">
        <label class="check-label"><input type="checkbox" id="selectAllImport" ${selectedCount === draft.items.length ? 'checked' : ''}>全选</label>
        <span>${draft.items.length > 100 ? '预览前 100 道，导入全部已选题' : '可取消勾选不想导入的题'}</span>
      </div>
      <div class="preview-list" id="previewList">
        ${draft.items.slice(0, 100).map((q, i) => `
          <label class="preview-item ${draft.selected.has(i) ? 'is-selected' : ''}">
            <input type="checkbox" data-import-index="${i}" ${draft.selected.has(i) ? 'checked' : ''}>
            <span class="preview-index">${String(i + 1).padStart(2, '0')}</span>
            <span class="preview-main">
              <strong>${esc(excerpt(q.question, 90))}</strong>
              <small>${q.answer ? esc(excerpt(q.answer, 60)) : '<em>缺少参考答案</em>'}${q.tags.length ? ` · ${esc(q.tags.slice(0, 2).join(' / '))}` : ''}</small>
            </span>
            ${q.difficulty ? `<span class="preview-diff">${DIFFICULTY_LABELS[q.difficulty]}</span>` : ''}
          </label>`).join('')}
      </div>
      <p class="preview-foot">${icon(draft.sourceKind === 'ai' ? 'spark' : 'shield')}${draft.sourceKind === 'ai' ? '内容由 AI 根据你的资料整理，请核对后导入。' : '解析在浏览器本地完成。导入后仍可修改题库名称，或在题库中删除。'}</p>`;

    if (confirmBtn) {
      confirmBtn.disabled = selectedCount === 0;
      confirmBtn.textContent = `导入 ${selectedCount} 道题`;
    }
    $('#aiKeywordsImportBtn', preview)?.addEventListener('click', () => {
      if (!ensureAIReady()) return;
      runImportAIKeywords(modal);
    });

    $$('input[name="importMode"]', preview).forEach((radio) => {
      radio.addEventListener('change', () => {
        draft.mode = radio.value;
        renderImportPreview(modal);
      });
    });
    const nameInput = $('#importBankName', preview);
    if (nameInput) {
      nameInput.addEventListener('input', () => { draft.bankName = nameInput.value; });
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          confirmImport(modal);
        }
      });
    }
    const bankSelect = $('#importBankSelect', preview);
    if (bankSelect) {
      bankSelect.addEventListener('change', () => { draft.bankId = bankSelect.value; });
    }
    const selectAll = $('#selectAllImport', preview);
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        if (selectAll.checked) {
          draft.items.forEach((_, i) => draft.selected.add(i));
        } else {
          draft.selected.clear();
        }
        renderImportPreview(modal);
      });
    }
    $$('#previewList input[data-import-index]', preview).forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const i = Number(checkbox.dataset.importIndex);
        if (checkbox.checked) draft.selected.add(i);
        else draft.selected.delete(i);
        checkbox.closest('.preview-item')?.classList.toggle('is-selected', checkbox.checked);
        updateImportConfirmLabel(modal);
      });
    });
  }

  function updateImportConfirmLabel(modal) {
    const draft = ui.importDraft;
    const btn = $('#confirmImport', modal);
    if (!btn || !draft) return;
    btn.disabled = draft.selected.size === 0;
    btn.textContent = `导入 ${draft.selected.size} 道题`;
  }

  function confirmImport(modal) {
    const draft = ui.importDraft;
    if (!draft || !draft.items.length) return;
    const selected = draft.items
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => draft.selected.has(index));
    if (!selected.length) {
      toast('至少选择一道题。', 'info');
      return;
    }

    let bank;
    if (draft.mode === 'existing') {
      bank = getBank(draft.bankId);
      if (!bank) {
        toast('请选择要追加到的题库。', 'error');
        return;
      }
    } else {
      const name = (draft.bankName || '').trim();
      if (!name) {
        toast('给新题库起一个名字吧。', 'info');
        $('#importBankName', modal)?.focus();
        return;
      }
      bank = {
        id: uid('bank'),
        name: name.slice(0, 80),
        createdAt: Date.now(),
        sourceType: draft.sourceKind === 'ai' ? 'AI 生成' : (draft.files.map((f) => {
          const ext = f.name.includes('.') ? f.name.split('.').pop() : '';
          return ext ? ext.toUpperCase() : '文本';
        }).filter(Boolean).join(' / ') || '导入'),
        description: (draft.sourceKind === 'ai'
          ? `AI 根据 ${draft.files.map((f) => f.name).join('、') || '你提供的资料'} 生成`
          : `导入自 ${draft.files.map((f) => f.name).join('、')}`).slice(0, 200),
        isSample: false
      };
      state.banks.push(bank);
    }

    const existing = new Set(state.questions
      .filter((q) => q.bankId === bank.id)
      .map((q) => normalizeForMatch(q.question)));
    let added = 0;
    let duplicates = 0;
    selected.forEach(({ item, index }) => {
      const key = normalizeForMatch(item.question);
      if (!key || existing.has(key)) {
        duplicates += 1;
        return;
      }
      existing.add(key);
      state.questions.push({
        id: uid('q'),
        bankId: bank.id,
        question: item.question,
        answer: item.answer,
        keywords: item.keywords,
        explanation: item.explanation,
        tags: item.tags,
        difficulty: item.difficulty,
        source: item.source || `${draft.files.map((f) => f.name).join(' / ') || '导入'} · 第 ${index + 1} 条`,
        createdAt: Date.now() + added
      });
      added += 1;
    });

    if (!added) {
      toast('选中的题目都已经在这个题库里了。', 'info');
      return;
    }

    state.sessions[bank.id] = { cursor: 0, updatedAt: Date.now() };
    state.ui.lastBankId = bank.id;
    saveNow();
    const close = modalStack[modalStack.length - 1]?.close;
    if (close) close();
    ui.selectedBankId = bank.id;
    ui.importDraft = null;
    go('banks');
    renderShell();
    toast(`已导入 ${added} 道题${duplicates ? `，跳过 ${duplicates} 道重复题` : ''}。`, 'success', 3600);
  }

  /* ---------------------------------------------------------------------
     设置
     --------------------------------------------------------------------- */
  function openSettings() {
    closeSidebar();
    const settings = state.settings;
    const sampleBank = state.banks.find((b) => b.isSample);
    const { overlay } = openModal({
      size: 'md',
      labelledBy: 'settingsTitle',
      html: `${modalHead({ eyebrow: '偏好与数据', title: '设置', subtitle: '所有数据保存在本机浏览器，不会上传。', id: 'settingsTitle' })}
        <div class="modal-body settings-body">
          <section class="settings-group">
            <h3>${icon('target')}学习节奏</h3>
            <div class="setting-row">
              <div><strong>每日目标</strong><p>一个轻量目标，帮助你把练习变成习惯。</p></div>
              <div class="goal-picker">
                ${DAILY_PRESETS.map((n) => `<button type="button" class="goal-chip ${settings.dailyGoal === n ? 'is-active' : ''}" data-goal="${n}">${n}</button>`).join('')}
                <input id="customGoal" type="number" min="1" max="200" value="${settings.dailyGoal}" aria-label="自定义每日目标">
              </div>
            </div>
            <div class="setting-row">
              <div><strong>自动下一题</strong><p>自评后自动进入下一题，保持练习节奏。</p></div>
              <button type="button" class="switch ${settings.autoNext ? 'is-on' : ''}" data-setting="autoNext" role="switch" aria-checked="${settings.autoNext}"><span></span></button>
            </div>
            <div class="setting-row">
              <div><strong>打乱题目顺序</strong><p>每次开始新练习时随机排序，避免只记住题号。</p></div>
              <button type="button" class="switch ${settings.shuffle ? 'is-on' : ''}" data-setting="shuffle" role="switch" aria-checked="${settings.shuffle}"><span></span></button>
            </div>
          </section>

          <section class="settings-group">
            <h3>${icon('sun')}外观</h3>
            <div class="setting-row">
              <div><strong>主题</strong><p>浅色像纸张，深色适合晚上。</p></div>
              <div class="segmented">
                ${['auto', 'light', 'dark'].map((t) => `<button type="button" data-theme-choice="${t}" class="${settings.theme === t ? 'is-active' : ''}">${THEME_LABELS[t]}</button>`).join('')}
              </div>
            </div>
          </section>

          <section class="settings-group">
            <h3>${icon('spark')}AI 学习助手</h3>
            <div class="setting-row">
              <div><strong>AI 服务</strong><p id="aiSettingsStatus" class="ai-status">${esc(aiStatusInfo().text)}</p></div>
              <button type="button" class="btn btn-ghost btn-sm" id="openAiSettingsBtn">${icon('settings')}配置 AI</button>
            </div>
            <div class="setting-row">
              <div><strong>用在哪里</strong><p>练习页 AI 点评/关键词、导入预览补关键词、用资料生成题库。调用时会把当前题目与答案发送到你配置的服务。</p></div>
            </div>
          </section>

          <section class="settings-group">
            <h3>${icon('shield')}数据</h3>
            <div class="setting-row">
              <div><strong>导出备份</strong><p>把题库、进度、笔记和设置导出为 JSON 文件。</p></div>
              <button type="button" class="btn btn-ghost btn-sm" id="exportDataBtn">${icon('download')}导出 JSON</button>
            </div>
            <div class="setting-row">
              <div><strong>导入备份</strong><p>从之前的 JSON 备份恢复，会覆盖当前数据。</p></div>
              <button type="button" class="btn btn-ghost btn-sm" id="importDataBtn">${icon('upload')}选择 JSON</button>
              <input type="file" id="importDataInput" accept=".json,application/json" hidden>
            </div>
            <div class="setting-row">
              <div><strong>移除示例题库</strong><p>移除内置的「认知与学习」示例及其练习记录。</p></div>
              <button type="button" class="btn btn-ghost btn-sm" id="removeSampleBtn" ${sampleBank ? '' : 'disabled'}>移除示例</button>
            </div>
            <div class="setting-row danger-row">
              <div><strong>清空全部数据</strong><p>删除所有题库、练习进度与笔记，操作不可撤销。</p></div>
              <button type="button" class="btn btn-danger-ghost btn-sm" id="clearDataBtn">清空数据</button>
            </div>
          </section>

          <section class="settings-group about-group">
            <div class="about-mark">拾</div>
            <div><strong>拾分 · 简答练习室</strong><p>离线优先，打开即用。支持 xlsx / docx / csv / txt / md / json；AI 为可选增强。数据保存在本机浏览器，请定期导出备份。</p></div>
            <span class="version-tag">v1.1</span>
          </section>
        </div>
        <div class="modal-foot"><span class="modal-foot-note">${icon('cloud-off')}离线可用 · AI 可选</span><button class="btn btn-primary" data-close>完成</button></div>`,
      onMount: ({ modal }) => bindSettings(modal)
    });
    return overlay;
  }

  function openAISettings() {
    const presets = aiPresets();
    const ai = { ...state.settings.ai };
    const status = aiStatusInfo();
    const providerOptions = Object.entries(presets).map(([key, preset]) =>
      `<option value="${esc(key)}" ${ai.provider === key ? 'selected' : ''}>${esc(preset.label || key)}</option>`
    ).join('');

    const { overlay } = openModal({
      size: 'md',
      labelledBy: 'aiSettingsTitle',
      html: `${modalHead({
        eyebrow: '可选能力',
        title: 'AI 服务设置',
        subtitle: '支持 DeepSeek、OpenAI、本地 Ollama，以及任何 OpenAI 兼容接口。',
        id: 'aiSettingsTitle'
      })}
        <div class="modal-body ai-settings-body">
          <div class="ai-settings-banner">
            ${icon('spark')}
            <div><strong>AI 是可选增强</strong><p>不配置也能正常刷题和导入。API Key 只保存在本机浏览器，不写入导出备份。</p></div>
            <span class="ai-status ${status.ready ? 'is-on' : ''}" id="aiModalStatus">${esc(status.text)}</span>
          </div>

          <div class="ai-form-grid">
            <label class="field"><span>服务商</span>
              <select id="aiProvider" class="select-input">${providerOptions}</select>
            </label>
            <label class="field"><span>模型</span>
              <input id="aiModel" type="text" value="${esc(ai.model)}" placeholder="例如 deepseek-chat" autocomplete="off" spellcheck="false">
            </label>
          </div>
          <label class="field"><span>Base URL（OpenAI 兼容，通常以 /v1 结尾）</span>
            <input id="aiBaseUrl" type="url" value="${esc(ai.baseUrl)}" placeholder="https://api.deepseek.com/v1" autocomplete="off" spellcheck="false">
          </label>
          <label class="field"><span>API Key</span>
            <div class="ai-key-wrap">
              <input id="aiKey" type="password" value="${esc(ai.apiKey)}" placeholder="本地 Ollama 可留空" autocomplete="off" spellcheck="false">
              <button type="button" class="icon-btn ai-key-toggle" id="aiKeyToggle" aria-label="显示或隐藏 API Key">${icon('eye')}</button>
            </div>
          </label>
          <div class="ai-provider-hint" id="aiProviderHint"></div>

          <div class="ai-enable-row">
            <div><strong>启用 AI 功能</strong><p>关闭后保留配置，但练习页和导入页不会调用 AI。</p></div>
            <button type="button" class="switch ${ai.enabled ? 'is-on' : ''}" id="aiEnabledSwitch" role="switch" aria-checked="${ai.enabled}"><span></span></button>
          </div>
          <div class="ai-enable-row">
            <div><strong>导入时自动补全关键词</strong><p>普通导入完成后，自动为缺少关键词的题调用 AI（最多 20 道）；会产生额外调用。默认关闭。</p></div>
            <button type="button" class="switch ${ai.autoKeywords ? 'is-on' : ''}" id="aiAutoKeywordsSwitch" role="switch" aria-checked="${ai.autoKeywords}"><span></span></button>
          </div>

          <div class="ai-test-row">
            <button type="button" class="btn btn-soft btn-sm" id="aiTestBtn">${icon('refresh')}测试连接</button>
            <span class="ai-test-result" id="aiTestResult">尚未测试</span>
          </div>
          <p class="ai-settings-note">
            调用时会把当前题目、参考答案和你的答案发送到所配置的服务。第三方接口可能产生费用；浏览器直连遇到 CORS 时，请改用本地 Ollama 或自建兼容代理。
            <a href="docs/ai-guide.md" target="_blank" rel="noopener">查看配置指南 ${icon('arrow-right')}</a>
          </p>
        </div>
        <div class="modal-foot">
          <span class="modal-foot-note">${icon('shield')}Key 只存本机，不会写入备份</span>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="aiSaveBtn">保存配置</button>
          </div>
        </div>`,
      onMount: ({ modal, close }) => bindAISettings(modal, close, ai, presets)
    });
    return overlay;
  }

  function bindAISettings(modal, close, initial, presets) {
    const providerEl = $('#aiProvider', modal);
    const baseEl = $('#aiBaseUrl', modal);
    const modelEl = $('#aiModel', modal);
    const keyEl = $('#aiKey', modal);
    const hintEl = $('#aiProviderHint', modal);
    const enabledEl = $('#aiEnabledSwitch', modal);
    const testResult = $('#aiTestResult', modal);
    let enabled = Boolean(initial.enabled);
    let autoKeywords = Boolean(initial.autoKeywords);

    const readDraft = () => normalizeAIFields({
      enabled,
      provider: providerEl.value,
      baseUrl: baseEl.value,
      model: modelEl.value,
      apiKey: keyEl.value,
      temperature: initial.temperature,
      autoKeywords
    });

    const updateHint = () => {
      const preset = presets[providerEl.value] || AI_PROVIDER_FALLBACK.custom;
      const isLocal = providerEl.value === 'ollama';
      hintEl.textContent = isLocal
        ? '本地 Ollama 不需要 API Key；请先启动 Ollama，并设置 OLLAMA_ORIGINS=* 允许浏览器访问。'
        : providerEl.value === 'custom'
          ? '填入你的 OpenAI 兼容代理地址与模型；需要鉴权时再填 Key。'
          : `${preset.label || providerEl.value}：Key 只保存在本机；如浏览器报 CORS，请改用本地 Ollama 或兼容代理。`;
      keyEl.placeholder = isLocal ? '本地 Ollama 可留空' : '填写你的 API Key';
    };

    providerEl.addEventListener('change', () => {
      const preset = presets[providerEl.value] || AI_PROVIDER_FALLBACK.custom;
      if (preset.baseUrl) baseEl.value = preset.baseUrl;
      if (preset.model) modelEl.value = preset.model;
      updateHint();
      testResult.textContent = '配置已切换，请重新测试';
      testResult.className = 'ai-test-result';
    });
    updateHint();

    $('#aiKeyToggle', modal)?.addEventListener('click', () => {
      const show = keyEl.type === 'password';
      keyEl.type = show ? 'text' : 'password';
      $('#aiKeyToggle', modal).innerHTML = icon(show ? 'close' : 'eye');
      $('#aiKeyToggle', modal).setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
    });

    const updateModalStatus = () => {
      const el = $('#aiModalStatus', modal);
      if (!el) return;
      el.textContent = enabled ? '已启用（未保存）' : '未启用';
      el.classList.toggle('is-on', enabled);
      el.classList.remove('is-warn');
    };
    enabledEl.addEventListener('click', () => {
      enabled = !enabled;
      enabledEl.classList.toggle('is-on', enabled);
      enabledEl.setAttribute('aria-checked', String(enabled));
      updateModalStatus();
    });
    const autoEl = $('#aiAutoKeywordsSwitch', modal);
    autoEl?.addEventListener('click', () => {
      autoKeywords = !autoKeywords;
      autoEl.classList.toggle('is-on', autoKeywords);
      autoEl.setAttribute('aria-checked', String(autoKeywords));
    });

    const validate = (draft) => {
      if (!draft.baseUrl) return '请填写 Base URL。';
      try {
        const url = new URL(draft.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return 'Base URL 必须是 http 或 https 地址。';
      } catch (error) {
        return 'Base URL 格式不正确。';
      }
      if (!draft.model) return '请填写模型名称。';
      const preset = presets[draft.provider] || AI_PROVIDER_FALLBACK.custom;
      if (draft.enabled && preset.requiresKey && !draft.apiKey) return '启用这个服务商需要 API Key。';
      return '';
    };

    $('#aiTestBtn', modal)?.addEventListener('click', async () => {
      const draft = { ...readDraft(), enabled: true };
      const error = validate(draft);
      if (error) {
        testResult.textContent = error;
        testResult.className = 'ai-test-result is-error';
        return;
      }
      if (!window.ShifenAI) {
        testResult.textContent = 'AI 组件未加载，请刷新页面。';
        testResult.className = 'ai-test-result is-error';
        return;
      }
      const btn = $('#aiTestBtn', modal);
      btn.disabled = true;
      testResult.textContent = '正在连接…';
      testResult.className = 'ai-test-result';
      try {
        const result = await window.ShifenAI.testConnection(draft);
        testResult.textContent = result.ok
          ? `连接成功 · ${result.latency} ms · ${result.model || draft.model}`
          : (result.message || '连接失败');
        testResult.className = `ai-test-result ${result.ok ? 'is-ok' : 'is-error'}`;
      } catch (error2) {
        testResult.textContent = error2?.message || '连接失败，请检查地址、Key 与网络。';
        testResult.className = 'ai-test-result is-error';
      } finally {
        btn.disabled = false;
      }
    });

    $('#aiSaveBtn', modal)?.addEventListener('click', () => {
      const draft = readDraft();
      const error = validate(draft);
      if (error) {
        testResult.textContent = error;
        testResult.className = 'ai-test-result is-error';
        return;
      }
      state.settings.ai = { ...draft, enabled };
      syncAIConfig();
      saveSoon();
      refreshAIStatus();
      close();
      toast(enabled ? 'AI 配置已保存，可以在练习页使用了。' : 'AI 配置已保存（当前为关闭状态）。', 'success', 3200);
    });
  }

  function bindSettings(modal) {
    const settings = state.settings;

    $$('.goal-chip', modal).forEach((btn) => {
      btn.addEventListener('click', () => {
        settings.dailyGoal = Number(btn.dataset.goal);
        $('#customGoal', modal).value = String(settings.dailyGoal);
        $$('.goal-chip', modal).forEach((b) => b.classList.toggle('is-active', b === btn));
        saveSoon();
        renderShell();
        if (ui.view === 'dashboard') renderCurrentView();
      });
    });
    const customGoal = $('#customGoal', modal);
    customGoal?.addEventListener('change', () => {
      const n = clamp(Number(customGoal.value) || 10, 1, 200);
      settings.dailyGoal = n;
      customGoal.value = String(n);
      $$('.goal-chip', modal).forEach((b) => b.classList.toggle('is-active', Number(b.dataset.goal) === n));
      saveSoon();
      renderShell();
      if (ui.view === 'dashboard') renderCurrentView();
    });

    $$('[data-setting]', modal).forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.setting;
        settings[key] = !settings[key];
        btn.classList.toggle('is-on', settings[key]);
        btn.setAttribute('aria-checked', String(settings[key]));
        saveSoon();
      });
    });

    $$('[data-theme-choice]', modal).forEach((btn) => {
      btn.addEventListener('click', () => {
        setTheme(btn.dataset.themeChoice);
        $$('[data-theme-choice]', btn.parentElement).forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });

    $('#openAiSettingsBtn', modal)?.addEventListener('click', openAISettings);
    $('#exportDataBtn', modal)?.addEventListener('click', exportData);
    $('#importDataBtn', modal)?.addEventListener('click', () => $('#importDataInput', modal).click());
    $('#importDataInput', modal)?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) importDataFile(file, modal);
    });

    $('#removeSampleBtn', modal)?.addEventListener('click', async () => {
      const sample = state.banks.find((b) => b.isSample);
      if (!sample) return;
      const ok = await confirmDialog({
        title: '移除示例题库？',
        message: '示例题库及其中题目的练习记录会被删除，其他题库不受影响。',
        confirmLabel: '移除',
        danger: true
      });
      if (!ok) return;
      deleteBank(sample.id, false);
      closeTopModal();
      openSettings();
      toast('示例题库已移除。', 'success');
    });

    $('#clearDataBtn', modal)?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '清空全部数据？',
        message: '所有题库、题目、练习进度、收藏、笔记和 AI Key 都会被删除，且无法恢复。建议先导出备份。',
        confirmLabel: '确认清空',
        danger: true
      });
      if (!ok) return;
      state = normalizeState({
        version: 1,
        banks: [],
        questions: [],
        progress: {},
        sessions: {},
        settings: { ...state.settings, ai: DEFAULT_AI },
        activity: {},
        drafts: {},
        aiReviews: {},
        ui: {}
      });
      ui.session = null;
      ui.selectedBankId = null;
      syncAIConfig();
      saveNow();
      closeAllModals();
      go('dashboard');
      toast('数据已清空。', 'success');
    });
  }

  function closeTopModal() {
    const entry = modalStack[modalStack.length - 1];
    if (entry) entry.close();
  }

  function closeAllModals() {
    while (modalStack.length) closeTopModal();
  }

  function exportData() {
    const exportState = JSON.parse(JSON.stringify(state));
    if (exportState.settings?.ai) exportState.settings.ai.apiKey = '';
    const payload = {
      app: '拾分',
      version: 1,
      exportedAt: nowIso(),
      state: exportState
    };
    downloadText(JSON.stringify(payload, null, 2), `拾分备份-${dateKey()}.json`, 'application/json;charset=utf-8');
    toast('备份已导出（已排除 AI API Key）。', 'success', 3200);
  }

  function importDataFile(file, modal) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        const candidate = parsed && parsed.state ? parsed.state : parsed;
        if (!candidate || !Array.isArray(candidate.questions) || !Array.isArray(candidate.banks)) {
          throw new Error('文件里缺少题库或题目数据');
        }
        const ok = await confirmDialog({
          title: '恢复这份备份？',
          message: `备份中有 ${candidate.banks.length} 个题库、${candidate.questions.length} 道题。恢复后会覆盖当前全部数据。`,
          confirmLabel: '覆盖并恢复',
          danger: true
        });
        if (!ok) return;
        const currentKey = state.settings?.ai?.apiKey || '';
        state = normalizeState(candidate);
        if (!state.settings.ai.apiKey && currentKey) state.settings.ai.apiKey = currentKey;
        if (!state.ui.lastBankId && state.banks[0]) state.ui.lastBankId = state.banks[0].id;
        ui.session = null;
        ui.selectedBankId = null;
        syncAIConfig();
        saveNow();
        applyTheme();
        closeAllModals();
        go('dashboard');
        toast('备份已恢复。', 'success', 3200);
      } catch (err) {
        console.error(err);
        toast(`恢复失败：${err.message || '文件格式不正确'}`, 'error', 4200);
      }
    };
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------------------
     题库操作
     --------------------------------------------------------------------- */
  async function renameBank(bankId) {
    const bank = getBank(bankId);
    if (!bank) return;
    const name = await promptDialog({
      eyebrow: '题库',
      title: '重命名题库',
      label: '题库名称',
      value: bank.name,
      placeholder: '例如：教育学原理 · 期末',
      confirmLabel: '保存'
    });
    if (!name) return;
    bank.name = name;
    if (state.ui.lastBankId === bank.id) {
      // 标题从 state 读取，无需额外处理
    }
    saveNow();
    renderCurrentView();
    renderShell();
    toast('题库已重命名。', 'success');
  }

  async function deleteBank(bankId, ask = true) {
    const bank = getBank(bankId);
    if (!bank) return;
    if (ask) {
      const ok = await confirmDialog({
        title: `删除「${bank.name}」？`,
        message: `题库里的 ${getBankQuestions(bank.id).length} 道题、练习记录、收藏和笔记都会一起删除，无法恢复。建议先导出备份。`,
        confirmLabel: '删除题库',
        danger: true
      });
      if (!ok) return;
    }
    const qids = new Set(getBankQuestions(bank.id).map((q) => q.id));
    state.banks = state.banks.filter((b) => b.id !== bank.id);
    state.questions = state.questions.filter((q) => q.bankId !== bank.id);
    state.progress = Object.fromEntries(Object.entries(state.progress).filter(([qid]) => !qids.has(qid)));
    state.drafts = Object.fromEntries(Object.entries(state.drafts).filter(([qid]) => !qids.has(qid)));
    state.aiReviews = Object.fromEntries(Object.entries(state.aiReviews || {}).filter(([qid]) => !qids.has(qid)));
    delete state.sessions[bank.id];
    if (state.ui.lastBankId === bank.id) state.ui.lastBankId = state.banks[0]?.id || null;
    if (ui.selectedBankId === bank.id) ui.selectedBankId = null;
    if (ui.session && ui.session.bankId === bank.id) ui.session = null;
    saveNow();
    renderAll();
    toast('题库已删除。', 'success');
  }

  function exportBankCSV(bankId) {
    const bank = getBank(bankId);
    if (!bank) return;
    const qs = getBankQuestions(bank.id);
    const header = ['题目', '参考答案', '关键词', '解析', '标签', '难度'];
    const lines = [header.map(csvCell).join(',')];
    qs.forEach((q) => {
      lines.push([
        q.question,
        q.answer,
        q.keywords.join('、'),
        q.explanation,
        q.tags.join('、'),
        q.difficulty
      ].map(csvCell).join(','));
    });
    downloadText(`\uFEFF${lines.join('\r\n')}`, `${bank.name}.csv`, 'text/csv;charset=utf-8');
    toast('题库已导出为 CSV。', 'success');
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  /* ---------------------------------------------------------------------
     全局交互
     --------------------------------------------------------------------- */
  function handleAction(action, el) {
    switch (action) {
      case 'import':
        openImportModal();
        break;
      case 'open-settings':
        openSettings();
        break;
      case 'download-template':
        downloadTemplate();
        break;
      case 'go-dashboard':
        go('dashboard');
        break;
      case 'go-banks':
        ui.selectedBankId = null;
        go('banks');
        break;
      case 'back-banks':
        ui.selectedBankId = null;
        go('banks');
        break;
      case 'start-bank': {
        const bankId = el.dataset.bankId;
        startSession({ mode: 'bank', bankId, restart: el.dataset.restart === '1' });
        break;
      }
      case 'open-bank':
        ui.selectedBankId = el.dataset.bankId;
        go('banks');
        break;
      case 'practice':
        if (ui.session) go('practice');
        else if (ensureResumeSession()) go('practice');
        else startSession({ mode: 'bank' });
        break;
      case 'practice-wrong':
        startSession({ mode: 'wrong' });
        break;
      case 'practice-favorites':
        startSession({ mode: 'favorites' });
        break;
      case 'practice-tag':
        startSession({ mode: 'tag', tag: el.dataset.tag });
        break;
      case 'practice-one': {
        const mode = el.dataset.mode || 'bank';
        const opts = { mode, startId: el.dataset.id };
        if (mode === 'bank') opts.bankId = el.dataset.bankId;
        startSession(opts);
        break;
      }
      case 'restart-session': {
        const s = ui.session;
        if (!s) return;
        startSession({ mode: s.mode, bankId: s.bankId, tag: s.tag, restart: true });
        break;
      }
      case 'rename-bank':
        renameBank(el.dataset.bankId);
        break;
      case 'delete-bank':
        deleteBank(el.dataset.bankId);
        break;
      case 'export-bank':
        exportBankCSV(el.dataset.bankId);
        break;
      case 'load-sample':
        loadSampleBank();
        break;
      default:
        break;
    }
  }

  function loadSampleBank() {
    const sample = createSampleState();
    if (state.banks.some((b) => b.id === 'bank_sample')) {
      ui.selectedBankId = 'bank_sample';
      go('banks');
      toast('示例题库已经在列表里了。', 'info');
      return;
    }
    state.banks.push(sample.banks[0]);
    state.questions.push(...sample.questions);
    state.sessions.bank_sample = { cursor: 0, updatedAt: Date.now() };
    state.ui.lastBankId = 'bank_sample';
    saveNow();
    renderShell();
    go('dashboard');
    toast('示例题库已载入，去答第一题吧。', 'success');
  }

  /* ---------------------------------------------------------------------
     侧栏 / 移动端
     --------------------------------------------------------------------- */
  function openSidebar() {
    $('#sidebar')?.classList.add('is-open');
    const overlay = $('#sidebarOverlay');
    if (overlay) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('is-visible'));
    }
    document.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    $('#sidebar')?.classList.remove('is-open');
    const overlay = $('#sidebarOverlay');
    if (overlay) {
      overlay.classList.remove('is-visible');
      setTimeout(() => {
        if (!overlay.classList.contains('is-visible')) overlay.hidden = true;
      }, 200);
    }
    document.body.classList.remove('sidebar-open');
  }

  /* ---------------------------------------------------------------------
     提示
     --------------------------------------------------------------------- */
  function toast(message, type = 'success', duration = 2800) {
    const root = $('#toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `${icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : 'spark')}<span></span>`;
    el.querySelector('span').textContent = message;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 240);
    }, duration);
  }

  function announce(message) {
    const el = $('#liveRegion');
    if (el) el.textContent = message;
  }

  /* ---------------------------------------------------------------------
     事件绑定
     --------------------------------------------------------------------- */
  function bindStaticEvents() {
    $('#importBtn')?.addEventListener('click', openImportModal);
    $('#mobileImportBtn')?.addEventListener('click', openImportModal);
    $('#settingsBtn')?.addEventListener('click', openSettings);
    $('#themeBtn')?.addEventListener('click', () => {
      setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
    });

    $('#menuBtn')?.addEventListener('click', openSidebar);
    $('#sidebarClose')?.addEventListener('click', closeSidebar);
    $('#sidebarOverlay')?.addEventListener('click', closeSidebar);

    $('#practiceBack')?.addEventListener('click', () => go('dashboard'));
    $('#practiceExit')?.addEventListener('click', () => go('dashboard'));
    $('#practiceFavorite')?.addEventListener('click', () => toggleFavorite());
    $('#revealBtn')?.addEventListener('click', revealReference);
    $('#aiConfigBtn')?.addEventListener('click', openAISettings);
    $('#aiReviewBtn')?.addEventListener('click', runAIReview);
    $('#aiKeywordsBtn')?.addEventListener('click', runAIKeywords);
    $('#nextBtn')?.addEventListener('click', nextQuestion);
    $('#prevBtn')?.addEventListener('click', previousQuestion);
    $('#skipBtn')?.addEventListener('click', nextQuestion);

    $('#ratingBar')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-rating]');
      if (btn) rateQuestion(Number(btn.dataset.rating));
    });

    const answerInput = $('#answerInput');
    answerInput?.addEventListener('input', () => {
      const q = currentQuestion();
      if (!q) return;
      const value = answerInput.value;
      state.drafts[q.id] = value;
      $('#charCount').textContent = `${value.trim().length} 字`;
      const status = $('#draftStatus');
      status.textContent = '保存中…';
      clearTimeout(ui.draftTimer);
      ui.draftTimer = setTimeout(() => {
        saveSoon();
        if ($('#draftStatus')) $('#draftStatus').textContent = '已自动保存';
      }, 350);
      if (ui.session?.revealed) renderKeywordChips(q, value);
    });

    const noteInput = $('#noteInput');
    noteInput?.addEventListener('input', () => {
      const q = currentQuestion();
      if (!q) return;
      ensureProgress(q.id).note = noteInput.value;
      saveSoon();
    });

    document.addEventListener('click', (event) => {
      const nav = event.target.closest('[data-view]');
      if (nav) {
        event.preventDefault();
        go(nav.dataset.view);
        return;
      }
      const actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        event.preventDefault();
        handleAction(actionEl.dataset.action, actionEl);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (modalStack.length) return;
      if (event.key === 'Escape') {
        closeSidebar();
        return;
      }
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (ui.view === 'practice' && ui.session) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          if (!ui.session.revealed) revealReference();
          else nextQuestion();
          return;
        }
        if (event.altKey && event.key === 'ArrowLeft') {
          event.preventDefault();
          previousQuestion();
          return;
        }
        if (event.altKey && event.key === 'ArrowRight') {
          event.preventDefault();
          nextQuestion();
          return;
        }
        if (!typing && ui.session.revealed && ['1', '2', '3', '4'].includes(event.key)) {
          event.preventDefault();
          rateQuestion(Number(event.key) - 1);
          return;
        }
        if (!typing && (event.key === 'f' || event.key === 'F')) {
          event.preventDefault();
          toggleFavorite();
          return;
        }
      }
      if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        handleAction('practice', document.body);
        return;
      }
      if (!typing && event.key === '/' && ui.view === 'banks') {
        const targetInput = $('#bankSearch') || $('#bankQuestionSearch');
        if (targetInput) {
          event.preventDefault();
          targetInput.focus();
          targetInput.select();
        }
      }
    });

    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', saveNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow();
    });

    if (window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (state.settings.theme === 'auto') applyTheme();
      };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);
    }
  }

  /* ---------------------------------------------------------------------
     启动
     --------------------------------------------------------------------- */
  function init() {
    loadState();
    syncAIConfig();
    applyTheme();
    bindStaticEvents();
    if (!location.hash) history.replaceState(null, '', '#/dashboard');
    route();
    if (!state.banks.length) {
      // 首次启动/清空后保留空状态，不自动载入示例
    }
  }

  init();
})();
