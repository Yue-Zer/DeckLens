# 多供应商是协议适配，不是品牌条件分支

状态：供应商配置和 Chat 调用已在本地浏览器版接入。下文前半段的多层 Provider / ModelProfile 是后续目标设计；当前运行时使用单个档案同时保存供应商与模型。

## 当前实现

- 设置页可新增、编辑、删除、启用供应商档案并测试连接。每个档案包含名称、类型、协议、Base URL、模型名、超时、流式/视觉标记及可选 API Key。
- 已接入 `openai-chat`（OpenAI 兼容服务与 DeepSeek 官方模板）及 `ollama-chat`。Anthropic Messages 可在界面选择为预留协议，但保存后不能测试或调用。
- 统一的 Core chat 输入支持 system/user/assistant 文本消息、温度、最大输出长度及显式图片 part。OpenAI Chat Completions 和 Ollama Chat 各自转换请求、解析 JSON/SSE/NDJSON；不支持的协议或未启用的流式/视觉能力会在请求前拒绝。上游 HTTP 400 对图片或可选参数给出具体提示，错误正文不回传。
- 浏览器端通过本地 HTTP 调用 `GET/POST/PUT/DELETE /api/providers`、档案 `activate`/`key`/`test` 端点与 `POST /api/model/chat`。流式端点发出 `token`、`done`、`error` SSE 事件。
- 公共档案只返回 `hasApiKey` 状态。Key 由设置页通过本机服务写入 `<userData>/config/provider-secrets.json`，POSIX 文件权限为 0600；不进 SQLite、档案 DTO 或模型日志，删除档案/清除 Key 会移除密钥。浏览器输入值仅在编辑当前档案时短暂留在页面状态中，保存后立即清空。
- 连接测试发送最小文本探测，不附带文档内容；网络错误、鉴权失败、超时、限流及模型/参数错误均由 Core 转为固定可读提示。DeepSeek 模板使用官方根地址 `https://api.deepseek.com`，模型名由用户填写。
- HTTP Base URL 仅允许回环地址；远程地址必须使用 HTTPS。模型请求不自动跟随重定向，避免把提示词或认证信息转发到意外目标。

当前没有实现 Anthropic、工具调用、自动供应商回退、模型能力自动探测或按模型保存独立限额。视觉能力由用户为具体模型显式标记；上游拒绝图片时提示模型能力不匹配。

## 1. 三类配置分开存

| 模型 | 主要字段 | 位置与公开性 |
| --- | --- | --- |
| ProviderProfile | id、name、providerKind、protocol、baseUrl、authMode、secretRef、options.timeoutMs、enabled、configVersion、createdAt、updatedAt | SQLite；公开ProviderPublicDto去掉内部secretRef，只给keyConfigured |
| ModelProfile | id、providerId、modelName、displayName、capabilities、limits、defaultParameters、enabled、capabilitySource、capabilityCheckedAt、createdAt、updatedAt | SQLite；能力枚举supported/unsupported/unknown |
| ActiveModelSelection | ai.defaults.modelId | SQLite settings；只存modelId，provider由ModelProfile派生；切换只影响新请求 |
| ProviderCredential | providerId、apiKey | 用户目录专用SecretStore文件；不进库、不回传、不进快照/日志 |

同一供应商可保存多个模型，多个同协议供应商可有不同URL/Key。展示名称不是协议，DeepSeek preset使用OpenAI兼容适配器，不写 `if name===DeepSeek` 分支。

`protocol` 首版规划 `openai-chat / ollama-chat`；预留 `anthropic-messages / openai-responses` 注册位，但未注册的协议保存为disabled并明确显示「暂未支持」，不能假称已实现。`providerKind=custom`表示供应商分类，协议仍选受支持的注册项；新增协议须更新契约和迁移，不能透传任意协议名称。

capabilities统一五键：`textInput / imageInput / streaming / tools / structuredOutput`。界面「支持视觉」对应imageInput，不另建vision真值。limits包含contextWindow/maxOutputTokens；defaultParameters包含temperature/maxOutputTokens。公开DTO与物理列由仓储映射：modelName对应remote_model_id，capabilities对应capabilities_json，limits/defaultParameters分别对应JSON列。生成时把provider.configVersion、实际模型名/能力/参数和capturedAt冻结在ModelExecutionSnapshot中，历史不依赖可变模型行；ModelProfile自身不另设config_version列。

## 2. 预置与URL规则

| preset | protocol | Base URL示例 | 凭据/模型规则 |
| --- | --- | --- | --- |
| OpenAI兼容 | openai-chat | 用户填写；示例https://api.openai.com/v1 | 可配置bearer/none；模型名用户填，无隐式默认 |
| DeepSeek官方 | openai-chat | https://api.deepseek.com | bearer；模型名由用户按官方当前列表确认，不在代码锁死 |
| Ollama本地 | ollama-chat | http://127.0.0.1:11434 | 默认none；用户填写已安装的本地模型，安装/下载不由阅读器自动触发 |

OpenAI兼容适配器将Base URL定义为API根，去除末尾斜线后追加 `/chat/completions`，已有 `/v1`不得再追加 `/v1`。DeepSeek根URL按官方兼容路径使用。Ollama根URL追加 `/api/chat`；不能复用OpenAI路径拼接。设置UI给出将请求的公开endpoint预览，禁止静默更换供应商或跳转第三方中转。

只允许http/https；URL不能携带userinfo、query中的Key或fragment，不接受file/data/javascript等协议。远程默认要求https；本地http作为明确配置允许。loopback与用户自建局域服务可用；验证由用户保存的配置触发，文档不能提供临时任意URL。禁跨源redirect携带Authorization，拒绝非预期重定向；Key/header从SecretStore注入，公开自定义配置不允许任意认证头。

示例不填实际模型名，默认enabled=false，避免将变动中的名称当保证可用。连接测试成功后，用户才启用并选择模型。兼容格式不代表全部能力兼容，应按模型+endpoint验证。

## 3. ProviderAdapter 的逻辑接口

vnext中的后端端口为 `AIAdapter`：`generate(request, context): Promise<AIResponse>`、`stream(request, context): AsyncIterable<NormalizedAIEvent>`、`test(context): Promise<ProviderTestResult>`。ProviderRegistry按protocol选择实现，并在调用前完成配置和能力校验。

`AIBackendContext`由Core组装，含provider、model、AbortSignal及私有resolveSecret/readAsset端口；不能序列化到前端。前端PlatformAdapter只有公开profile、providers.test(providerId)和models.test(modelId)，没有generate直连或认证载荷。generate供非流式端点使用，stream把上游流统一成领域事件。

标准请求内容：requestId、system policy、ordered messages、text/image parts、output limits、temperature、expected citation ids；业务先做来源/能力/预算校验。图片由Core按assetId读取、必要时安全裁剪，外发编码仅存在请求内存，绝不把base64写SQLite。只有明确提交的附件/圈选可进入这次请求。

标准事件使用契约枚举 `start / text_delta / citation_candidate / usage / done / error`；citation_candidate仅在后端校验，前端AnswerEvent只收到验证后的citation。传输封套附requestId/sequence以排序和去重；取消通过AbortSignal与节点cancelled状态表现，不另造不匹配的事件枚举。适配器分别解析OpenAI SSE、Ollama NDJSON等协议，不让Web处理协议差异。工具调用和供应商reasoning字段首版不混进正文；未知字段安全忽略/保留脱敏诊断，不能展示为引用证据。

标准错误码：NOT_CONFIGURED、AUTH_REQUIRED、AUTH_FAILED、MODEL_NOT_FOUND、INVALID_ENDPOINT、CONNECTION_REFUSED、TLS_ERROR、TIMEOUT、RATE_LIMITED、CAPABILITY_UNSUPPORTED、INVALID_RESPONSE、CANCELLED、UPSTREAM_ERROR。显示可操作原因及必要状态码，删除URL凭据、认证头和原始上游错误正文中的敏感值。

不自动跨供应商fallback，也不自动重试可能重复收费的生成。用户显式重试可复用问题snapshot并创建新generation attempt；requestId关联各次尝试，旧回答和模型信息不被覆盖成新模型。上下文快照存实际provider/model名称、revision、参数、能力与预算，不仅存可变profile外键。

## 4. 连接测试与视觉能力

测试只发固定的最小探测内容，不带私人文件/问题/标注，显示本次目标endpoint与可能产生少量调用费用。先校验公开配置与凭据状态，再做协议探测；成功连通不等于证明视觉、长上下文或所有stream实现都可用。

能力为三态。streaming未知时按非流式处理；imageInput未知/unsupported时不发送图像，保留草稿并明确提示。用户可选择支持视觉的模型，或明确选「仅使用已解析文字及我的文字说明」。不能静默OCR图片、丢掉图片后假称看图，或按品牌推断全部模型支持视觉。

图片不能无条件作为成功理解的证据；回答区分「原文图片/图注」「文本检索」「AI生成解释」。多模态答案仍需引用图片所属块/页、区域标注及实际使用的来源。

## 5. 凭据生命周期

当前浏览器版由设置页的密码输入框短暂接收Key，保存时只发送到受本地来源校验保护的 `127.0.0.1` 服务；服务返回的profile仅含 `hasApiKey`，不回传Key。Key 只落在用户数据目录的 `config/provider-secrets.json`，不落SQLite、不写页面源文件、不记日志，删除档案或清除Key会删除对应本机值。开发者工具或浏览器扩展可能观察当前页面输入与本机请求，因此这项浏览器版流程不等同于Electron里“渲染进程完全不可见”的隔离保证；Electron 接入时需通过主进程/安全存储录入与调用，renderer 仅接触状态。

目标桌面版流程仍是由宿主SecretStore读写凭据，普通renderer没有Key读写方法。两种宿主都必须让Key在发往供应商的调用中仅由Core/本地服务注入；日志只记providerId/requestId/errorCode，不记录认证头或原始请求体。普通备份默认排除凭据，导出诊断也排除原文全文/密钥。

## 6. 官方协议参考

- https://api-docs.deepseek.com/ ：DeepSeek官方兼容接口与模型说明。
- https://docs.ollama.com/api/introduction ：Ollama本地API、默认URL与流式协议。
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create ：OpenAI Chat Completions的请求/流事件。

接入阶段再次核对官方接口与可用模型，不以品牌名保证自定义服务完全兼容。首版不强制OpenAI、不自动下载本地模型，不实现Anthropic业务请求。
