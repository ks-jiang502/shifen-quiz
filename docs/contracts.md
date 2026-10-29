# 拾分 · 团队共享契约（v1）

产品：**拾分** —— 离线优先的简答题刷题应用。纯静态、无构建、无外部网络依赖，双击 `index.html` 即可使用。

## 1. 文件边界（谁写哪里）

| 范围 | 负责人 | 文件 |
| --- | --- | --- |
| 应用壳、练习引擎、状态、持久化 | Lead | `index.html`、`js/app.js`、`README.md`、`启动拾分.bat` |
| 视觉样式 | Lead | `css/styles.css`、`assets/*` |
| 离线导入器 + 示例题库 | 队友 importer | `js/importers.js`、`samples/*`、`templates/*`、`docs/import-guide.md` |
| E2E 测试 | 队友 qa | `tests/**`（不改产品文件，只报告 bug） |

不要修改范围外的文件。`js/app.js` 只能通过 `window.ShifenImport` 调用导入器；`js/importers.js` 不能操作 DOM、不能依赖 app.js。

## 2. 数据模型（localStorage key: `shifen.v1`）

```js
state = {
  version: 1,
  banks: [{ id, name, createdAt, sourceType, description }],
  questions: [{
    id, bankId, question, answer,
    keywords: [], explanation: "", tags: [], difficulty: 1|2|3,
    source: "", createdAt
  }],
  progress: { [questionId]: {
    attempts, lastRating, lastAt, mastery,      // mastery 0-100
    favorite: false, note: "", history: [{ at, rating }]
  }},
  sessions: { [bankId]: { cursor, order: [qid], updatedAt } },
  settings: { dailyGoal: 10, theme: "light"|"dark"|"auto", autoNext: false }
}
```

> v1.1 新增可选 AI：`settings.ai`、`aiReviews` 与 `window.ShifenAI`，完整契约见 `docs/ai-contract.md`。
> AI 关闭/未配置时，本文档其余行为不变。

评级 `rating`: 0 忘记 / 1 模糊 / 2 掌握 / 3 熟练。
掌握度目标值：`[15, 45, 78, 100]`；新评级后 `mastery = round(oldMastery*0.35 + target*0.65)`（首次直接取 target）。
错题判定：`attempts > 0 && lastRating <= 1`；收藏独立。

## 3. 导入器 API（`js/importers.js`）

必须在文件加载后暴露：

```js
window.ShifenImport = {
  SUPPORTED_EXTENSIONS: ["xlsx", "csv", "txt", "md", "markdown", "json", "docx"],

  // 主入口：一个或多个文件。绝不 throw；错误收集在 errors 中。
  // 返回 { files: FileResult[], questions: NormalizedQuestion[], warnings: string[] }
  async parseFiles(files, options = {}),

  // 单个文件，FileResult 见下
  async parseFile(file, options = {}),

  // 文本入口（粘贴导入）：format = "text" | "csv" | "json"
  parseText(text, { filename = "粘贴内容.txt", format = "text", ...options } = {}),

  // 生成 CSV 模板字符串（带 BOM），app 用于“下载模板”
  buildTemplateCSV()
}

NormalizedQuestion = {
  question: string, answer: string,
  keywords: string[], explanation: string, tags: string[], difficulty: 1|2|3,
  source: string             // 例如 "文件.xlsx / 工作表 / 第 3 行"
}

FileResult = {
  name: string, ext: string, ok: boolean,
  questions: NormalizedQuestion[], warnings: string[], errors: string[],
  meta: { type, sheets?: string[], rows?: number }
}
```

规则：

- 题目空、答案空的行必须跳过并给出 warning（答案缺失也可保留并 warning，但 `answer` 为 `""` 的题会被 app 标为待补充；优先跳过答案为空的行并说明）。
- 表头模糊匹配（忽略空格、全半角、大小写）：
  - 题目：题目/题干/问题/简答题/问答/question/q/content
  - 答案：参考答案/标准答案/答案/答/answer/a
  - 关键词：关键词/关键字/要点/keywords/keyword
  - 解析：解析/答案解析/说明/explanation/analysis
  - 标签：标签/分类/知识点/科目/tags/tag
  - 难度：难度/difficulty/level（支持 1-3、易/中/难、简单/中等/困难）
- xlsx/docx 的 ZIP 解压必须用浏览器原生 `DecompressionStream("deflate-raw")`（Chrome/Edge 103+），不要引入 CDN 或外部库。ZIP method 0 直接读取，method 8 走原生解压。
- xlsx：读取全部工作表，合并所有有效题目；`source` 带工作表名与行号。支持 sharedStrings、inlineStr、数字/布尔单元格；多行文本保留换行。
- docx：优先解析文档中的表格（有表头则按表头，无表头按列序）；否则解析段落，支持：
  - `1. 题干` / `第1题` / `Q1` 作为题目起始
  - `答案：` / `参考答案：` / `答：` 标签
  - `关键词：` / `解析：` / `标签：` 标签
  - 空行分隔的兜底：首段为题目，其余为答案
- CSV：处理引号、字段内换行、BOM；自动识别逗号/制表符/分号。编码优先 UTF-8，失败回退 `gb18030`。
- `.xls` 不支持：返回清晰错误“旧版 .xls 请先另存为 .xlsx”。
- 安全：所有文本用 `textContent` 由 app 渲染；导入器只返回字符串，不返回 HTML。

## 4. DOM 契约（Lead 实现；样式和 QA 依赖）

单页，`<body>` 下：

- `#app` 应用容器
- 左侧：`.sidebar`，含 `.brand`、`nav.nav`（按钮 `data-view="dashboard|practice|banks|wrong|favorites|stats"`）、`.sidebar-foot`（导入按钮 `#importBtn`、设置 `#settingsBtn`）
- 主区：`main.main`，各视图 `<section class="view" id="view-dashboard|view-practice|view-banks|view-wrong|view-favorites|view-stats" hidden>`
- 导入弹窗：`#importModal`，含拖放区 `#dropZone`、文件输入 `#fileInput`、粘贴文本 `#pasteInput`、预览 `#importPreview`、确认 `#confirmImport`
- 通用弹窗：`#modalRoot`（设置/新建题库等动态内容）
- 通知：`#toastRoot`
- 练习视图关键节点：`#practiceEmpty`、`#practiceStage`、`#questionText`、`#answerInput`、`#revealBtn`、`#referencePanel`、`#referenceText`、`#keywordChips`、`#ratingBar`、`#nextBtn`、`#prevBtn`、`#sessionProgress`、`#progressFill`
- 其他视图由 app.js 动态渲染，QA 通过可见文本与 `data-*` 断言。

## 5. 交互验收（QA 据此写用例）

1. 首次打开：自动载入内置示例题库（≥10 题），仪表盘可见“继续练习”。
2. 点击开始练习：显示第一题；输入答案后“查看参考答案”，显示答案、关键词命中、解析；点评级后掌握度与错题状态更新，自动进入下一题（可在设置关闭）。
3. 导入 `.xlsx`：选择 `samples/示例题库.xlsx`，预览显示题数，确认后题库出现；题目可进入练习。再导入 `samples/简答题示例.docx`、`samples/示例题库.csv` 均成功。
4. 刷新页面：导入的题库、练习进度、收藏、笔记均保留（localStorage）。
5. 错题本：评级“忘记”后题目进入错题本，可“错题重练”。
6. 统计：题量、已练、掌握度、7 日活跃图渲染正常。
7. 数据导出/导入 JSON 往返不丢字段。
8. 移动端 390px 宽无横向滚动，侧栏可开合。

## 6. 测试环境

- Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Node: `C:\Users\20306\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- Python: `C:\Users\20306\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`
- 本地静态服务（测试用）：`python -m http.server 8765 --directory D:\deepseek\workspeace`
- 网络不可用；一切依赖必须本地自带。
