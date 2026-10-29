# 拾分 · AI 功能契约（v1.1）

目标：在不破坏离线主流程的前提下，增加三类可选 AI 能力。所有 AI 调用都通过用户自行配置的 **OpenAI 兼容接口**完成（DeepSeek / OpenAI / Ollama / 自定义代理）。未配置时，普通导入、练习、统计等功能必须完全照常工作。

> 浏览器直连第三方接口可能遇到 CORS；本地 Ollama 需设置 `OLLAMA_ORIGINS=*`（或反向代理）。文档与设置页要给出中文提示。

## 1. 文件边界

| 范围 | 负责人 | 文件 |
| --- | --- | --- |
| AI 服务层 | ai-engineer | `js/ai.js`、`tests/mock-ai-server.mjs`、`docs/ai-guide.md` |
| 导入器纯文本提取 | importer | `js/importers.js` 增加 `extractText(file)`、`tests/importer-check.html` 增补 |
| UI / 状态 / 集成 | Lead | `index.html`、`js/app.js`、`css/styles.css`、`README.md`、`使用说明.txt` |
| AI E2E 验收 | qa | `tests/e2e-ai.mjs`、`tests/report-ai.md`、`tests/screenshots-ai/` |

## 2. 状态模型扩展（向后兼容）

```js
settings.ai = {
  enabled: false,
  provider: "deepseek",               // deepseek | openai | ollama | custom
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  apiKey: "",
  temperature: 0.3
}
state.aiReviews = {
  [questionId]: {
    score: 0-100,
    verdict: "掌握" | "基本掌握" | "还需巩固" | "未掌握",
    matchedPoints: string[],
    missedPoints: string[],
    summary: string,
    suggestions: string[],
    improvedAnswer: string,
    at: number,
    model: string
  }
}
```

- `normalizeState` 缺省补全；旧数据无 `ai`/`aiReviews` 不受影响。
- **导出 JSON 备份时不得包含 apiKey**；恢复同机备份时可保留当前已填的 key。
- AI 调用失败绝不写入 `aiReviews`。

## 3. 服务层 API（`js/ai.js`）

IIFE 暴露 `window.ShifenAI`，零依赖，不操作 DOM：

```js
window.ShifenAI = {
  PRESETS: {
    deepseek: { label, baseUrl, model, requiresKey: true },
    openai:   { label, baseUrl, model, requiresKey: true },
    ollama:   { label, baseUrl, model, requiresKey: false },
    custom:   { label, baseUrl: "", model: "", requiresKey: false }
  },

  configure(config),          // 保存到模块内；返回规范化 config
  getConfig(),

  isConfigured(config),       // enabled && baseUrl && model && (!requiresKey || apiKey)

  // 连接测试：发一条极短消息（不要求 JSON），返回
  // { ok, latency, model, message }
  async testConnection(configOverride),

  // 单题点评
  async reviewAnswer({ question, reference, keywords, userAnswer }),
  // -> { score, verdict, matchedPoints, missedPoints, summary, suggestions, improvedAnswer }

  // 从参考答案提取关键词
  async extractKeywords({ question, reference, existingKeywords }),
  // -> { keywords: string[] }  3-8 个，去重，短词/术语，不要整句

  // 批量补关键词：items = [{ index, question, reference, existingKeywords }]
  // 服务内部按 8 个/批调用，返回 [{ index, keywords }]
  async completeKeywordsBatch(items),

  // 根据材料/主题生成题目
  async generateQuestions({ text, topic, count, difficulty, tags, instructions }),
  // -> { questions: [{ question, answer, keywords, explanation, tags, difficulty }] }
  // difficulty: 0=自动, 1/2/3；count 1-30；tags 可为数组或字符串
}
```

### 调用规则

- Endpoint：`baseUrl` 去掉末尾 `/` + `/chat/completions`；`Authorization: Bearer <apiKey>`（无 key 的 Ollama 可省略）；`Content-Type: application/json`。
- Body：`{ model, messages, temperature, max_tokens, stream: false }`。不强制 `response_format`（兼容性优先）。
- 默认超时：点评/关键词 45s，批量 60s，生成 120s；用 `AbortController`。
- 错误必须抛出带 `code` 和中文 `message` 的 Error：
  - `CONFIG` 未配置 / 缺 key / 非法 URL
  - `AUTH` 401/403
  - `MODEL` 404
  - `RATE` 429
  - `NETWORK` fetch 失败（提示 CORS/断网/Ollama 未启动）
  - `TIMEOUT` 超时
  - `HTTP` 其他非 2xx（带状态码和截断响应）
  - `PARSE` 模型返回无法解析为 JSON
- 解析模型输出时容忍 ```json 围栏、前后说明文字；提取第一个 `{` 到最后一个 `}`（或 `[`/`]`）再 JSON.parse。
- 所有 prompt 用中文，并在 system prompt 中加入固定任务标记，便于 mock：
  - `[TASK:REVIEW]`、`[TASK:KEYWORDS]`、`[TASK:KEYWORDS_BATCH]`、`[TASK:GENERATE]`、`[TASK:PING]`
- 对模型输出做边界归一化：score 0-100、verdict 限定四档、数组去重、字符串 trim、keywords 最多 8 个、生成题最多 `count` 道、difficulty 1-3。
- 发送内容只包含当前题目/用户答案/参考资料，不附带其他题库或个人信息。
- 不在 console 打印 API key。

### Prompt 要点

- 点评：以参考答案为准，判断用户答案覆盖了哪些要点、漏了哪些；不要编造材料外的事实；给出可执行改进建议；`score` 是覆盖度估计，不是考试分数。
- 关键词：提取可自检的核心术语/要点，3-8 个，每个不超过 16 字；排除“因为、所以、重要”等泛词。
- 生成：严格按材料，不虚构；覆盖核心概念；答案 80-220 字；关键词 3-6 个；给出解析/标签/难度；输出 JSON。

## 4. 导入器扩展：`extractText(file)`

```js
await window.ShifenImport.extractText(file)
// -> { ok: boolean, text: string, warnings: string[], meta: { type, sheets?, chars } }
```

- 支持：`.txt`、`.md`、`.markdown`、`.csv`、`.json`、`.xlsx`、`.docx`。
- xlsx：读取全部非说明类工作表，按行拼接单元格（制表符分隔，行间换行）；跳过空行。
- docx：按文档顺序输出段落与表格；表格行用 ` | ` 连接；段落空行保留为换行。
- txt/md/csv/json：按原文本解码（UTF-8 → gb18030 回退）；json 可美化/转文本。
- `.pdf` / `.doc` / `.xls`：返回 `ok:false` 和明确中文提示（PDF 请先转成 Word/文本）。
- 只读文件，不改写原文件；最多返回 200,000 字符，超出截断并在 warnings 说明。

## 5. UI 需求（Lead 实现）

### 5.1 AI 设置弹窗

入口：设置 → 「AI 服务」行；练习 AI 工具栏未配置时；AI 导入页未配置时。

- 字段：启用开关、服务商预设、Base URL、模型、API Key、测试连接、保存。
- 预设切换自动填 Base URL/模型；Ollama 不要求 key。
- 测试结果显示延迟/模型/错误；保存时校验 URL 与必填项。
- 安全提示：Key 仅保存在本机 localStorage；会随浏览器数据清理消失；**不会写入导出备份**。
- 链接：`docs/ai-guide.md`（新窗口）。
- CORS/本地 Ollama 提示。

### 5.2 练习页 AI 工具条

在 `#referencePanel` 内、关键词/解析之后、评分之前：

```html
<div id="aiTools" class="ai-tools">
  <div class="ai-tools-head">AI 学习助手 <span id="aiStatus"></span></div>
  <div class="ai-tool-actions">
    <button id="aiReviewBtn">AI 点评我的答案</button>
    <button id="aiKeywordsBtn">AI 提取关键词</button>
  </div>
  <div id="aiOutput"></div>
</div>
```

- 未配置/未启用：按钮可点击，但点击打开 AI 设置，并 toast 提示。
- 点评：要求用户答案非空；调用 `reviewAnswer`；loading；成功后写入 `state.aiReviews[qid]` 并渲染；失败只 toast/错误卡片，不写缓存。
- 关键词：调用 `extractKeywords`，把结果合并进当前题 `keywords`（去重、最多 8 个），保存并刷新关键词 chips；成功后 toast。
- 显示缓存的上次点评，标注「上次 AI 点评」；允许重新点评。
- 显示免责声明：AI 点评仅供参考，以参考答案为准；调用时会把当前题目和答案发送到所配置的服务。

### 5.3 AI 导入

导入弹窗新增第三个 tab「AI 生成」：

- 来源：上传单个文件（docx/xlsx/txt/md/csv/json）或粘贴文本；显示字符数；超过 20,000 字提示截断。
- 参数：生成题数（5/10/15/20 或自定义 1-30）、难度（自动/基础/中等/挑战）、标签、补充要求（可选主题）。
- 点击「AI 生成题目」→ 调 `generateQuestions` → 复用现有导入预览（`ui.importDraft` + `renderImportPreview`）→ 用户选择目标题库并确认。
- 没有素材也没有主题时禁止生成。
- 生成中显示 spinner，禁用按钮；错误显示在 AI 面板内。

### 5.4 导入预览 AI 补关键词

- 当 AI 已配置且预览中存在缺关键词的题时，显示「AI 补全关键词（N）」。
- 点击后确认（>20 道时提示可能产生调用费用），批量调用；更新预览中的关键词；保留勾选状态。
- 失败不清空原有关键词。

### 5.5 设置 / 导出

- 设置中显示 AI 状态（未配置/已启用: 模型名）。
- JSON 导出剥离 `settings.ai.apiKey`；恢复时若备份无 key 且本机已有 key，保留本机 key。

## 6. Mock 服务（测试用）

`tests/mock-ai-server.mjs`：

- `node tests/mock-ai-server.mjs --port 18765`
- CORS `*`，OPTIONS 204。
- `POST /v1/chat/completions` 解析最后一条 user 消息和 system 标记：
  - PING → `OK`
  - REVIEW → 固定 JSON（score 76、2 个命中、2 个遗漏、建议 3 条）
  - KEYWORDS → 固定 4 个关键词
  - KEYWORDS_BATCH → 每项 3 个关键词
  - GENERATE → 按 count 返回固定 3 道题（或 count 道）
- 支持故意错误模式：请求头 `x-mock-status: 401` 返回 401；`x-mock-bad-json: 1` 返回非 JSON 文本；便于错误用例。
- 端口被占用时打印明确错误并以非 0 退出。

## 7. 验收（QA）

用 mock 服务，不访问外网：

1. AI 设置：保存 DeepSeek/自定义配置（baseUrl=`http://127.0.0.1:18765/v1`，model=`mock-model`，key=`test`），测试连接成功。
2. 练习：reveal → 输入答案 → AI 点评 → 显示 score 76、命中/遗漏、建议；再点评可更新。
3. AI 提取关键词：无关键词题 → 点击 → chips 更新且 localStorage 中 keywords 有 4 项。
4. AI 导入：粘贴一段材料 → 生成 3 题 → 预览 → 导入 → 题库出现且可练习。
5. 预览补关键词：普通 xlsx 导入后点击「AI 补全关键词」→ 缺关键词题被补齐，已有关键词不被覆盖。
6. 错误处理：mock 401 → 错误提示可读、页面不崩、不写缓存。
7. 旧功能回归：不配置 AI 时普通练习/导入完全正常；原有 E2E 14 项仍全过。
