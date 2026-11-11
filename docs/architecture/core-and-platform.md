# 同一 Core，通过两个受控宿主访问

状态：设计接口，不是已连接的API。新契约见 `packages/contracts/src/vnext/design.ts`；本轮不会替换现有API或注册Electron IPC。

## 1. Core 模块与端口

| 模块 | 输入 → 输出 | 负责的规则 |
| --- | --- | --- |
| documents | 受控导入文件句柄 → import job、文档/版本 | SHA-256去重、签名探测、状态机、重新解析、原文件生命周期 |
| parsers | 字节流/受控文件读取、资源写入端口 → ParseResult | 原生PPTX/MD/TXT及后续DOCX/PDF；不直接写DB、无UI、无模型依赖 |
| model | ParseResult → 可校验统一模型 | 稳定sourceKey、顺序、来源、警告、块payload；拒绝同来源重复输出 |
| outline | section edit command → revision / tree | 根→章节→小节；改名/移动/拆分/合并、防环、手动操作日志、重解析回放 |
| blocks | 版本/章节/游标 → 块及资源引用 | 单次渲染身份、稳定排序、分页、来源定位、资源归属 |
| exploration | node/edge commands → 活动路径/树 | 单一tree父边、关联边、deepen/relate/branch、分支隔离、关闭与删除区分 |
| annotations | 语义/几何selector → 标注及版本binding | 笔迹、荧光笔、套索、撤销修订、重绑定、歧义状态；不处理DOM绘制 |
| retrieval | question/scope → EvidenceSet | 按章节/块切分、FTS召回、相邻/父章节补全、去重、证据预算、来源验证 |
| terms | 块文本 → 候选、原文定义、提及区间 | 中英候选、长词边界、原文定义优先；AI解释走同一conversation；密度策略归前端 |
| conversation | 明确发送的draft → node/messages/citations | 冻结路径上下文、只取祖先、附件与标注、能力校验、检索不足拒答、流式持久化 |
| providers | ProviderRequest → ProviderEvent | 协议注册、认证注入、流式/取消/超时、能力、错误脱敏，不知道文档UI |
| storage | repository ports → SQLite/资源IO | 外键、事务、revision、迁移、备份与恢复；唯一业务数据库入口 |
| jobs | 用例任务 → 进度/取消/结果 | 解析和索引worker、内存/解压限制、失败恢复；不得阻塞宿主事件循环 |

Core 的构造依赖为 `DataPaths / SecretStore / ResourceStore / WorkerPool / Clock / IdFactory / Logger` 等受控端口；生产实现由宿主注入，测试可使用临时目录和内存库。Core内部服务只依赖领域接口/仓储，不能循环import应用宿主。HTTP和IPC调用同一 application facade，每条写操作在Core内确定事务边界。

标注命中、DOM Range、滚动、画布、视觉tokens与栏宽仅属Web。文件选择、应用生命周期、OS数据目录、实例锁属宿主。二进制路径解析与模型凭据只在Node一侧。

## 2. 通道共同约定

- query/command只接收结构化、可序列化DTO；使用共享运行时schema逐项校验，TypeScript类型不能代替校验。新草案是类型，schema解析器在确认后实现。
- ID为不透明值，所有引用校验document/version/chat/asset归属。禁止任意文件路径、SQL、脚本、通用方法名或任意IPC channel。
- 成功返回data及revision/cursor；失败统一 `code / message / recoverable / fieldErrors / requestId`，不回传堆栈、上游认证头或凭据。
- 分页游标携带版本与稳定排序；旧版本/并发revision冲突明确返回，前端不能将过期响应覆盖当前文档。
- 写命令支持requestId/idempotencyKey，提交/分叉重试不生成重复节点。后台长任务返回jobId，再订阅事件；取消用requestId/jobId，不能依靠关闭面板假装取消。
- 流事件包含requestId、递增sequence、delta/complete/error/cancelled。未完成内容保留partial状态；回连按最终节点查询，不能将partial标成完整有依据回答。
- 文件流/Blob由平台adapter局部转换为上传或受控句柄，不进入通用JSON DTO；浏览器File对象不传入Core。

## 3. 平台完整能力清单

下表逐项列出vnext契约的全部方法。HTTP路径是待实现映射，不表示已经注册路由。IPC channel严格按 `decklens:<域>:<方法>` 逐项登记；例如 `documents.tree` 仅对应 `decklens:documents:tree`，不能向renderer暴露 `invoke(anyChannel)`。参数与返回值以vnext类型为准。

| PlatformAdapter方法 | 浏览器HTTP映射 | IPC方法后缀 |
| --- | --- | --- |
| documents.list / get | GET /api/documents；GET /api/documents/:id | documents:list / get |
| documents.tree / versions | GET /api/documents/:id/tree?versionId；GET /api/documents/:id/versions | documents:tree / versions |
| documents.reparse / remove | POST /api/documents/:id/reparse；DELETE /api/documents/:id | documents:reparse / remove |
| imports.begin / append / commit | POST /api/imports/uploads；PUT /api/imports/uploads/:id?offset（二进制）；POST /api/imports/commit | imports:begin / append / commit |
| imports.get / cancel / observe | GET /api/imports/:id；DELETE /api/imports/:id；GET /api/imports/:id/events（SSE） | imports:get / cancel / observe |
| sections.list / edit | GET /api/documents/:id/sections?versionId；POST /api/documents/:id/sections/edits | sections:list / edit |
| blocks.list / get | GET /api/documents/:id/blocks?versionId&sectionId&cursor；GET /api/blocks/:id | blocks:list / get |
| assets.metadata / content | GET /api/assets/:id/metadata；GET /api/assets/:id/content（二进制） | assets:metadata / content |
| terms.list / get / explain | GET /api/documents/:id/terms；GET /api/terms/:id；POST /api/terms/:id/explain | terms:list / get / explain |
| annotations.list / create | GET /api/documents/:id/annotations?versionId；POST /api/annotations | annotations:list / create |
| annotations.update / remove | PATCH /api/annotations/:id；DELETE /api/annotations/:id（带revision） | annotations:update / remove |
| annotations.bindings / confirmBinding | GET /api/documents/:id/annotation-bindings?versionId；POST /api/annotation-targets/:id/bindings/confirm | annotations:bindings / confirmBinding |
| explorations.graph / node | GET /api/documents/:id/chats/:chatId/graph；GET /api/nodes/:id | explorations:graph / node |
| explorations.create / ask | POST /api/nodes；POST /api/questions | explorations:create / ask |
| explorations.observeAnswer / cancelAnswer | GET /api/nodes/:id/events（SSE）；POST /api/nodes/:id/cancel | explorations:observeAnswer / cancelAnswer |
| explorations.rename / addReference / removeBranch | PATCH /api/nodes/:id/title；POST /api/reference-edges；DELETE /api/nodes/:id/branch | explorations:rename / addReference / removeBranch |
| chats.list / create / rename / remove | GET/POST /api/documents/:id/chats；PATCH/DELETE /api/chats/:id | chats:list / create / rename / remove |
| snapshots.get | GET /api/snapshots/:id | snapshots:get |
| providers.list / get / save / remove | GET /api/providers；GET /api/providers/:id；PUT /api/providers；DELETE /api/providers/:id | providers:list / get / save / remove |
| providers.test / secretStatus | POST /api/providers/:id/test；GET /api/providers/:id/credential-status | providers:test / secretStatus |
| providers.openSecretEditor / clearSecret | POST /api/providers/:id/credential-editor；DELETE /api/providers/:id/credential | providers:openSecretEditor / clearSecret |
| models.list / save / remove / test | GET /api/models?providerId；PUT /api/models；DELETE /api/models/:id；POST /api/models/:id/test | models:list / save / remove / test |
| drafts.list / save / remove | GET /api/chats/:id/drafts；PUT /api/drafts；DELETE /api/drafts/:id（带revision） | drafts:list / save / remove |
| drafts.attachments / removeAttachment | GET /api/drafts/:id/attachments；DELETE /api/drafts/:id/attachments/:attachmentId（带revision） | drafts:attachments / removeAttachment |
| viewState.get / save | GET/PUT /api/chats/:id/view-state/:viewId | viewState:get / save |
| settings.get / save | GET/PATCH /api/settings；只允许契约定义的三种公开设置 | settings:get / save |
| data.status / createExport / exportStatus | GET /api/data/status；POST /api/exports；GET /api/exports/:id | data:status / createExport / exportStatus |
| data.exportContent / removeExport | GET /api/exports/:id/content（二进制）；DELETE /api/exports/:id | data:exportContent / removeExport |
| data.planCleanup / cleanup / clearDocuments | POST /api/data/cleanup-plan；POST /api/data/cleanup；POST /api/data/clear-documents | data:planCleanup / cleanup / clearDocuments |

浏览器文件选择使用用户操作触发的File API，随后调用imports.begin/append/commit；adapter分块转发字节，Core只接收已登记的uploadId和受控暂存资源。Electron也走同一导入语义，由preload转发受大小限制的字节，不开放任意路径读取。append校验offset、配额、校验和与最大chunk大小，不能任意覆盖宿主文件。

`imports.begin` 的scope分为library和question；后者必须带draftId/revision。question作用域登记question_attachments，不把文件默默加入文档库，也不切换阅读主文档。相同文件可复用已有documents/版本记录，但显示为附件还是文档库条目由visibility与显式导入动作控制。来源读取必须另有该chat的source grant，不能因为知道documentId就跨文档检索。

正文术语点击调用explorations.create创建/恢复source卡并将selections放入草稿，不自动调用ask。deepen/relate/branch先更新drafts；明确提交后才执行explorations.ask。活动路径/面包屑从graph的tree边派生，检索与来源验证留在Core，不额外暴露任意retrieval/generate接口。两个observe返回相同AsyncIterable语义；IPC通过白名单订阅和取消句柄实现，不能使用任意topic。

术语原文定义使用不依赖会话的SourceRef，在未创建会话、未配置模型时仍可阅读。来源进入探索节点、消息或上下文快照时必须转换为ChatSourceRef，绑定当前chat、owner和有效source grant，不能用术语读取权限绕过会话证据授权。

settings仅开放 `ui.language`、`reader.preferences`、`ai.defaults.modelId`；默认模型只保存modelId，provider由外键派生，不维护两套默认值。snapshot公开读取移除私有宿主字段，保留实际来源与脱敏模型配置。

清空数据与清空凭据是独立操作，先显示影响范围，再显式确认；备份写入宿主管理的exports目录/OS保存对话框，前端不指定任意路径。普通阅读不要求确认弹窗。

## 4. 密钥与文件访问隔离

用户输入Key如果经过普通Web表单，渲染层就必然见到Key；密码框或HTTPS并不能满足「不进renderer」的约束。因此新版应用内设置页只管理公开配置及 `keyConfigured`。`providers.openSecretEditor(providerId)` 由宿主打开该供应商固定的本地凭据文件；用户通过系统编辑器写入，应用页不读取内容。无可用系统编辑器时，宿主给出固定文件的本机操作说明。后续若使用系统安全存储，也必须保持相同边界。

`credentials/<providerId>.json` 只含该profile凭据，限当前OS用户访问；Unix目录0700/文件0600，Windows由宿主设置当前用户ACL。仅由SecretStore读取到请求内存中，不在错误/日志/快照中记录；删除凭据时不保证SSD的物理安全擦除，但移除应用可用副本。API无凭据读回或通用配置读文件能力。

原文件、附件、图片只接受已登记的ID。宿主解析realpath，验证位于该记录允许的用户资源根内；拒绝 `..`、绝对路径注入、NTFS alternate data stream、符号链接越界、伪造MIME与未登记资源。选择文件的授权限定于选中文件，不开放整个目录。ZIP解析限制条目数/展开总量/压缩比并拒绝路径穿越。

文档内容视为不可信数据：Markdown/HTML清洗，禁脚本、事件属性、iframe及危险协议，SVG消毒或安全转位图；不自动加载外部图片。文档里的提示不是系统命令，不能改变检索和密钥策略。

浏览器服务：仅 `127.0.0.1`，绑定精确Host与端口；Origin须为当前应用同源，拒绝跨站请求与通配CORS；写操作同时验证会话、Fetch Metadata和CSRF令牌。首个入口由启动器创建一次性bootstrap token，经loopback页面交换为HttpOnly/SameSite会话后丢弃并清除URL，静态资源与SSE也纳入会话策略；token不进日志。未知Host/跨站/无会话不能创建任务、读取文档或打开凭据编辑器。没有Origin的读请求仍需合法会话。

Electron：contextIsolation=true、nodeIntegration=false、renderer sandbox；preload只暴露命名方法。主进程校验sender窗口/frame与DTO；资源协议仅解析已登记assetId，拒绝任意file路径。主进程/core请求模型，renderer不持有秘密。禁止为方便而运行一个不受限本机HTTP服务。

## 5. 用户数据路径

共同的 `DataPaths.resolve()` 提供唯一规则，Electron显式使用同一根目录而不是另建一套默认路径：

| OS | 默认用户数据根 |
| --- | --- |
| Windows | `%APPDATA%\DeckLens` |
| macOS | `~/Library/Application Support/DeckLens` |
| Linux | `$XDG_DATA_HOME/decklens`；未设置时 `~/.local/share/decklens` |

`DECKLENS_DATA_DIR` 只由启动环境读取，必须是源码目录之外的绝对路径。代码仓库/安装目录不可作为默认fallback；无法写入时报告错误，不偷偷在cwd建库。当前公开adapter不提供任意目录查询或文件打开方法；数据位置说明见README，维护接口只接实体ID。

```text
<userData>/
├─ db/decklens.sqlite           单一业务库，SQLite WAL文件也在此
├─ originals/<sha256前2位>/<sha256>.<ext>
├─ media/<documentId>/<sha256>.<ext>
├─ attachments/<attachmentId>/<sha256>.<ext>
├─ notes/<documentId>/<annotationId>/attachments/   区域裁剪等二进制；坐标在库中
├─ credentials/<providerId>.json           SecretStore专用，绝不备份到普通导出
├─ config/runtime.json                      宿主非敏感运行配置，不含Key
├─ cache/{pages,thumbnails,parse}/          可重建缓存，不作来源唯一副本
├─ exports/<exportId>/                      用户明确导出；不在仓库
├─ backups/<timestamp>/                    库+来源资源清单；默认排除credentials
├─ tmp/<jobId>/                            受控任务临时文件
├─ logs/                                  脱敏事件；默认不记全文/问题内容
└─ runtime/instance.lock                   目录级单写宿主锁
```

用户笔记正文以SQLite的annotations.body_markdown为唯一事实；笔记附件按上面的notes目录落盘，Markdown导出是派生文件，不建立第二份可写正文。资源写入采用暂存→原子rename→事务登记配合崩溃回收。数据库在线备份用SQLite备份API，随后复制清单中的来源资源并校验hash，不直接只复制活跃WAL库主文件。恢复先校验schema/checksum/文件清单，再切换目录；备份不包含凭据，恢复后单独配置模型。

## 6. 两种启动流程

| 步骤 | 本地浏览器 | Electron |
| --- | --- | --- |
| 1 | Node入口解析公开环境配置 | 主进程ready后读宿主配置 |
| 2 | 解析共同数据根、权限检查、取得目录锁 | 同一规则；Electron单实例锁+目录锁 |
| 3 | 创建资源/凭据目录，注入Core依赖 | 同一host-node依赖，注入Core |
| 4 | 校验schema版本/checksum，备份并事务迁移 | 调用同一迁移执行器，禁止另建桌面schema |
| 5 | 注册Core facade、后台worker、HTTP路由/会话 | 注册相同facade、worker、白名单IPC/资源协议 |
| 6 | 绑定127.0.0.1：首选4173，占用时OS分配空闲端口；失败明示 | 不绑定业务HTTP端口 |
| 7 | 打印/打开实际地址，认证后加载web/dist | 安全窗口加载同一web/dist，注入IPC adapter |
| 8 | 恢复文档/活动路径/草稿；关停取消任务、释放锁 | 同一恢复；退出时flush/关库/释放锁 |

开发模式Vite仅监听127.0.0.1，API代理到实际后端；5173冲突时明确报告或同步配置，不能悄悄代理到别的程序。生产浏览器版由本地宿主托管同一前端产物，减少CORS与端口配置。两个宿主同时选择同一数据根时，后启动者提示已有实例，不能各自写同一库。

解析worker共享Core解析代码与配置，不在HTTP/Electron各写一套；主宿主持有数据库写权限，worker产生版本结果/资源清单，由主宿主事务提交。进度按页/阶段上报，超时/取消回收暂存文件。图片懒加载、块分页/适当虚拟化，保留可定位锚点。

## 7. 本地 RAG 与层级上下文

首版本地检索采用SQLite FTS5与章节/块层级邻接补全，无需外部向量服务；中文分词/双语token规范版本化，检索不足明确提示，不把词面相似当可靠依据。后续向量索引通过retriever端口扩展，本版不强制下载embedding模型。

切块只能在语义边界拼接相邻内容，保留chunk→每个原block及文本区间映射；表格/图片caption可参与，视觉内容本身不冒充文字证据。按documentVersion/section范围检索，再取父章节标题和必要相邻块，去重、预算截断，并记录实际使用的证据快照。

每次发送冻结当前父链及节点修订，只继承祖先，不继承兄弟分支。`branch`从父路径创建新子路径，后续两条分支互不写入上下文。`relate`仍有唯一tree父边，可另外有reference边；reference边不自动继承上下文。快照记录provider/model/config revision和能力，但不含认证信息。

无相关证据直接返回「文档中未找到相关依据」，不调用模型生成伪来源。回答中的引用ID必须来自本次EvidenceSet，后端验证版本/块/quote后落库。开放知识补充只有用户明确请求时可生成，标「AI生成，仅供参考，无文档依据」，不能与原文事实混写。引用验证不保证模型每句话都正确，界面必须可查证据，拒绝声称系统能消除全部幻觉。

## 8. 参考依据（借鉴思路，不复制实现）

- https://github.com/docling-project/docling ：统一结构与来源；不因此引入强制Python或在线转换。
- https://github.com/Cinnamon/kotaemon ：证据引用和问答来源显示。
- https://github.com/mozilla/pdf.js ：PDF页面、文本层与阅读坐标。
- https://github.com/zotero/reader ：独立标注层和阅读主线。
- https://github.com/LibreChat-AI/LibreChat ：多供应商和对话分支。
- https://www.w3.org/TR/annotation-model/ ：语义selector与几何selector分离；JS UTF-16偏移与标准code point偏移要明确转换。
- https://www.sqlite.org/foreignkeys.html ：每连接启用外键、组合外键与完整性校验。

上述只用于架构参照，不导入其品牌、文案、图标、素材或未审核的代码。具体库选型、版本锁定、许可证与性能评估在对应接入阶段执行。
