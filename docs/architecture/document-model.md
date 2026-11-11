# 文档原始顺序、版本和来源必须可追溯

状态：架构草案。完整可检查类型见 `packages/contracts/src/vnext/design.ts`；物理字段、约束与索引见 `database/design/schema-vnext.sql`。这里解释字段语义与格式能力边界；字段使用 camelCase，SQLite 映射为 snake_case。

## 1. ID、时间和版本约定

- 普通实体 ID 为宿主生成的不透明字符串；客户端不能用文件名构造 ID。时间为 UTC ISO 8601；SQL 统一存 TEXT，不混用秒和毫秒。
- 文件去重基于原始字节 SHA-256；文件名、扩展名和 MIME 不能决定身份。OOXML 通过 ZIP 包内标志区分 PPTX/DOCX；TXT/Markdown 没有唯一魔数，按文本解码、扩展名提示和内容规则判别，歧义允许明确选择，不能假称仅靠签名可区分。
- `Document` 是库中逻辑文档；`DocumentVersion` 是不可变解析结果。重解析新建版本，成功校验后才切换 activeVersionId。失败保留旧可读版本，不先清空旧块。
- `sourceKey` 由格式原生位置构成；`blockId = hash(versionId + sourceKey)`，同版本重试稳定，不依赖数据库行插入序号。`sourceKeyAliases` 保存已确认的来源键别名；跨版本仅尽力映射，不能承诺解析器变化后 ID 永不变。
- `sourceOrder` 是解析版本内全局原文顺序；`displayOrder` 是可变显示顺序。手动目录调整只改视图结构与显示序，不覆盖原始顺序。

## 2. 顶层实体

| 实体 | 字段与约定 |
| --- | --- |
| Document | id、title、originalName、format、mimeType、sourceHash、sizeBytes、activeVersionId、status、language、createdAt、updatedAt；公开DTO无原件路径；库内另有visibility区分library/attachment |
| DocumentVersion | id、documentId、versionNumber、sourceHash、parserId、parserVersion、modelSchemaVersion、parserOptions、status、extraction、pageCount、blockCount、sectionCount、warnings、createdAt、completedAt；options不含密钥 |
| Section | id、documentId、documentVersionId、parentSectionId、title、depth、sourceOrder、displayOrder、sourceKey、origin=parser/manual、sourceLocator、createdAt、updatedAt；根/章节/小节使用同一树，根parent为空 |
| Block | 见下节；只属于一个版本与一个显示章节 |
| Asset | id、documentId、kind=image/attachment/preview、sha256、mimeType、sizeBytes、width、height、createdAt；文档级资源，二进制不进DB；宿主库内另存relative_path |
| BlockAsset | documentId、documentVersionId、blockId、assetId、role、ordinal、placement、originalPartPath、altText；同资源可多次展示，每个原位置为独立引用 |
| SectionEdit | 库内edit_id、document_id、base_version_id、operation、source_keys_json、payload_json、state、ordinal、created_at、updated_at；保留操作历史支持重解析回放 |

外键以实际 SQL 为准。公开 DTO 不返回 `original_relpath`、`relative_path` 或绝对路径，图片用 assetId 取得受控字节再由前端管理Blob URL。树节点与块分页查询，不要求一次把百页图片解码进DOM。

仓储负责显式映射：Document.sourceHash 对应 documents.original_sha256，format对应detected_format，版本ID对应version_id。DocumentVersion的parserOptions、pageCount、blockCount、sectionCount放在版本化metadata_json，warnings对应diagnostics_json。Section的depth/origin直接映射；DocumentTree.outlineRevision由该文档section_edits的 `coalesce(max(ordinal),-1)+1` 派生，目录修改提交revision并在事务内比较。资源版本归属只存在block_assets，不在Asset重复保存。

## 3. 所有内容块共有字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 版本内确定性来源ID；前端key用此值 |
| sourceKeyAliases | string[] | 已确认来源键别名；对应source_key_aliases，不自动把歧义映射当身份 |
| documentId / documentVersionId | string | 所属文档与不可变解析版本 |
| sectionId | string | 显示章节；移动不改变原来源 |
| parentBlockId | string/null | 复合结构的父块；普通列表项/表格单元优先内嵌，不重复成为顶层块 |
| type | BlockType | heading / paragraph / list / table / image / formula / code / quote / note / divider / unsupported |
| sourceKey | string | OOXML节点路径、PDF页内序号、Markdown AST位置等 |
| sourceOrder | integer >=0 | 全局原始读序，版本内不重复 |
| displayOrder | integer >=0 | 当前章节内显示序；用户调整后可变 |
| plainText | string | 原文规范化纯文本；术语偏移/检索唯一文本基准，不含UI标签 |
| payload | discriminated object | 下表各类型结构，不存任意未清洗HTML |
| sourceLocator | SourceLocator | 定位原文件、原位置与精确原文 |
| language | string/null | 原始语种，未知为空，不擅自翻译 |
| extraction | object | method=native/text-layer/ocr、confidence可空、warnings[]、isApproximate |
| contentHash | SHA-256 | 规范内容摘要，用于校验；不能单靠此值跨位置去重 |

Block不单独暴露创建时间；解析时间来自DocumentVersion，手动归属调整记入SectionEdit。extraction的confidence、warnings、isApproximate由sourceLocator及版本化payload/provenance JSON映射，不另建与其冲突的状态；Core验证完整JSON schema，SQL只约束容器与关键列。

### 各类型 payload

| type | 必需/可选内容 |
| --- | --- |
| heading | level 1–6、runs、plainText；PPT标题层级只使用可靠占位符/大纲线索，不根据字体大小臆造语义 |
| paragraph | runs[]，run含text、emphasis/strong/strike、href可空、inlineMath可空；可选indent/alignment |
| list | ordered、start、items[]；item含id、level、runs、children[]、checked可空；一份列表只渲染一遍 |
| table | rows为二维TableCell数组；cell含row/column、rowSpan/columnSpan、header、runs；headerRows、caption可空；不能识别的结构有warning |
| image | assetId、alt可空、caption可空、intrinsicWidth/Height、crop/rotation可空；保留图片与所属页/段落关系 |
| formula | raw、representation=latex/mathml/omml/text、display、fallbackAssetId可空；原格式不能可靠转换时保留原表达或图片并标记 |
| code | code、language可空、fenceInfo可空；禁止执行文档代码 |
| quote | runs、attribution可空；内容不能再作为重复顶层段落 |
| note | noteKind=speaker-note/footnote/endnote/comment/general、runs、author可空、referenceBlockId可空；备注不混入正文重复输出 |
| divider | 无正文，可选原生标记 |
| unsupported | nativeType、reason、fallbackAssetId可空、rawText可空；明确能力损失，不能静默丢内容 |

`plainText` 与 payload 文本按规范化算法一致：Unicode NFC、换行统一LF，保留有语义的段落/列表换行。偏移为 UTF-16 半开区间 `[start,end)`，与JS DOM对齐；不能再对用于偏移的字符串进行不可逆去空格、翻译或拼接。

## 4. SourceLocator：不要伪造页码

| 字段 | 说明 |
| --- | --- |
| format、documentId、documentVersionId、sourceHash | 来源文件、解析版本与完整性身份 |
| blockId、sourceKey | 统一块与原生路径身份 |
| pageNumber / slideNumber | 人类1起始编号；不适用/不可获得为null |
| sectionPath | 原文标题路径；用户重命名不修改历史来源快照 |
| lineStart / lineEnd、charStart / charEnd | Markdown/TXT的原文件行号/字符范围；不适用为null |
| nativePath | OOXML part + 元素定位；PDF页+对象/文本范围等 |
| excerpt | 精确原文片段，不是AI改写 |
| boundingBoxes | 可选；页面/图片坐标归一化并注明target、坐标系和页面尺寸 |
| extractionMethod、isApproximate | native / text-layer / ocr，OCR或不确定读序必须标记 |

DOCX不是固定分页格式，不保证拿到与Word排版一致的页码；用标题路径、段落/表格与OOXML位置溯源。Markdown/TXT用章节与行号。PDF阅读顺序、标题/表格推断和扫描页判定是启发式，必须保留警告和原始页位置。

引用记录另外保存 `exactQuote / prefix / suffix / offsetStart / offsetEnd / sourceLocator`，绑定版本。重解析产生新的映射，不静默修改旧回答的证据。版本暂不可用时明确说明，不把相似文本冒充原位置。

## 5. 图文不能只剩文字

原始文件存 `originals/<sha256前2位>/<sha256>.<ext>`；提取资源存 `media/<documentId>/<sha256>.<safeExt>`，所属版本/块通过block_assets关联。文件名不直接使用用户路径，图片DB只存相对路径和元数据。资源读取校验归属、路径边界、符号链接及MIME，拒绝SVG脚本与外链主动加载。

PPTX图片通过slide relationships绑定对应幻灯片/shape；DOCX按内联drawing锚点/段落绑定；PDF尽力提取原生图像并保持页面关联，不承诺将每个矢量组合正确还原为独立示意图。Markdown相对图片仅在用户明确提供的目录/资源包范围内导入，远程URL默认不下载；缺图显示具体原因。TXT不凭空造图。

文本模型可以引用已有图片及图注，但必须标注「未进行图像理解」。发送图片到支持视觉的外部模型前，必须由明确提交动作触发，并显示本次上下文中有哪些文件/区域。图片的提取、查看和圈选无需网络。

## 6. 防止重复、乱序与重解析丢数据

1. parser只输出一个标准块序列；块内列表、单元格和备注不再额外push为相同顶层段落。
2. `(versionId, sourceKey)` 和 `(versionId, sourceOrder)` 唯一。重复同来源输出视为解析错误/可报告去重；不同页同文本保留两个原位置，不能按纯文本全局去重。
3. 单事务写入一个完整版本；导入重试用task/idempotencyKey，不循环追加。资源先暂存、校验后登记，失败任务孤立资源后续回收。
4. 查询先分页取blocks，再批取assets/terms，避免一对多JOIN放大块数量。前端仅按blockId渲染一次，遵循section/displayOrder、sourceOrder与ID稳定兜底排序。
5. 重解析先建立新树，依据sourceKey/原文hash/相邻位置匹配手动操作；歧义产生待复核项。旧版本和绑定历史不会先删除。
6. 章节编辑使用乐观revision、单事务防环、拆分/合并日志。用户删除文档前展示将影响的版本/探索/标注，确认后才清理文件；仅关闭卡片不能删除节点。

## 7. 格式优先级与第一版边界

| 顺序 | 第一版规划 | 暂不承诺 |
| --- | --- | --- |
| P0 Markdown、TXT | AST/原文结构、标题、段落、列表、代码/表格（MD）、原行号、明确编码错误 | 自动翻译、远程图片抓取、把任意文本猜为Markdown标题 |
| P0 PPTX | OOXML slide关系顺序、标题、列表、备注、表格、内嵌图片及页归属 | 动画、音视频播放、宏、SmartArt/图表完全语义还原、像素级版式复刻 |
| P1 DOCX | 标题样式、正文、列表、表格、内嵌图片；尽力脚注/批注；章节位置溯源 | 与Word完全一致分页、复杂浮动排版、修订合并/宏执行 |
| P1 PDF | 本地文本层、页信息、原生图片；标题/表格/读序有置信提示；识别扫描或混合页 | 复杂表格无误恢复、全部矢量图结构、加密文件自动破解 |
| 后续可选 | 扫描/混合页OCR，显示「识别内容可能存在误差」并保留页图 | OCR作为原生格式主解析、未经确认上传第三方转换 |

完整浏览器第一版目标覆盖上述五种格式，但按P0/P1依次接入。本轮未新增任何解析器。损坏、加密、不支持、解压资源超限、缺少图片、解析取消等使用明确错误码及可读消息，不能显示空白后假称成功。

统一模型保留原始语言及将来translationOf/blockAlignment扩展位置；本版不实现翻译/对照视图或个人费曼总结。
