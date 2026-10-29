# 拾分 · AI 功能使用指南

> AI 是「拾分」的可选增强功能。**不配置 AI，导入、练习、评分、统计等离线功能完全照常工作。**
> 所有 AI 调用都通过你自己填写的 OpenAI 兼容接口完成：DeepSeek、OpenAI、本地 Ollama 或自建代理均可。

---

## 1. 它能做什么、不能做什么

### 能做什么

- **AI 点评答案**：对照参考答案，指出你的回答覆盖了哪些要点、漏了哪些，并给出改进建议。
- **AI 提取关键词**：从参考答案中提取可用于自检的短词 / 术语。
- **AI 补全关键词**：导入题库时，为缺少关键词的题目批量补齐（服务内部每 8 道题一批调用）；也可在 AI 设置里开启「导入时自动补全关键词」（最多 20 道）。
- **AI 生成题目**：根据你提供的材料或主题生成简答题，确认预览后再导入题库。
- **连接测试**：保存配置前先验证地址、模型、Key 是否可用。

### 不能做什么

- **AI 点评不是考试分数。** `score` 只是对「覆盖度」的粗略估计，不能替代参考答案，也不能替代你自己的判断。
- **AI 可能说错。** 模型可能漏要点、编造材料外的事实，或对表述不同但意思正确的答案误判。
- **AI 生成的题目需要你核对。** 尤其是事实、数字、专业术语；确认后再导入题库。
- **AI 不参与你的评分记录。** 练习里的评分仍由你自己选择；AI 点评失败不会写入缓存，旧的 AI 点评也不会被覆盖。
- **没有配置或没有网络时，AI 按钮会提示先配置。** 其余离线功能不受影响。

---

## 2. 五分钟上手

1. 打开「拾分」→ 左下角 **设置** → **AI 服务**。
2. 打开 **启用 AI** 开关。
3. 选择服务商（DeepSeek / OpenAI / Ollama / 自定义代理），选择后会自动填入 Base URL 和模型名。
4. 按需修改 **Base URL** 和 **模型**；云端服务还需要填写 **API Key**（本地 Ollama 可留空）。
5. 点击 **测试连接**，看到延迟与模型名后，点击 **保存**。
6. 去练习页：查看答案后会出现「AI 学习助手」，可以点评你的答案或提取关键词。
7. 去导入弹窗：「AI 生成」标签页可以粘贴材料生成题目；普通导入的预览里可以「AI 补全关键词」。

> 配置会保存在本机浏览器的 localStorage 中。API Key **不会**写入导出的 JSON 备份；清除浏览器数据后需要重新填写。

---

## 3. 各服务商配置

### 3.1 DeepSeek（推荐中文场景）

| 配置项 | 值 |
| --- | --- |
| 服务商 | DeepSeek |
| Base URL | `https://api.deepseek.com/v1` |
| 模型 | `deepseek-chat` |
| API Key | 在 DeepSeek 开放平台创建，形如 `sk-...` |

- 中文简答点评效果通常较好，价格相对低。
- 需要能访问 `api.deepseek.com`；模型名以服务商控制台的最新列表为准。

### 3.2 OpenAI

| 配置项 | 值 |
| --- | --- |
| 服务商 | OpenAI |
| Base URL | `https://api.openai.com/v1` |
| 模型 | `gpt-4o-mini`（或你账户可用的其他模型） |
| API Key | 在 OpenAI 平台创建，形如 `sk-...` |

- 生成题和结构化 JSON 输出较稳定。
- 国内网络是否可达、是否被 CORS 拦截取决于你的网络环境与服务商策略；连不上时看第 6 节。

### 3.3 Ollama（本地、免费、默认不出本机）

适合注重隐私、希望离线使用的用户。需要先安装 [Ollama](https://ollama.com/)。

**命令行准备：**

```bash
ollama serve                 # 启动本地服务（若已作为后台服务运行可跳过）
ollama pull qwen2.5:7b       # 拉取一个中文模型（7B 体积较小，效果有限）
```

**在拾分中填写：**

| 配置项 | 值 |
| --- | --- |
| 服务商 | Ollama（本地） |
| Base URL | `http://127.0.0.1:11434/v1`（用 `localhost` 通常也可以，但个别浏览器会优先解析到 IPv6 `::1` 导致连不上，建议用 `127.0.0.1`） |
| 模型 | `qwen2.5:7b`（必须与 `ollama list` 中的名称一致） |
| API Key | 留空 |

**允许浏览器跨域（重要）：**

Ollama 默认只接受特定来源的请求。浏览器直连被拦截时，会看到 `NETWORK` 网络错误。需要让 Ollama 允许拾分页面所在来源：

- Windows（PowerShell，临时，当前窗口有效）：

  ```powershell
  $env:OLLAMA_ORIGINS="*"
  ollama serve
  ```

- Windows（持久化，重新登录 / 重启 Ollama 后生效）：

  ```powershell
  setx OLLAMA_ORIGINS "*"
  ```

- macOS（重启 Ollama 应用后生效）：

  ```bash
  launchctl setenv OLLAMA_ORIGINS "*"
  ```

- Linux（systemd）：

  ```bash
  sudo systemctl edit ollama
  # 在编辑器中加入：
  # [Service]
  # Environment="OLLAMA_ORIGINS=*"
  sudo systemctl daemon-reload
  sudo systemctl restart ollama
  ```

> `OLLAMA_ORIGINS=*` 会让本机 Ollama 接受任何网页的请求。只建议在个人电脑上临时使用；更稳妥的做法是把来源限制为拾分页面的地址，例如 `OLLAMA_ORIGINS=http://127.0.0.1:8080`（具体取决于你用什么地址打开拾分）。
> 修改环境变量后必须**重启 Ollama 服务 / 应用**才会生效。

### 3.4 自定义代理 / 其他兼容服务

任何兼容 OpenAI `POST /chat/completions` 的服务都可以接入。

| 配置项 | 值 |
| --- | --- |
| 服务商 | 自定义代理 |
| Base URL | 你的网关地址，**填到 `/v1` 这一级**，例如 `https://ai.example.com/v1` |
| 模型 | 你的网关实际支持的模型 ID |
| API Key | 网关要求鉴权时填写；不需要则留空 |

拾分实际请求的地址是：

```
{Base URL 去掉末尾斜杠}/chat/completions
```

请求头包含 `Content-Type: application/json`；填写了 Key 时会带 `Authorization: Bearer <Key>`；不填 Key 时不带该头。

**自建代理时，请让代理：**

1. 透传 `Authorization` 请求头；
2. 代为请求上游服务；
3. 在响应里加上 CORS 头，例如：
   - `Access-Control-Allow-Origin: *`（或你的页面来源）
   - `Access-Control-Allow-Headers: Content-Type, Authorization`
   - `Access-Control-Allow-Methods: POST, OPTIONS`
4. 正确响应浏览器的 `OPTIONS` 预检（返回 204 即可）。

> 用代理可以把 Key 留在服务端，避免浏览器直连第三方；但这超出了拾分的范围，需要你自己部署。

---

## 4. CORS 与「双击打开 index.html」

浏览器里直连第三方 API，会遇到浏览器同源策略（CORS）限制。典型表现：

- 页面提示 **网络请求失败 / NETWORK**，但浏览器开发者工具里能看到请求被 CORS 拦截；
- 用 curl 能调通，但网页里不行。

可能的原因与处理：

1. **服务商不允许浏览器直连**：换用支持 CORS 的代理，或改用本地 Ollama。
2. **本地 Ollama 未设置 `OLLAMA_ORIGINS`**：按第 3.3 节设置并重启 Ollama。
3. **用 `file://` 直接双击打开页面**：此时浏览器发送的 `Origin` 可能是 `null`，部分服务会拒绝。建议用本地静态服务器打开，例如：

   ```bash
   # 在拾分目录下执行（需要 Python）
   python -m http.server 8080
   # 然后浏览器访问 http://localhost:8080/
   ```

4. **代理 / 公司网络 / 广告拦截插件**：可能拦截第三方请求，尝试关闭插件或换网络。

> 只有 AI 调用受 CORS 影响；不联网的导入、练习、统计功能不受影响。

---

## 5. 隐私、数据与费用

### 会发送什么

| 操作 | 发送内容 |
| --- | --- |
| AI 点评 | 当前题目、参考答案、你的答案、当前关键词 |
| AI 提取关键词 | 当前题目、参考答案、已有关键词 |
| AI 补全关键词 | 当前批次（最多 8 道）的题目、参考答案、已有关键词 |
| AI 生成题目 | 你提供的材料文本 / 主题、题数、难度、标签、补充要求 |

**不会发送**其他题库、你的练习历史、收藏、备注或个人信息。但请注意：请求会经过你的网络、代理和所选服务商，是否被记录取决于服务商政策。

### API Key 安全

- Key 只保存在本机浏览器的 localStorage，不会上传到拾分的任何服务器（拾分本身没有服务器）。
- 导出的 JSON 备份**不包含** API Key；把备份发给别人不会泄露 Key。
- 清除浏览器数据、换浏览器、换电脑后，需要重新填写 Key。
- 不要把带有 Key 的截图、日志或配置发给他人。

### 费用

- 云端服务按输入 / 输出 token 计费。一次点评通常只涉及一道题的几百到几千 token；**批量补关键词、生成大量题目、材料很长时会明显增加费用**。
- 建议先用 1～3 道题测试效果，再决定是否批量调用；一次生成 5～10 道题通常比一次生成 20～30 道更可控。
- 本地 Ollama 不产生 API 费用，但会占用本机 CPU / 内存 / 显卡资源，速度取决于硬件。
- 拾分无法代你查看余额或限制费用，账户额度、限流以服务商为准。

---

## 6. 常见错误排查

拾分会把服务层错误转成中文提示，并带上错误码。看到提示时先对照下表：

| 错误码 | 常见提示 | 可能原因 | 处理 |
| --- | --- | --- | --- |
| `CONFIG` | 尚未配置 Base URL / 模型 / 缺少 API Key / AI 功能尚未启用 | 配置没填全、开关没开、URL 不是 `http(s)://` | 到「设置 → AI 服务」补全并保存；确认启用开关已打开 |
| `AUTH` | 鉴权失败（HTTP 401 / 403） | Key 错误、过期、无权限、复制时带了空格或引号 | 重新复制 Key（注意不要带空格/引号）；确认账户可用 |
| `MODEL` | 模型或接口不存在（HTTP 404） | Base URL 少了 `/v1`、模型名拼错、该模型未开通 | 核对 Base URL 与模型 ID；Ollama 用 `ollama list` 查看名称 |
| `RATE` | 请求过于频繁或额度不足（HTTP 429） | 触发限流、余额不足、并发过高 | 稍后重试；检查账户余额与限流；减少批量题数 |
| `NETWORK` | 网络请求失败（可能被 CORS 拦截 / Ollama 未启动） | 断网、地址错误、CORS、Ollama 没开 | 检查网络；Ollama 设置 `OLLAMA_ORIGINS` 并重启；改用本地服务器打开页面 |
| `TIMEOUT` | 请求超时（45 / 60 / 120 秒） | 模型太慢、材料太长、网络不稳定 | 重试；换更快的模型；减少一次生成的题数 / 材料长度 |
| `HTTP` | 接口返回异常状态（HTTP 4xx / 5xx） | 参数不支持、服务端故障、代理报错 | 查看提示里的状态码与服务返回摘要；稍后重试或联系服务商 |
| `PARSE` | 模型返回无法解析为 JSON | 模型没按 JSON 输出、返回了普通文本、被截断 | 重试；换指令遵循能力更强的模型；降低温度 |

补充：

- **测试连接成功、但点评失败**：可能是模型对长 JSON 指令遵循不佳，或该模型不支持当前参数；先重试，再换模型。
- **首次调用很慢**：本地模型加载需要时间；云端冷启动也可能较慢。
- **超时后不要连续狂点**：避免重复计费，等几秒再试。

---

## 7. 模型与参数建议

| 场景 | 建议 |
| --- | --- |
| 中文简答点评 | `deepseek-chat`、`gpt-4o-mini` 等通用对话模型 |
| 生成题目 / 结构化 JSON | 优先选择指令遵循强、支持长上下文的模型 |
| 本地 / 隐私优先 | Ollama + `qwen2.5:7b` 起步；7B 模型对细节点评能力有限，硬件允许可选 14B / 32B |
| 温度 | 默认 `0.3`；点评、提取关键词建议 0.2～0.4，生成题可略高 |
| 单次生成题数 | 建议 5～10 道；最多 30 道，题数越多越慢、越贵 |
| 批量补关键词 | 服务内部自动每 8 道题一批；一次补很多题时注意费用与限流 |

说明：

- 拾分不强制使用 `response_format`，以兼容更多服务；解析时会容忍 ```json 代码围栏和前后说明文字。
- 纯推理型模型、或对「只输出 JSON」遵循较差的模型，可能出现 `PARSE` 错误。
- 不同服务商对 `max_tokens`、温度、模型名的支持不同；报 `HTTP` 时可先换默认模型测试。

---

## 8. 能力边界与免责声明

- AI 点评的 `score` 是**覆盖度估计**，不是考试分数，也不代表真实掌握程度；请以参考答案和你自己的判断为准。
- 参考答案为空或不完整时，点评质量会明显下降；建议先补全参考答案。
- AI 生成题目严格来说只是「草稿」，可能出现事实错误、重复题、答案与题目不匹配；导入前请核对。
- 拾分不保存你的 AI 对话，也不会把 AI 点评写进你的评分记录；AI 调用失败不会污染已有数据。
- 长材料可能被界面或服务层截断（服务层单次材料上限约 3 万字符）；超长文档建议分段生成。
- 不支持图片、PDF 直接识别；请先用导入器把内容转成文本 / Word / Excel / CSV。
- 本指南中的模型名、地址、价格、限流以各服务商最新文档为准。

---

## 9. 开发者信息

### 文件

| 文件 | 作用 |
| --- | --- |
| `js/ai.js` | AI 服务层，挂载 `window.ShifenAI`；零依赖、不操作 DOM、不读写 localStorage |
| `tests/mock-ai-server.mjs` | 本地 OpenAI 兼容 mock 服务（仅测试用，不访问外网） |
| `tests/ai-service-check.mjs` | 服务层自动化自测（Node `vm` 加载 `ai.js` + 启动 mock 子进程） |

### API 摘要

```js
window.ShifenAI = {
  PRESETS,                                  // deepseek / openai / ollama / custom
  configure(config),                        // 合并并保存配置，返回规范化 config
  getConfig(),                              // 返回配置副本
  isConfigured(config),                     // enabled && baseUrl && model && (无需 key || 有 key)
  testConnection(configOverride),           // -> { ok, latency, model, message, code? }
  reviewAnswer({ question, reference, keywords, userAnswer }),
  extractKeywords({ question, reference, existingKeywords }),
  completeKeywordsBatch(items),             // items = [{ index, question, reference, existingKeywords }]
  generateQuestions({ text, topic, count, difficulty, tags, instructions })
};
```

- 接口：`POST {baseUrl}/chat/completions`；默认超时：点评 / 关键词 45 秒，批量 60 秒，生成 120 秒。
- 错误统一抛出带 `code` 与中文 `message` 的 `Error`：`CONFIG` / `AUTH` / `MODEL` / `RATE` / `NETWORK` / `TIMEOUT` / `HTTP` / `PARSE`。
- 归一化：`score` 限制 0–100；`verdict` 限定四档；数组去重；`keywords` 最多 8 个；生成题最多 `count` 道（上限 30）；`difficulty` 限定 1–3。
- 批量失败时错误消息会标明第几批，并在 `error.partial` 中带上已成功批次的结果。
- 服务层不会把 API Key 打印到 console。

### 本地自测

```bash
# 启动 mock（默认端口 18765）
node tests/mock-ai-server.mjs --port 18765

# 另开终端运行服务层自测（会自动启动 / 关闭 mock）
node tests/ai-service-check.mjs
```

预期输出 `42 passed, 0 failed`。自测不访问外网，覆盖：

- 连接测试、点评、关键词、批量、生成；
- `CONFIG` / `AUTH` / `MODEL` / `RATE` / `NETWORK` / `TIMEOUT` / `HTTP` / `PARSE` 分支；
- 越界分值、重复数组、难度 9、关键词超量、题数超量等归一化；
- mock 的 CORS / OPTIONS / 401 / bad-json / 端口占用。

mock 的测试模式（仅供测试，普通使用不需要）：

- 请求头：`x-mock-status: 401`、`x-mock-bad-json: 1`、`x-mock-delay: 1500`、`x-mock-overflow: 1`；
- 路径：`/mock-status-401/`、`/mock-bad-json/`、`/mock-overflow/`、`/mock-delay-1500/`、`/mock-require-auth/`。

更多接口细节见 [`docs/ai-contract.md`](./ai-contract.md)。

---

## 10. 一句话总结

**AI 是辅助你回忆和自检的工具，不是评分老师。** 先小批量试用，注意 Key 与隐私，把 AI 的输出当作参考而不是标准答案。
