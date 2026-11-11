# DeckLens vnext 类型草案

本目录是等待确认的契约设计。`design.ts` 只有 `export type` / `export interface`，未接入 `../index.ts`、package exports、HTTP 路由、前端调用或 SQLite；不能通过它自动执行建库与迁移。现有业务仍有 `sourceOrder` 和类型检查等未闭合问题，本草案不代表这些功能已经可运行。

## 与统一模型及 SQL 的映射

DTO 与物理表不机械一对一：DTO 可聚合关联、计算数量和公开展示信息，持久化字段以 `database/design/schema-vnext.sql` 为准；repository 层必须显式转换，不能把公开 DTO 原样写入数据库。

| 统一类型 | SQL 与约束 |
| --- | --- |
| Block.sourceKey / plainText / displayOrder / sourceOrder | source_key / plain_text / display_order / source_order；sourceKey 与原文顺序在版本内唯一，显示顺序可变 |
| Block.type | heading、paragraph、list、table、image、formula、code、quote、note、divider、unsupported；脚注/尾注/批注统一 note.noteKind |
| Block.sourceKeyAliases | source_key_aliases 关联表聚合，不重复放入 blocks |
| DocumentTree.outlineRevision | 文档 section_edits 的 MAX(ordinal)+1 派生，空日志为0；sections.edit 带 revision 做事务内并发校验 |
| SourceLocator | 存 source_locator_json；nativePath 是文档内部原生位置，不能用于操作系统路径访问；SQL extraction_method 与契约一致，使用 native / text-layer / ocr，原生PDF文本层标记为 text-layer |
| Asset / BlockAsset | assets / block_assets；只有 image、attachment、preview。原文件路径只在后端 documents.original_relpath，不伪造 originalAssetId |
| ExploreNode.origin / status | content_origin / status；origin=document、ai、user、system、mixed，AI或混合来源必须含免责文字 |
| ExploreEdge | 唯一父关系来源；tree 允许 source/qa/deepen/relate/branch，reference 允许 related/supports/contradicts，判别联合禁止错误组合 |
| ContextSnapshot | 固定祖先、版本、消息、来源、模型能力和截断记录；文档版本通过来源关联及快照JSON冻结，不覆盖旧引用 |
| ExploreViewState | 固定三栏视图：collapsedCardIds、cardScrollOffsets、activeTab、panelState进入 panel_state_json；无级联浮卡状态 |
| SourceRef / ChatSourceRef | SourceRef 只保存 source_refs 的不可变来源，术语定义无需会话即可读取。ChatSourceRef 额外要求 ownerDocumentId、chatId、role、grantId，由 node/message/snapshot/draft 关联提供；sourceDocumentId 是实际来源文档 |
| ProviderProfile / ModelProfile | provider_profiles / model_profiles；供应商品牌、协议、认证分离，默认模型放 settings 的 ai.defaults.modelId |
| ModelExecutionSnapshot | model_snapshot_json 保存 configVersion、协议、实际模型/能力、actualParameters 和时间；不包含认证头或密钥，不依赖可变模型FK还原历史 |
| ExplorationDraft / QuestionAttachment | exploration_drafts / question_attachments；附件必须按 draft/chat/owner/grant 校验，不等于自动加入公开文档库 |

`ExploreNode` 不存父节点字段。每个非根节点最多一条有效入树边、同会话、无环；`derivedParentNodeId` 只用于返回 DTO。`CreateExploreInput.parentNodeId` 是创建请求，必须在事务内转换为边。关联边不会替换树父边或悄悄合并祖先上下文。

`SourceRef.sourceType` 区分原文和用户标注，用户笔记不能充当文档证据。原文术语定义通过同文档 definition_source_refs 读取，不伪造全局会话授权；进入会话时转换为强制授权的 ChatSourceRef。跨文档引用必须先有 chat_source_grants 授权；主文档为 primary，明确添加的问答附件为 attachment。新增来源不能仅靠客户端提交任意文档ID。类型品牌只帮助开发期隔离 ID，不能代替运行时归属、范围与权限校验。

## 标注与重解析

`TextSelector` 使用统一块 plainText 的 UTF-16 半开区间 `[startOffset,endOffset)`，同时保存 exactQuote、prefix、suffix 和块文本哈希。文本规范版本变化需要显式迁移。对外导出 W3C code point 选择器时必须转换，不能直接复用数值。

目标分为 text、block、region、document；几何使用 normalized-page、normalized-block 或 normalized-image。图片目标另记资源ID及原尺寸，不能把归一化坐标当作跨表面通用位置。页面、幻灯片及图片表面的具体含义随 sourceLocator 保存；页码不适用时不可捏造。

文字高亮按语义选择器重新计算显示位置。笔迹记录 layoutFingerprint 和可选快照资源；归一化不能抵抗换行、字体重排或旋转失配。绑定状态使用 exact、fuzzy、manual、orphaned、ambiguous、layout_stale；候选和原因保存在 mapping_json。fuzzy 只表示有候选，不能当作用户已确认的精确引用自动发送。歧义或布局失配保留旧目标并提示人工处理，不能静默命中第一处相同文字。`AnnotationBinding` 与不可变原目标分离，人工确认留下记录。

## 模型与敏感信息

`ProviderProfile`、`AIBackendContext`、`AIAdapter` 是后端内部契约，禁止渲染进程导入。真正的 Key 只由后端通过 opaque secretRef 读取固定本机凭据存储，不能进入 SQLite、快照、日志或任何公开 DTO。前端只使用 ProviderPublicDto 和配置状态；openSecretEditor 仅打开后端固定凭据编辑器，返回说明不得包含密钥、私有路径或任意文件访问能力。

providerKind 与 protocol 分开；authMode 为 bearer、x-api-key、none。配置类型中出现某协议只表示预留契约，不能等同适配器已实现；未知或未支持协议必须给明确错误。默认模型由 settings 的 ai.defaults.modelId 指定，避免 provider 与 settings 双重默认。

模型能力统一为 textInput、imageInput、streaming、tools、structuredOutput 五个键，每项 supported / unsupported / unknown；不得从模型名称猜测视觉能力。UI 只能声明能力，不能提交已验证探测状态。未确认支持图像时，只能在用户明确选择降级后使用已提取文字，不能静默漏图或声称已理解图片。`citation_candidate` 只是模型候选，core 必须校验本地检索允许集合和来源授权后，才可发公开 citation 事件。base URL 拒绝内嵌凭据、查询参数和片段，错误回显与诊断经过脱敏。

## Adapter 与验证边界

PlatformAdapter 使用明确方法域，没有通用 invoke、任意命令或任意文件访问逃生口。浏览器 HTTP 和未来白名单 IPC 检查文档/版本/会话归属、ID、范围、文本长度和数据大小；导入通过分块票据传字节，不接受源文件路径。异步迭代事件只定义统一语义，本轮不实现 SSE、IPC 或流式业务。

settings.get/save 仅支持 ui.language、reader.preferences、ai.defaults.modelId 三个精确键。保存时仍需运行时严格拒绝未知键、私有路径或任何凭据；默认模型设为 null 表示清除。revision、requestId 与幂等校验在 core/通道封套中统一处理，不能依赖 TypeScript 静态校验。

imports.begin 必须显式指定 library 或 question 范围；question 范围带 draftId/revision。添加文件先产生草稿附件，解析、失败和就绪状态可查；只有明确发送才冻结快照、生成问答节点。drafts.attachments/removeAttachment 只管理受控关联，不读取任意路径；删除草稿不应删除已经进入历史快照的来源版本。

上下文快照只允许 UI 读取，不允许伪造或覆盖。导出通过短期 exportJobId 获取归档字节，导出文件不假装成文档内 assets；设置仅包含公开数据，固定排除密钥。清理使用短期计划 ID，不接受路径；clearDocuments 仅清文档、标注、探索等用户内容，供应商与密钥清除保留独立入口。备份恢复和数据库迁移执行暂不暴露 UI。

确认后验证：Block判别分支、全文稳定排序、树边唯一性与防环、重复原文锚点迁移、emoji偏移、标注布局失配、跨会话状态拒绝、历史引用与附件授权、未知模型能力降级、公开DTO无密钥或私有路径。本轮只独立检查此类型草案；不接现有库、不声称完整业务验收已通过。
