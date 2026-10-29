/* ============================================================
 * 拾分 · 离线导入器（js/importers.js）
 * ------------------------------------------------------------
 * 纯原生 ES2020，零外部依赖，不操作 DOM，不依赖 app.js。
 * 对外只暴露 window.ShifenImport，契约见 docs/contracts.md 第 3 节。
 *
 * 支持：.xlsx / .docx / .csv / .txt / .md / .markdown / .json
 * ZIP：读取中央目录，method 0（STORE）直接取字节，
 *      method 8（DEFLATE）使用浏览器原生 DecompressionStream("deflate-raw")。
 * 安全：只返回纯字符串，不返回 HTML，不使用 innerHTML。
 * 稳定性：所有对外入口都不 throw，错误统一收集到 errors。
 *
 * 章节：
 *   1. 基础工具
 *   2. 字段、表头与难度归一化
 *   3. 题目归一化（表格行 / 文本条目共用）
 *   4. ZIP 读取器
 *   5. XML 辅助
 *   6. XLSX 解析
 *   7. DOCX 解析
 *   8. CSV / 纯文本 / Markdown / JSON 解析
 *   9. 纯文本提取（AI 生成素材，extractText）
 *   10. 对外 API
 * ============================================================ */

(function (global) {
  "use strict";

  /* ------------------------------------------------------------
   * 1. 基础工具
   * ---------------------------------------------------------- */

  var SUPPORTED_EXTENSIONS = ["xlsx", "csv", "txt", "md", "markdown", "json", "docx"];

  function toStr(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) parts.push(toStr(value[i]));
      return parts.join(",");
    }
    return String(value);
  }

  function normalizeNewlines(text) {
    return toStr(text).replace(/\r\n?/g, "\n");
  }

  function stripBom(text) {
    return toStr(text).replace(/^\uFEFF/, "");
  }

  function cleanText(value) {
    return normalizeNewlines(toStr(value)).replace(/\u0000/g, "").trim();
  }

  function snippet(value, maxLength) {
    var limit = maxLength || 18;
    var flat = toStr(value).replace(/\s+/g, " ").trim();
    return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
  }

  function dedupe(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || seen[item]) continue;
      seen[item] = true;
      out.push(item);
    }
    return out;
  }

  function getExtension(name) {
    var raw = toStr(name).trim().toLowerCase();
    var index = raw.lastIndexOf(".");
    if (index < 0 || index === raw.length - 1) return "";
    return raw.slice(index + 1);
  }

  function describeError(error) {
    if (!error) return "解析失败：未知错误。";
    var message = toStr(error && error.message ? error.message : error).trim();
    if (!message) return "解析失败：未知错误。";
    if (/[\u4e00-\u9fff]/.test(message)) return message;
    return "解析失败：" + message;
  }

  function makeResult(name, ext, type) {
    return {
      name: name || "未命名文件",
      ext: ext || "",
      ok: false,
      questions: [],
      warnings: [],
      errors: [],
      meta: { type: type || ext || "unknown" }
    };
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /* ------------------------------------------------------------
   * 2. 字段、表头与难度归一化
   * ---------------------------------------------------------- */

  var FIELD_ORDER = ["question", "answer", "keywords", "explanation", "tags", "difficulty"];

  var FIELD_ALIASES = {
    question: ["题目", "题干", "问题", "简答题", "问答", "question", "q", "content", "标题", "title"],
    answer: ["参考答案", "标准答案", "正确答案", "答案", "答", "answer", "a", "参考解答"],
    keywords: ["关键词", "关键字", "要点", "keywords", "keyword", "key"],
    explanation: ["解析", "答案解析", "说明", "解释", "analysis", "explanation", "分析"],
    tags: ["标签", "分类", "知识点", "科目", "tags", "tag", "类别"],
    difficulty: ["难度", "难易度", "difficulty", "level"]
  };

  var NORMALIZED_ALIASES = Object.create(null);

  function normalizeHeaderKey(value) {
    var text = toStr(value);
    try {
      text = text.normalize("NFKC");
    } catch (error) {
      /* 极老环境没有 normalize，忽略即可 */
    }
    return text
      .toLowerCase()
      .replace(/[\s\u3000]+/g, "")
      .replace(/[：:（）()【】\[\]《》〈〉<>「」『』"'`、，,。.;；!！?？_\-]/g, "");
  }

  (function buildAliasTable() {
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      var field = FIELD_ORDER[i];
      var aliases = FIELD_ALIASES[field];
      var normalized = [];
      for (var j = 0; j < aliases.length; j++) {
        var key = normalizeHeaderKey(aliases[j]);
        if (key) normalized.push(key);
      }
      NORMALIZED_ALIASES[field] = normalized;
    }
  })();

  /**
   * 把单元格文本匹配到字段名。精确匹配优先，其次前缀匹配（如“题目（必填）”）。
   * @returns {string|null} question / answer / keywords / explanation / tags / difficulty
   */
  function matchHeaderField(value) {
    var key = normalizeHeaderKey(value);
    if (!key) return null;
    var best = null;
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      var field = FIELD_ORDER[i];
      var aliases = NORMALIZED_ALIASES[field];
      for (var j = 0; j < aliases.length; j++) {
        var alias = aliases[j];
        var score = -1;
        if (key === alias) {
          score = 1000 + alias.length;
        } else if (alias.length >= 2 && key.indexOf(alias) === 0) {
          score = 500 + alias.length;
        } else if (key.length >= 2 && alias.indexOf(key) === 0) {
          score = 200 + key.length;
        }
        if (score > 0 && (!best || score > best.score)) {
          best = { field: field, score: score };
        }
      }
    }
    return best ? best.field : null;
  }

  /**
   * 扫描一行，返回 { map: {字段: 列号}, score }。
   * 只有同时识别到“题目”和“答案”才视为可用表头。
   */
  function detectColumnMap(cells) {
    var map = Object.create(null);
    var score = 0;
    for (var i = 0; i < cells.length; i++) {
      var field = matchHeaderField(cells[i]);
      if (!field) continue;
      if (map[field] === undefined) {
        map[field] = i;
        score += 10;
      }
    }
    return { map: map, score: score };
  }

  function defaultColumnMap(width) {
    var map = Object.create(null);
    var count = Math.min(width, FIELD_ORDER.length);
    for (var i = 0; i < count; i++) map[FIELD_ORDER[i]] = i;
    return map;
  }

  function normalizeDifficulty(value) {
    if (value === null || value === undefined) return null;
    var raw = toStr(value).trim();
    if (!raw) return null;
    var key = raw;
    try {
      key = key.normalize("NFKC");
    } catch (error) {
      /* ignore */
    }
    key = key.toLowerCase().replace(/[\s\u3000]+/g, "").replace(/^[（(\[【]+|[）)\]】]+$/g, "");
    if (!key) return null;

    var levelMap = {
      "1": 1, "一": 1, "易": 1, "简单": 1, "容易": 1, "低": 1, "低难度": 1, "easy": 1, "beginner": 1, "a": 1,
      "2": 2, "二": 2, "中": 2, "中等": 2, "一般": 2, "中等难度": 2, "medium": 2, "intermediate": 2, "b": 2,
      "3": 3, "三": 3, "难": 3, "困难": 3, "高": 3, "高难度": 3, "hard": 3, "advanced": 3, "c": 3,
      "1星": 1, "2星": 2, "3星": 3, "★": 1, "★★": 2, "★★★": 3
    };
    if (hasOwn(levelMap, key)) return levelMap[key];

    var leading = /^([123])(?:[^0-9]|$)/.exec(key);
    if (leading) return parseInt(leading[1], 10);

    if (/^(易|简单|容易|基础)/.test(key)) return 1;
    if (/^(中|中等|一般)/.test(key)) return 2;
    if (/^(难|困难|较难|高级)/.test(key)) return 3;

    var numeric = Number(key);
    if (Number.isFinite(numeric)) {
      if (numeric <= 1) return 1;
      if (numeric < 3) return 2;
      return 3;
    }
    return null;
  }

  /**
   * 把“关键词：a、b / c”这类文本拆成数组。
   * 保护 TCP/IP 之类的英文斜杠词。
   */
  function splitMultiValue(value) {
    if (Array.isArray(value)) {
      var fromArray = [];
      for (var i = 0; i < value.length; i++) {
        var item = cleanText(value[i]);
        if (item) fromArray.push(item);
      }
      return dedupe(fromArray);
    }
    var text = toStr(value);
    if (!text.trim()) return [];
    text = text.replace(/／/g, "/").replace(/([A-Za-z0-9])\/(?=[A-Za-z0-9])/g, "$1\u0001");
    var rawParts = text.split(/[\n,，、;；|/]+/);
    var parts = [];
    for (var j = 0; j < rawParts.length; j++) {
      var part = rawParts[j].replace(/\u0001/g, "/").trim();
      if (part) parts.push(part);
    }
    return dedupe(parts);
  }

  /* ------------------------------------------------------------
   * 3. 题目归一化（表格行 / 文本条目共用）
   * ---------------------------------------------------------- */

  function cellAt(cells, map, field) {
    var index = map ? map[field] : undefined;
    if (index === undefined || index === null || index < 0 || index >= cells.length) return "";
    return cleanText(cells[index]);
  }

  /**
   * 由原始字段构造 NormalizedQuestion；空题/空答案返回 null 并写 warning。
   * @param {object} fields 原始字段（字符串或数组）
   * @param {object} meta { short, source }
   * @param {string[]} warnings
   */
  function createQuestion(fields, meta, warnings) {
    var question = cleanText(fields.question);
    var answer = cleanText(fields.answer);
    if (!question && !answer) return null;
    if (!question) {
      warnings.push(meta.short + "：缺少题目，已跳过");
      return null;
    }
    if (!answer) {
      warnings.push(meta.short + "：题目「" + snippet(question) + "」缺少答案，已跳过");
      return null;
    }

    var rawDifficulty = cleanText(fields.difficulty);
    var difficulty = normalizeDifficulty(rawDifficulty);
    if (difficulty === null) {
      if (rawDifficulty) {
        warnings.push(meta.short + "：难度「" + snippet(rawDifficulty, 10) + "」无法识别，已按 1（易）处理");
      }
      difficulty = 1;
    }

    return {
      question: question,
      answer: answer,
      keywords: splitMultiValue(fields.keywords),
      explanation: cleanText(fields.explanation),
      tags: splitMultiValue(fields.tags),
      difficulty: difficulty,
      source: meta.source
    };
  }

  function looksLikeHeaderRow(cells) {
    for (var i = 0; i < cells.length; i++) {
      var text = toStr(cells[i]).trim();
      if (!text) continue;
      return matchHeaderField(text) === "question";
    }
    return false;
  }

  function isAuxiliarySheetName(name) {
    var key = normalizeHeaderKey(name);
    if (!key) return false;
    return /^(使用说明|填写说明|填表说明|导入说明|字段说明|模板说明|说明|说明页|注意事项|帮助|帮助文档|readme|readme说明|help|about)$/.test(key);
  }

  /**
   * 解析二维表（xlsx 工作表、docx 表格、csv 记录共用）。
   * rows: [{ n: 行号, cells: string[] }]
   * ctx: { fileName, sheetName, prefix, unit, auxiliary, warnings }
   * @returns {{questions: Array, rows: number}}
   */
  function parseTabularRows(rows, ctx) {
    var warnings = ctx.warnings;
    var prefix = ctx.prefix || "";
    var unit = ctx.unit || "表";
    var questions = [];

    var headerIndex = -1;
    var columnMap = null;
    var bestScore = -1;
    var scanLimit = Math.min(rows.length, 20);
    for (var i = 0; i < scanLimit; i++) {
      var candidate = detectColumnMap(rows[i].cells);
      if (candidate.map.question === undefined || candidate.map.answer === undefined) continue;
      if (candidate.score > bestScore) {
        bestScore = candidate.score;
        headerIndex = i;
        columnMap = candidate.map;
      }
    }

    if (headerIndex < 0) {
      if (ctx.auxiliary) {
        return { questions: questions, rows: 0 };
      }
      var width = 0;
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].cells.length > width) width = rows[r].cells.length;
      }
      if (width < 2) {
        warnings.push(prefix + "未识别到表头，且不足两列，已跳过该" + unit);
        return { questions: questions, rows: 0 };
      }
      columnMap = defaultColumnMap(width);
      warnings.push(prefix + "未识别到表头，已按列序（题目、答案、关键词、解析、标签、难度）读取");
    }

    var dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
    var examined = 0;
    for (var rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
      var row = dataRows[rowIndex];
      var cells = row.cells;
      var hasContent = false;
      for (var c = 0; c < cells.length; c++) {
        if (toStr(cells[c]).trim()) {
          hasContent = true;
          break;
        }
      }
      if (!hasContent) continue;
      if (looksLikeHeaderRow(cells)) continue;
      examined++;

      var source = ctx.sheetName
        ? ctx.fileName + " / " + ctx.sheetName + " / 第 " + row.n + " 行"
        : ctx.fileName + " / 第 " + row.n + " 行";
      var fields = {
        question: cellAt(cells, columnMap, "question"),
        answer: cellAt(cells, columnMap, "answer"),
        keywords: cellAt(cells, columnMap, "keywords"),
        explanation: cellAt(cells, columnMap, "explanation"),
        tags: cellAt(cells, columnMap, "tags"),
        difficulty: cellAt(cells, columnMap, "difficulty")
      };
      var question = createQuestion(fields, { short: prefix + "第 " + row.n + " 行", source: source }, warnings);
      if (question) questions.push(question);
    }
    return { questions: questions, rows: examined };
  }

  /* ------------------------------------------------------------
   * 4. ZIP 读取器（中央目录 + 原生 DecompressionStream）
   * ---------------------------------------------------------- */

  function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function readU64(bytes, offset) {
    var low = readU32(bytes, offset);
    var high = readU32(bytes, offset + 4);
    return high * 4294967296 + low;
  }

  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  function decodeZipName(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      try {
        return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
      } catch (error2) {
        return decodeUtf8(bytes);
      }
    }
  }

  function findEndOfCentralDirectory(bytes) {
    var minimum = Math.max(0, bytes.length - 65557);
    for (var offset = bytes.length - 22; offset >= minimum; offset--) {
      if (readU32(bytes, offset) === 0x06054b50) return offset;
    }
    return -1;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持原生 ZIP 解压（DecompressionStream），请使用 Chrome / Edge 103 或更新版本。");
    }
    try {
      var source = new Blob([data]).stream();
      var stream = source.pipeThrough(new DecompressionStream("deflate-raw"));
      var buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      throw new Error("ZIP 解压失败（deflate-raw），文件可能已损坏。");
    }
  }

  function ZipArchive(bytes) {
    this.bytes = bytes;
    this.entries = new Map();
    this._readCentralDirectory();
  }

  ZipArchive.prototype._readCentralDirectory = function () {
    var bytes = this.bytes;
    var eocd = findEndOfCentralDirectory(bytes);
    if (eocd < 0) {
      throw new Error("无法解析 ZIP：未找到中央目录，文件可能已损坏或不是有效的 .xlsx/.docx。");
    }
    var totalEntries = readU16(bytes, eocd + 10);
    var cdOffset = readU32(bytes, eocd + 16);

    /* ZIP64：仅在工作簿很大时出现，做最小兼容 */
    if ((totalEntries === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && readU32(bytes, eocd - 20) === 0x07064b50) {
      var zip64Offset = readU64(bytes, eocd - 20 + 8);
      if (zip64Offset + 56 <= bytes.length && readU32(bytes, zip64Offset) === 0x06064b50) {
        totalEntries = readU64(bytes, zip64Offset + 32);
        cdOffset = readU64(bytes, zip64Offset + 48);
      }
    }

    var pointer = cdOffset;
    var count = 0;
    while (count < totalEntries && pointer + 46 <= bytes.length) {
      if (readU32(bytes, pointer) !== 0x02014b50) break;
      var flags = readU16(bytes, pointer + 8);
      var method = readU16(bytes, pointer + 10);
      var compressedSize = readU32(bytes, pointer + 20);
      var uncompressedSize = readU32(bytes, pointer + 24);
      var nameLength = readU16(bytes, pointer + 28);
      var extraLength = readU16(bytes, pointer + 30);
      var commentLength = readU16(bytes, pointer + 32);
      var localOffset = readU32(bytes, pointer + 42);

      var extraStart = pointer + 46 + nameLength;
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        var extraEnd = Math.min(bytes.length, extraStart + extraLength);
        var extraPointer = extraStart;
        while (extraPointer + 4 <= extraEnd) {
          var extraId = readU16(bytes, extraPointer);
          var extraSize = readU16(bytes, extraPointer + 2);
          var fieldEnd = Math.min(extraEnd, extraPointer + 4 + extraSize);
          var valuePointer = extraPointer + 4;
          if (extraId === 0x0001) {
            if (uncompressedSize === 0xffffffff && valuePointer + 8 <= fieldEnd) {
              uncompressedSize = readU64(bytes, valuePointer);
              valuePointer += 8;
            }
            if (compressedSize === 0xffffffff && valuePointer + 8 <= fieldEnd) {
              compressedSize = readU64(bytes, valuePointer);
              valuePointer += 8;
            }
            if (localOffset === 0xffffffff && valuePointer + 8 <= fieldEnd) {
              localOffset = readU64(bytes, valuePointer);
              valuePointer += 8;
            }
          }
          extraPointer = fieldEnd;
        }
      }

      var nameBytes = bytes.subarray(pointer + 46, pointer + 46 + nameLength);
      var name = decodeZipName(nameBytes);
      var key = name.replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
      if (key && !this.entries.has(key)) {
        this.entries.set(key, {
          name: name,
          method: method,
          flags: flags,
          compressedSize: compressedSize,
          uncompressedSize: uncompressedSize,
          localOffset: localOffset
        });
      }
      pointer += 46 + nameLength + extraLength + commentLength;
      count++;
    }

    if (!this.entries.size) {
      throw new Error("ZIP 中央目录为空，文件可能已损坏。");
    }
  };

  ZipArchive.prototype.has = function (name) {
    var key = toStr(name).replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
    return this.entries.has(key);
  };

  ZipArchive.prototype.readBytes = async function (name) {
    var key = toStr(name).replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
    var entry = this.entries.get(key);
    if (!entry) return null;

    var bytes = this.bytes;
    var localOffset = entry.localOffset;
    if (localOffset + 30 > bytes.length || readU32(bytes, localOffset) !== 0x04034b50) {
      throw new Error("ZIP 条目「" + entry.name + "」的本地文件头损坏。");
    }
    var localNameLength = readU16(bytes, localOffset + 26);
    var localExtraLength = readU16(bytes, localOffset + 28);
    var dataStart = localOffset + 30 + localNameLength + localExtraLength;
    var dataEnd = Math.min(bytes.length, dataStart + entry.compressedSize);
    var data = bytes.subarray(dataStart, dataEnd);

    if (entry.method === 0) return data;
    if (entry.method === 8) return await inflateRaw(data);
    throw new Error("ZIP 条目「" + entry.name + "」使用了不支持的压缩方式（" + entry.method + "）。");
  };

  ZipArchive.prototype.readText = async function (name) {
    var data = await this.readBytes(name);
    if (!data) return null;
    return stripBom(decodeUtf8(data));
  };

  /* ------------------------------------------------------------
   * 5. XML 辅助（DOMParser）
   * ---------------------------------------------------------- */

  function parseXml(text, label) {
    if (typeof DOMParser === "undefined") {
      throw new Error("当前环境不支持 XML 解析，无法读取 " + label + "。");
    }
    var doc;
    try {
      doc = new DOMParser().parseFromString(toStr(text), "application/xml");
    } catch (error) {
      throw new Error(label + " 解析失败。");
    }
    if (!doc) throw new Error(label + " 解析失败。");
    var errors = doc.getElementsByTagName("parsererror");
    if (!errors || !errors.length) {
      errors = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS("*", "parsererror") : null;
    }
    if (errors && errors.length) throw new Error(label + " XML 格式错误。");
    return doc;
  }

  function allByLocalName(root, name) {
    var out = [];
    if (!root || !root.getElementsByTagNameNS) return out;
    var nodes = root.getElementsByTagNameNS("*", name);
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
    return out;
  }

  function firstByLocalName(root, name) {
    if (!root || !root.getElementsByTagNameNS) return null;
    var nodes = root.getElementsByTagNameNS("*", name);
    return nodes.length ? nodes[0] : null;
  }

  function directChildrenByLocalName(node, name) {
    var out = [];
    if (!node || !node.childNodes) return out;
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (child.nodeType === 1 && child.localName === name) out.push(child);
    }
    return out;
  }

  function firstDirectChild(node, name) {
    var children = directChildrenByLocalName(node, name);
    return children.length ? children[0] : null;
  }

  function getAttr(element, name) {
    if (!element) return "";
    if (element.getAttribute) {
      var direct = element.getAttribute(name);
      if (direct !== null && direct !== undefined && direct !== "") return direct;
    }
    var attributes = element.attributes || [];
    for (var i = 0; i < attributes.length; i++) {
      var attribute = attributes[i];
      if (attribute.name === name || attribute.localName === name) return attribute.value;
    }
    return "";
  }

  /* ------------------------------------------------------------
   * 6. XLSX 解析
   * ---------------------------------------------------------- */

  function columnLettersToIndex(letters) {
    var upper = toStr(letters).toUpperCase();
    var index = 0;
    for (var i = 0; i < upper.length; i++) {
      var code = upper.charCodeAt(i) - 64;
      if (code < 1 || code > 26) continue;
      index = index * 26 + code;
    }
    return Math.max(0, index - 1);
  }

  /**
   * 读取 sharedStrings 里的一条 si：拼接所有 <t>（兼容富文本多个 <r>），忽略注音 rPh。
   */
  function readRichText(node) {
    var text = "";
    var walk = function (element) {
      var children = element.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType !== 1) continue;
        var name = child.localName;
        if (name === "rPh") continue;
        if (name === "t") {
          text += child.textContent || "";
        } else {
          walk(child);
        }
      }
    };
    walk(node);
    return text;
  }

  async function loadSharedStrings(zip) {
    var text = await zip.readText("xl/sharedStrings.xml");
    if (!text) return [];
    var doc;
    try {
      doc = parseXml(text, "xl/sharedStrings.xml");
    } catch (error) {
      return [];
    }
    var sst = firstByLocalName(doc, "sst");
    var items = sst ? directChildrenByLocalName(sst, "si") : [];
    var strings = [];
    for (var i = 0; i < items.length; i++) strings.push(readRichText(items[i]));
    return strings;
  }

  function readCellValue(cellElement, sharedStrings) {
    var type = getAttr(cellElement, "t");
    var valueElement = firstDirectChild(cellElement, "v");
    var value = valueElement ? valueElement.textContent || "" : "";
    if (type === "s") {
      var index = parseInt(value, 10);
      if (Number.isFinite(index) && sharedStrings[index] !== undefined) return sharedStrings[index];
      return "";
    }
    if (type === "inlineStr") {
      var inline = firstDirectChild(cellElement, "is");
      return inline ? readRichText(inline) : "";
    }
    if (type === "b") {
      if (value === "1") return "TRUE";
      if (value === "0") return "FALSE";
      return value;
    }
    /* str / e / d / n / 无类型：直接使用 <v> 文本，保留换行 */
    return value;
  }

  function parseSheetRows(sheetDoc, sharedStrings) {
    var rows = [];
    var rowElements = allByLocalName(sheetDoc, "row");
    var lastRowNumber = 0;
    for (var i = 0; i < rowElements.length; i++) {
      var rowElement = rowElements[i];
      var rowNumber = parseInt(getAttr(rowElement, "r"), 10);
      if (!Number.isFinite(rowNumber) || rowNumber <= 0) rowNumber = lastRowNumber + 1;
      lastRowNumber = rowNumber;

      var cells = [];
      var cellElements = directChildrenByLocalName(rowElement, "c");
      for (var c = 0; c < cellElements.length; c++) {
        var cellElement = cellElements[c];
        var columnIndex = cells.length;
        var ref = getAttr(cellElement, "r");
        if (ref) {
          var match = /^([A-Za-z]+)/.exec(ref);
          if (match) columnIndex = columnLettersToIndex(match[1]);
        }
        cells[columnIndex] = readCellValue(cellElement, sharedStrings);
      }
      rows.push({ n: rowNumber, cells: cells });
    }
    return rows;
  }

  function resolveZipPath(baseDir, target) {
    var raw = toStr(target).replace(/\\/g, "/").trim();
    if (!raw) return "";
    if (raw.charAt(0) === "/") return raw.replace(/^\/+/, "");
    var combined = baseDir ? baseDir.replace(/\/+$/, "") + "/" + raw : raw;
    var parts = combined.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") {
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join("/");
  }

  async function readWorkbookRelationships(zip) {
    var map = Object.create(null);
    var text = await zip.readText("xl/_rels/workbook.xml.rels");
    if (!text) return map;
    var doc;
    try {
      doc = parseXml(text, "xl/_rels/workbook.xml.rels");
    } catch (error) {
      return map;
    }
    var relationships = allByLocalName(doc, "Relationship");
    for (var i = 0; i < relationships.length; i++) {
      var relationship = relationships[i];
      var id = getAttr(relationship, "Id") || getAttr(relationship, "id");
      var target = getAttr(relationship, "Target");
      if (id && target) map[id] = resolveZipPath("xl", target);
    }
    return map;
  }

  async function parseXlsxInto(bytes, result) {
    var zip = new ZipArchive(bytes);
    var workbookText = await zip.readText("xl/workbook.xml");
    if (!workbookText) {
      throw new Error("文件中缺少 xl/workbook.xml，可能不是有效的 .xlsx 文件。");
    }
    var workbook = parseXml(workbookText, "xl/workbook.xml");
    var relationships = await readWorkbookRelationships(zip);
    var sharedStrings = await loadSharedStrings(zip);
    var sheetElements = allByLocalName(workbook, "sheet");
    var sheetNames = [];
    var totalRows = 0;

    for (var i = 0; i < sheetElements.length; i++) {
      var sheetElement = sheetElements[i];
      var sheetName = getAttr(sheetElement, "name") || "Sheet" + (i + 1);
      sheetNames.push(sheetName);

      var relId = getAttr(sheetElement, "id") || getAttr(sheetElement, "r:id");
      var sheetPath = relId && relationships[relId] ? relationships[relId] : "xl/worksheets/sheet" + (i + 1) + ".xml";
      sheetPath = sheetPath.replace(/^\/+/, "");

      var sheetText = await zip.readText(sheetPath);
      if (!sheetText) {
        result.warnings.push("工作表「" + sheetName + "」缺少数据文件，已跳过");
        continue;
      }
      var sheetDoc;
      try {
        sheetDoc = parseXml(sheetText, sheetPath);
      } catch (error) {
        result.warnings.push("工作表「" + sheetName + "」解析失败，已跳过");
        continue;
      }

      var rows = parseSheetRows(sheetDoc, sharedStrings);
      var parsed = parseTabularRows(rows, {
        fileName: result.name,
        sheetName: sheetName,
        prefix: "工作表「" + sheetName + "」",
        unit: "表",
        auxiliary: isAuxiliarySheetName(sheetName),
        warnings: result.warnings
      });
      for (var q = 0; q < parsed.questions.length; q++) result.questions.push(parsed.questions[q]);
      totalRows += parsed.rows;
    }

    result.meta.type = "xlsx";
    result.meta.sheets = sheetNames;
    result.meta.rows = totalRows;
  }

  /* ------------------------------------------------------------
   * 7. DOCX 解析
   * ---------------------------------------------------------- */

  function extractParagraphText(paragraph) {
    var text = "";
    var walk = function (node) {
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType !== 1) continue;
        var name = child.localName;
        if (name === "t") {
          text += child.textContent || "";
        } else if (name === "br" || name === "cr") {
          text += "\n";
        } else if (name === "tab") {
          text += "\t";
        } else if (name === "delText" || name === "instrText") {
          /* 删除修订与域代码不是正文 */
        } else {
          walk(child);
        }
      }
    };
    walk(paragraph);
    return text;
  }

  function extractCellText(cell) {
    var paragraphs = allByLocalName(cell, "p");
    var pieces = [];
    for (var i = 0; i < paragraphs.length; i++) {
      var text = extractParagraphText(paragraphs[i]).trim();
      if (text) pieces.push(text);
    }
    if (!pieces.length) {
      var fallback = extractParagraphText(cell).trim();
      if (fallback) return fallback;
    }
    return pieces.join("\n");
  }

  function collectTopLevelTables(root) {
    var tables = [];
    var walk = function (node) {
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType !== 1) continue;
        if (child.localName === "tbl") {
          tables.push(child);
          continue;
        }
        walk(child);
      }
    };
    walk(root);
    return tables;
  }

  function collectParagraphsOutsideTables(root) {
    var paragraphs = [];
    var walk = function (node) {
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType !== 1) continue;
        if (child.localName === "tbl") continue;
        if (child.localName === "p") {
          paragraphs.push(child);
          continue;
        }
        walk(child);
      }
    };
    walk(root);
    return paragraphs;
  }

  function readTableMatrix(table) {
    var matrix = [];
    var rowElements = directChildrenByLocalName(table, "tr");
    for (var i = 0; i < rowElements.length; i++) {
      var cells = [];
      var cellElements = directChildrenByLocalName(rowElements[i], "tc");
      for (var c = 0; c < cellElements.length; c++) cells.push(extractCellText(cellElements[c]));
      if (cells.length) matrix.push(cells);
    }
    return matrix;
  }

  async function parseDocxInto(bytes, result) {
    var zip = new ZipArchive(bytes);
    var documentText = await zip.readText("word/document.xml");
    if (!documentText) {
      throw new Error("文件中缺少 word/document.xml，可能不是有效的 .docx 文件。");
    }
    var doc = parseXml(documentText, "word/document.xml");
    var body = firstByLocalName(doc, "body");
    if (!body) throw new Error("word/document.xml 结构异常：缺少 body。");

    /* 7.1 优先解析表格 */
    var tableQuestions = [];
    var tableRows = 0;
    var tables = collectTopLevelTables(body);
    for (var i = 0; i < tables.length; i++) {
      var matrix = readTableMatrix(tables[i]);
      if (!matrix.length) continue;
      var rows = [];
      for (var r = 0; r < matrix.length; r++) rows.push({ n: r + 1, cells: matrix[r] });
      var parsed = parseTabularRows(rows, {
        fileName: result.name,
        sheetName: "表格" + (i + 1),
        prefix: "表格" + (i + 1) + " ",
        unit: "表格",
        auxiliary: false,
        warnings: result.warnings
      });
      for (var q = 0; q < parsed.questions.length; q++) tableQuestions.push(parsed.questions[q]);
      tableRows += parsed.rows;
    }

    if (tableQuestions.length) {
      for (var t = 0; t < tableQuestions.length; t++) result.questions.push(tableQuestions[t]);
      result.meta.type = "docx";
      result.meta.rows = tableRows;
      return;
    }

    /* 7.2 表格无题目时解析正文段落 */
    var paragraphs = collectParagraphsOutsideTables(body);
    var lines = [];
    var paragraphIndexes = [];
    for (var p = 0; p < paragraphs.length; p++) {
      var text = extractParagraphText(paragraphs[p]);
      var parts = text.length ? text.split("\n") : [""];
      for (var partIndex = 0; partIndex < parts.length; partIndex++) {
        lines.push(parts[partIndex]);
        paragraphIndexes.push(p);
      }
    }
    var ctx = {
      warnings: result.warnings,
      shortFor: function (index) {
        return "第 " + (paragraphIndexes[index] + 1) + " 段";
      },
      sourceFor: function (index) {
        return result.name + " / 段落 / 第 " + (paragraphIndexes[index] + 1) + " 段";
      }
    };
    var questions = parseStructuredLines(lines, ctx);
    for (var qi = 0; qi < questions.length; qi++) result.questions.push(questions[qi]);
    result.meta.type = "docx";
    result.meta.rows = lines.length;
  }

  /* ------------------------------------------------------------
   * 8. CSV / 纯文本 / Markdown / JSON 解析
   * ---------------------------------------------------------- */

  function detectDelimiter(text) {
    var candidates = [",", "\t", ";"];
    var sampleLines = normalizeNewlines(text).split("\n").slice(0, 10);
    var best = { delimiter: ",", total: 0 };
    for (var i = 0; i < candidates.length; i++) {
      var delimiter = candidates[i];
      var total = 0;
      for (var l = 0; l < sampleLines.length; l++) {
        var line = sampleLines[l];
        if (!line.trim()) continue;
        var inQuotes = false;
        for (var c = 0; c < line.length; c++) {
          var ch = line.charAt(c);
          if (ch === '"') {
            if (inQuotes && line.charAt(c + 1) === '"') {
              c++;
            } else {
              inQuotes = !inQuotes;
            }
          } else if (!inQuotes && ch === delimiter) {
            total++;
          }
        }
      }
      if (total > best.total) best = { delimiter: delimiter, total: total };
    }
    return best.delimiter;
  }

  function parseDelimited(text, delimiter) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var source = normalizeNewlines(text);

    for (var i = 0; i < source.length; i++) {
      var ch = source.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (source.charAt(i + 1) === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"' && field === "") {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function parseCsvTextInto(text, result, type) {
    var content = stripBom(toStr(text));
    var metaType = type || "csv";
    if (!content.trim()) {
      result.warnings.push("CSV 内容为空。");
      result.meta.type = metaType;
      return;
    }
    var delimiter = detectDelimiter(content);
    var records = parseDelimited(content, delimiter);
    var rows = [];
    for (var i = 0; i < records.length; i++) {
      var cells = records[i];
      var hasContent = false;
      for (var c = 0; c < cells.length; c++) {
        if (toStr(cells[c]).trim()) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) rows.push({ n: i + 1, cells: cells });
    }
    if (!rows.length) {
      result.warnings.push("CSV 中没有有效数据行。");
      result.meta.type = metaType;
      return;
    }
    var parsed = parseTabularRows(rows, {
      fileName: result.name,
      sheetName: "",
      prefix: "",
      unit: "文件",
      auxiliary: false,
      warnings: result.warnings
    });
    for (var q = 0; q < parsed.questions.length; q++) result.questions.push(parsed.questions[q]);
    result.meta.type = metaType;
    result.meta.rows = parsed.rows;
  }

  var LINE_LABEL_PATTERNS = [
    { field: "question", re: /^(?:题目|题干|问题|简答题)\s*[：:]\s*(.*)$/ },
    { field: "answer", re: /^(?:参考答案|标准答案|正确答案|参考解答|答案)\s*[：:]\s*(.*)$/ },
    { field: "answer", re: /^答\s*[：:]\s*(.*)$/ },
    { field: "keywords", re: /^(?:关键词|关键字|要点)\s*[：:]\s*(.*)$/ },
    { field: "explanation", re: /^(?:答案解析|解析|分析|说明)\s*[：:]\s*(.*)$/ },
    { field: "tags", re: /^(?:标签|分类|知识点|科目)\s*[：:]\s*(.*)$/ },
    { field: "difficulty", re: /^(?:难度|难易度)\s*[：:]\s*(.*)$/ }
  ];

  function matchLineLabel(line) {
    var text = toStr(line).trim();
    if (!text) return null;
    for (var i = 0; i < LINE_LABEL_PATTERNS.length; i++) {
      var pattern = LINE_LABEL_PATTERNS[i];
      var match = pattern.re.exec(text);
      if (match) return { field: pattern.field, rest: match[1] || "" };
    }
    return null;
  }

  function matchQuestionStart(line) {
    var text = toStr(line).trim();
    if (!text) return null;
    var match = /^第\s*\d{1,4}\s*题\s*[：:、.．)）]?\s*(.*)$/.exec(text);
    if (match) return { rest: match[1] || "" };
    match = /^Q\s*\d{1,4}\s*[.、．:：)）]?\s*(.*)$/i.exec(text);
    if (match) return { rest: match[1] || "" };
    match = /^Q\s*[：:]\s*(.*)$/i.exec(text);
    if (match) return { rest: match[1] || "" };
    match = /^问\s*[：:]\s*(.*)$/.exec(text);
    if (match) return { rest: match[1] || "" };
    match = /^\d{1,4}\s*[.、．)）]\s*(.*)$/.exec(text);
    if (match) return { rest: match[1] || "" };
    return null;
  }

  function parseMarkedLines(lines, ctx) {
    var questions = [];
    var current = null;
    var field = null;
    var pending = "";
    var pendingStart = 0;

    var finalize = function () {
      if (!current) return;
      var meta = { short: ctx.shortFor(current.start), source: ctx.sourceFor(current.start) };
      var question = createQuestion(current, meta, ctx.warnings);
      if (question) questions.push(question);
      current = null;
      field = null;
    };

    var startItem = function (index, text) {
      finalize();
      current = {
        question: text || "",
        answer: "",
        keywords: "",
        explanation: "",
        tags: "",
        difficulty: "",
        start: index
      };
      field = "question";
    };

    for (var i = 0; i < lines.length; i++) {
      var text = toStr(lines[i]).trim();
      if (!text) continue;

      var label = matchLineLabel(text);
      if (label && label.field === "question") {
        pending = "";
        startItem(i, label.rest);
        continue;
      }
      var questionStart = matchQuestionStart(text);
      if (questionStart) {
        pending = "";
        startItem(i, questionStart.rest);
        continue;
      }
      if (!current) {
        if (label) {
          if (pending) {
            startItem(pendingStart, pending);
            pending = "";
          } else {
            continue;
          }
        } else {
          if (!pending) pendingStart = i;
          pending = pending ? pending + "\n" + text : text;
          continue;
        }
      }
      if (label) {
        current[label.field] = current[label.field] ? current[label.field] + "\n" + label.rest : label.rest;
        field = label.field;
        continue;
      }
      var target = field && field !== "question" ? field : "answer";
      current[target] = current[target] ? current[target] + "\n" + text : text;
      field = target;
    }
    finalize();
    return questions;
  }

  function parseBlockLines(lines, ctx) {
    var blocks = [];
    var currentBlock = null;
    for (var i = 0; i < lines.length; i++) {
      var text = toStr(lines[i]);
      if (!text.trim()) {
        if (currentBlock) {
          blocks.push(currentBlock);
          currentBlock = null;
        }
        continue;
      }
      if (!currentBlock) currentBlock = { start: i, lines: [] };
      currentBlock.lines.push(text.trim());
    }
    if (currentBlock) blocks.push(currentBlock);

    var questions = [];
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      var first = block.lines[0];
      var questionText = first;
      var firstLabel = matchLineLabel(first);
      if (firstLabel && firstLabel.field === "question") {
        questionText = firstLabel.rest;
      } else {
        var firstStart = matchQuestionStart(first);
        if (firstStart) questionText = firstStart.rest;
      }

      var fields = {
        question: questionText,
        answer: "",
        keywords: "",
        explanation: "",
        tags: "",
        difficulty: ""
      };
      var field = "answer";
      for (var l = 1; l < block.lines.length; l++) {
        var line = block.lines[l];
        var label = matchLineLabel(line);
        if (label && label.field !== "question") {
          field = label.field;
          fields[field] = fields[field] ? fields[field] + "\n" + label.rest : label.rest;
          continue;
        }
        var target = field || "answer";
        fields[target] = fields[target] ? fields[target] + "\n" + line : line;
      }

      var question = createQuestion(
        fields,
        { short: ctx.shortFor(block.start), source: ctx.sourceFor(block.start) },
        ctx.warnings
      );
      if (question) questions.push(question);
    }
    return questions;
  }

  function parseStructuredLines(lines, ctx) {
    var hasMarkup = false;
    for (var i = 0; i < lines.length; i++) {
      var text = toStr(lines[i]).trim();
      if (!text) continue;
      if (matchQuestionStart(text) || matchLineLabel(text)) {
        hasMarkup = true;
        break;
      }
    }
    return hasMarkup ? parseMarkedLines(lines, ctx) : parseBlockLines(lines, ctx);
  }

  function stripMarkdown(text) {
    var lines = normalizeNewlines(text).split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
        .replace(/^\s{0,3}#{1,6}\s*/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s{0,3}[-*+]\s+/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
      out.push(line);
    }
    return out.join("\n");
  }

  function looksLikeTabTable(text) {
    var lines = normalizeNewlines(text).split("\n");
    var nonEmpty = 0;
    var withTab = 0;
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      nonEmpty++;
      if (lines[i].indexOf("\t") >= 0) withTab++;
    }
    return nonEmpty >= 2 && withTab / nonEmpty >= 0.6;
  }

  function parsePlainTextInto(text, result, type, isMarkdown) {
    var content = stripBom(toStr(text));
    if (isMarkdown) content = stripMarkdown(content);
    if (!content.trim()) {
      result.warnings.push("文本内容为空。");
      result.meta.type = type;
      return;
    }
    if (!isMarkdown && looksLikeTabTable(content)) {
      parseCsvTextInto(content, result, type);
      return;
    }
    var lines = normalizeNewlines(content).split("\n");
    var ctx = {
      warnings: result.warnings,
      shortFor: function (index) {
        return "第 " + (index + 1) + " 行";
      },
      sourceFor: function (index) {
        return result.name + " / 第 " + (index + 1) + " 行";
      }
    };
    var questions = parseStructuredLines(lines, ctx);
    for (var q = 0; q < questions.length; q++) result.questions.push(questions[q]);
    result.meta.type = type;
    result.meta.rows = lines.length;
  }

  function valueOfField(object, field) {
    if (!object || typeof object !== "object") return "";
    var aliases = NORMALIZED_ALIASES[field];
    var keys = Object.keys(object);
    for (var i = 0; i < keys.length; i++) {
      var key = normalizeHeaderKey(keys[i]);
      if (!key) continue;
      for (var a = 0; a < aliases.length; a++) {
        var alias = aliases[a];
        if (key === alias || (alias.length >= 2 && key.indexOf(alias) === 0)) return object[keys[i]];
      }
    }
    return "";
  }

  function parseJsonTextInto(text, result) {
    var content = stripBom(toStr(text)).trim();
    if (!content) {
      result.warnings.push("JSON 内容为空。");
      result.meta.type = "json";
      return;
    }
    var data;
    try {
      data = JSON.parse(content);
    } catch (error) {
      throw new Error("JSON 解析失败：请检查引号、逗号、括号是否配对，以及是否存在多余的逗号或注释。");
    }
    var items;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && Array.isArray(data.questions)) {
      items = data.questions;
    } else {
      throw new Error("JSON 结构不支持：应为题目数组，或包含 questions 数组的对象。");
    }

    var examined = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item === null || item === undefined) continue;
      var fields;
      if (typeof item === "string") {
        fields = { question: item, answer: "", keywords: "", explanation: "", tags: "", difficulty: "" };
      } else if (typeof item === "object") {
        fields = {
          question: valueOfField(item, "question"),
          answer: valueOfField(item, "answer"),
          keywords: valueOfField(item, "keywords"),
          explanation: valueOfField(item, "explanation"),
          tags: valueOfField(item, "tags"),
          difficulty: valueOfField(item, "difficulty")
        };
      } else {
        continue;
      }
      examined++;
      var question = createQuestion(
        fields,
        { short: "第 " + (i + 1) + " 条", source: result.name + " / 第 " + (i + 1) + " 条" },
        result.warnings
      );
      if (question) result.questions.push(question);
    }

    result.meta.type = "json";
    result.meta.rows = examined;
  }

  /* ------------------------------------------------------------
   * 9. 纯文本提取（AI 生成素材，extractText）
   * ---------------------------------------------------------- */

  var EXTRACT_TEXT_LIMIT = 200000;
  var EXTRACT_SUPPORTED_EXTENSIONS = ["txt", "md", "markdown", "csv", "json", "xlsx", "docx"];

  /* 表格类文本按“一行一条记录”输出，单元格内换行压成空格，避免破坏行结构 */
  function collapseCellText(value) {
    return normalizeNewlines(toStr(value)).replace(/\n+/g, " ").trim();
  }

  function rowsToTabbedText(rows) {
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].cells || [];
      var values = [];
      var hasContent = false;
      for (var c = 0; c < cells.length; c++) {
        var value = collapseCellText(cells[c]);
        if (value) hasContent = true;
        values.push(value);
      }
      if (!hasContent) continue;
      while (values.length && !values[values.length - 1]) values.pop();
      lines.push(values.join("\t"));
    }
    return lines.join("\n");
  }

  /* 按文档顺序收集正文里的段落与表格（不进入表格内部） */
  function collectDocxBlocksOrdered(root) {
    var blocks = [];
    var walk = function (node) {
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType !== 1) continue;
        var name = child.localName;
        if (name === "p") {
          blocks.push({ type: "paragraph", node: child });
          continue;
        }
        if (name === "tbl") {
          blocks.push({ type: "table", node: child });
          continue;
        }
        walk(child);
      }
    };
    walk(root);
    return blocks;
  }

  function docxBlocksToText(blocks) {
    var lines = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.type === "paragraph") {
        lines.push(normalizeNewlines(extractParagraphText(block.node)).trim());
        continue;
      }
      var matrix = readTableMatrix(block.node);
      for (var r = 0; r < matrix.length; r++) {
        var cells = [];
        var hasContent = false;
        for (var c = 0; c < matrix[r].length; c++) {
          var value = collapseCellText(matrix[r][c]);
          if (value) hasContent = true;
          cells.push(value);
        }
        if (!hasContent) continue;
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        lines.push(cells.join(" | "));
      }
    }
    /* 保留内部空行，仅去掉文档首尾多余空行 */
    return lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  }

  async function extractXlsxText(zip, result) {
    var workbookText = await zip.readText("xl/workbook.xml");
    if (!workbookText) {
      throw new Error("文件中缺少 xl/workbook.xml，可能不是有效的 .xlsx 文件。");
    }
    var workbook = parseXml(workbookText, "xl/workbook.xml");
    var relationships = await readWorkbookRelationships(zip);
    var sharedStrings = await loadSharedStrings(zip);
    var sheetElements = allByLocalName(workbook, "sheet");
    var blocks = [];
    var includedSheets = [];

    for (var i = 0; i < sheetElements.length; i++) {
      var sheetElement = sheetElements[i];
      var sheetName = getAttr(sheetElement, "name") || "Sheet" + (i + 1);
      if (isAuxiliarySheetName(sheetName)) continue;

      var relId = getAttr(sheetElement, "id") || getAttr(sheetElement, "r:id");
      var sheetPath = relId && relationships[relId] ? relationships[relId] : "xl/worksheets/sheet" + (i + 1) + ".xml";
      sheetPath = sheetPath.replace(/^\/+/, "");

      var sheetText = await zip.readText(sheetPath);
      if (!sheetText) {
        result.warnings.push("工作表「" + sheetName + "」缺少数据文件，已跳过");
        continue;
      }
      var sheetDoc;
      try {
        sheetDoc = parseXml(sheetText, sheetPath);
      } catch (error) {
        result.warnings.push("工作表「" + sheetName + "」解析失败，已跳过");
        continue;
      }
      var rows = parseSheetRows(sheetDoc, sharedStrings);
      includedSheets.push(sheetName);
      var text = rowsToTabbedText(rows);
      if (text) blocks.push(text);
    }

    result.meta.sheets = includedSheets;
    if (!sheetElements.length) result.warnings.push("工作簿中没有工作表。");
    return blocks.join("\n\n");
  }

  async function extractDocxText(zip, result) {
    var documentText = await zip.readText("word/document.xml");
    if (!documentText) {
      throw new Error("文件中缺少 word/document.xml，可能不是有效的 .docx 文件。");
    }
    var doc = parseXml(documentText, "word/document.xml");
    var body = firstByLocalName(doc, "body");
    if (!body) throw new Error("word/document.xml 结构异常：缺少 body。");
    return docxBlocksToText(collectDocxBlocksOrdered(body));
  }

  function extractJsonText(bytes, result) {
    var raw = normalizeNewlines(stripBom(decodeBytes(bytes)));
    if (!raw.trim()) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
      result.warnings.push("JSON 解析失败，已按原始文本提取。");
      return raw;
    }
  }

  /**
   * 提取文件的纯文本，供 AI 生成题目使用。
   * @returns {Promise<{ok: boolean, text: string, warnings: string[], meta: {type: string, sheets?: string[], chars: number}}>}
   */
  async function extractText(file, options = {}) {
    var name = file && typeof file.name === "string" && file.name ? file.name : "未命名文件";
    var ext = getExtension(name);
    var result = {
      ok: false,
      text: "",
      warnings: [],
      meta: { type: ext || "unknown", chars: 0 }
    };

    try {
      if (!file || typeof file.arrayBuffer !== "function") {
        result.warnings.push("无效的文件对象。");
        return result;
      }
      if (!ext) {
        result.warnings.push("无法识别文件类型：文件名缺少扩展名。");
        return result;
      }
      if (ext === "pdf") {
        result.warnings.push("暂不支持直接读取 PDF，请先转换为 Word（.docx）或文本（.txt / .md）后再试。");
        return result;
      }
      if (ext === "doc") {
        result.warnings.push("旧版 .doc 请先另存为 .docx 后再试。");
        return result;
      }
      if (ext === "xls") {
        result.warnings.push("旧版 .xls 请先另存为 .xlsx 后再试。");
        return result;
      }
      if (EXTRACT_SUPPORTED_EXTENSIONS.indexOf(ext) < 0) {
        result.warnings.push("不支持的文件格式 ." + ext + "，支持：.txt、.md、.csv、.json、.xlsx、.docx。");
        return result;
      }

      var buffer = await file.arrayBuffer();
      var bytes = new Uint8Array(buffer);
      if (!bytes.length) {
        result.warnings.push("文件内容为空。");
        return result;
      }

      var text = "";
      if (ext === "xlsx") {
        text = await extractXlsxText(new ZipArchive(bytes), result);
        result.meta.type = "xlsx";
      } else if (ext === "docx") {
        text = await extractDocxText(new ZipArchive(bytes), result);
        result.meta.type = "docx";
      } else if (ext === "json") {
        text = extractJsonText(bytes, result);
        result.meta.type = "json";
      } else {
        text = normalizeNewlines(stripBom(decodeBytes(bytes)));
        result.meta.type = ext;
      }

      result.ok = true;
      if (!text.trim()) result.warnings.push("未提取到文本内容。");
      if (text.length > EXTRACT_TEXT_LIMIT) {
        var originalLength = text.length;
        text = text.slice(0, EXTRACT_TEXT_LIMIT);
        result.warnings.push("文本共 " + originalLength + " 字符，超过 200,000 字符上限，已截断。");
      }
      result.text = text;
    } catch (error) {
      result.ok = false;
      result.text = "";
      result.warnings.push(describeError(error));
    }

    result.meta.chars = result.text.length;
    return result;
  }

  /* ------------------------------------------------------------
   * 10. 对外 API
   * ---------------------------------------------------------- */

  function decodeBytes(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      try {
        return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
      } catch (error2) {
        return new TextDecoder("utf-8").decode(bytes);
      }
    }
  }

  async function parseFile(file, options = {}) {
    var name = file && typeof file.name === "string" && file.name ? file.name : "未命名文件";
    var ext = getExtension(name);
    var result = makeResult(name, ext, ext || "unknown");

    try {
      if (!file || typeof file.arrayBuffer !== "function") {
        result.errors.push("无效的文件对象。");
        return result;
      }
      if (!ext) {
        result.errors.push("无法识别文件类型：文件名缺少扩展名。");
        return result;
      }
      if (ext === "xls") {
        result.errors.push("旧版 .xls 请先另存为 .xlsx（在 Excel / WPS 中打开后选择“另存为”，保存为 .xlsx 再导入）。");
        return result;
      }
      if (SUPPORTED_EXTENSIONS.indexOf(ext) < 0) {
        result.errors.push("不支持的文件格式 ." + ext + "，支持：.xlsx、.docx、.csv、.txt、.md、.json。");
        return result;
      }

      var buffer = await file.arrayBuffer();
      var bytes = new Uint8Array(buffer);
      if (!bytes.length) {
        result.errors.push("文件内容为空。");
        return result;
      }

      if (ext === "xlsx") {
        await parseXlsxInto(bytes, result, options);
      } else if (ext === "docx") {
        await parseDocxInto(bytes, result, options);
      } else if (ext === "csv") {
        parseCsvTextInto(decodeBytes(bytes), result, "csv");
      } else if (ext === "json") {
        parseJsonTextInto(decodeBytes(bytes), result);
      } else if (ext === "md" || ext === "markdown") {
        parsePlainTextInto(decodeBytes(bytes), result, "markdown", true);
      } else {
        parsePlainTextInto(decodeBytes(bytes), result, "txt", false);
      }

      result.ok = result.errors.length === 0;
      if (result.ok && !result.questions.length) {
        result.warnings.push("未找到可导入的题目，请检查表头与内容格式。");
      }
    } catch (error) {
      result.ok = false;
      result.errors.push(describeError(error));
    }
    return result;
  }

  async function parseFiles(files, options = {}) {
    var aggregate = { files: [], questions: [], warnings: [] };
    var list = [];
    try {
      if (files) {
        if (typeof files[Symbol.iterator] === "function") {
          var iterator = files[Symbol.iterator]();
          var step = iterator.next();
          while (!step.done) {
            list.push(step.value);
            step = iterator.next();
          }
        } else {
          list.push(files);
        }
      }
    } catch (error) {
      aggregate.warnings.push("读取文件列表失败：" + describeError(error));
      return aggregate;
    }

    if (!list.length) {
      aggregate.warnings.push("没有选择任何文件。");
      return aggregate;
    }

    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var result;
      try {
        result = await parseFile(file, options || {});
      } catch (error) {
        result = makeResult(file && file.name, getExtension(file && file.name), "unknown");
        result.errors.push(describeError(error));
      }
      aggregate.files.push(result);
      for (var q = 0; q < result.questions.length; q++) aggregate.questions.push(result.questions[q]);
      for (var w = 0; w < result.warnings.length; w++) aggregate.warnings.push(result.name + "：" + result.warnings[w]);
      for (var e = 0; e < result.errors.length; e++) aggregate.warnings.push(result.name + "：" + result.errors[e]);
    }
    return aggregate;
  }

  function parseText(text, options) {
    var opts = options || {};
    var filename = typeof opts.filename === "string" && opts.filename.trim() ? opts.filename.trim() : "粘贴内容.txt";
    var format = String(opts.format || "text").toLowerCase();
    var isJson = format === "json";
    var isCsv = format === "csv";
    var isMarkdown = format === "markdown" || format === "md";
    var ext = isJson ? "json" : isCsv ? "csv" : isMarkdown ? "md" : "txt";
    var metaType = isJson ? "json" : isCsv ? "csv" : isMarkdown ? "markdown" : "text";
    var result = makeResult(filename, ext, metaType);

    try {
      var content = stripBom(toStr(text));
      if (!content.trim()) {
        result.warnings.push("粘贴内容为空。");
        result.ok = true;
        return result;
      }
      if (isJson) {
        parseJsonTextInto(content, result);
      } else if (isCsv) {
        parseCsvTextInto(content, result, "csv");
      } else {
        parsePlainTextInto(content, result, isMarkdown ? "markdown" : "text", isMarkdown);
      }
      result.ok = result.errors.length === 0;
      if (result.ok && !result.questions.length) {
        result.warnings.push("未找到可导入的题目，请检查题目与答案的格式。");
      }
    } catch (error) {
      result.ok = false;
      result.errors.push(describeError(error));
    }
    return result;
  }

  function csvEscape(value) {
    var text = toStr(value);
    if (/[",\r\n;]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function buildTemplateCSV() {
    var rows = [
      ["题目", "参考答案", "关键词", "解析", "标签", "难度"],
      [
        "示例：什么是间隔重复？",
        "间隔重复是指按照逐渐拉长的复习间隔重复学习同一材料，让遗忘发生在复习之后、记忆消退之前，从而用较少的复习次数换取更持久的记忆。",
        "间隔重复、遗忘曲线、复习计划",
        "间隔重复利用遗忘曲线的规律安排复习时间点，是公认高效的长时记忆方法。",
        "学习方法、记忆",
        "1"
      ],
      [
        "示例：TCP 三次握手解决了什么问题？",
        "三次握手用于在不可靠的信道上确认双方的收发能力与初始序列号，建立可靠的连接；它也能避免历史重复连接请求造成的资源浪费。",
        "TCP、三次握手、可靠性",
        "SYN、SYN-ACK、ACK 三步分别确认了客户端与服务端的发送和接收能力。",
        "计算机网络、协议",
        "3"
      ]
    ];
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      for (var c = 0; c < rows[i].length; c++) cells.push(csvEscape(rows[i][c]));
      lines.push(cells.join(","));
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  var api = {
    SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS.slice(),
    parseFiles: parseFiles,
    parseFile: parseFile,
    parseText: parseText,
    extractText: extractText,
    buildTemplateCSV: buildTemplateCSV
  };

  global.ShifenImport = api;
  if (typeof window !== "undefined" && window !== global) window.ShifenImport = api;
})(typeof window !== "undefined" ? window : globalThis);
