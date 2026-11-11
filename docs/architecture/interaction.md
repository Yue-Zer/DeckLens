# DeckLens：原文主线与固定层级探索

状态：设计初始化，等待确认后按阶段整合。本文描述目标交互和职责边界，不代表功能已实现或验收通过。现有浮卡草稿留待下一阶段清理与整合，本轮不修改 Vue、CSS、业务代码或数据库。

## 1. 固定三栏保持原文主线

桌面工作区采用「文档目录 / 原文阅读 / 层级探索」三栏。阅读区承载原始材料，右侧承载原文定义、检索证据与 AI 探索节点。右侧卡片固定在探索栏内，不根据术语屏幕坐标生成悬浮窗，不遮挡中央原文。

- 左栏：文档库、导入入口、可折叠章节树与章节调整入口，可收起并重新打开。
- 中栏：居中的白色阅读面、结构化内容块、术语锚点、标注层、引用定位及全文提问入口。
- 右栏：探索会话、面包屑、活动节点与父子路径、可收起探索树、固定在栏底的 composer。
- 原文和探索栏分别滚动。活动章节、阅读位置、活动节点、展开分支与未发送草稿按文档和会话隔离。
- 点击术语保持正文位置，在右栏创建或恢复持久化节点；不会自动调用付费模型。深挖、关联、分叉先形成待发送上下文，用户明确发送后才发起模型请求。
- 点击父卡内术语，在右栏建立可追溯子节点，保留父卡和路径。点击面包屑祖先可以回退，已有后代保留在树中。
- 点击引用才主动定位中央原文，并给予短暂聚焦反馈。点击正文其它位置不会清空探索。

原文定义使用「文档原文定义」标签；AI 内容使用「AI 生成，仅供参考」标签；检索不足使用明确的「文档中未找到相关依据」。来源判断依赖节点 origin，不以是否配置模型推断。

## 2. 粉白视觉 tokens

用户指定的粉白阅读风格优先。只借鉴清爽阅读气质，不使用第三方品牌、Logo、人物或素材。颜色和尺寸先定义为语义 tokens，组件不写裸色值。

| token | 设计值 | 用途 |
| --- | --- | --- |
| color.accent | `#FB7299` | 主操作、活动路径、术语提示 |
| color.accentHover | `#E85A85` | 主操作 hover |
| color.accentText | `#D64D77` | 白底粉色文字 |
| color.info | `#00A1D6` | 引用定位、关联关系 |
| color.background | `#F6F7F8` | 工作区底色 |
| color.surface | `#FFFFFF` | 阅读面、侧栏与卡片 |
| color.rule | `#E3E5E7` | 结构分隔 |
| color.ink | `#18191C` | 标题、主要内容 |
| color.secondary | `#61666D` | 次级文字 |
| color.hint | `#9499A0` | 非关键信息；必要说明须提高对比度 |
| color.aiSurface | `#FFF0F4` | AI 来源标签 |
| color.sourceSurface | `#F1F2F3` | 原文来源标签 |
| radius.card / button | `8px` | 卡片、按钮 |
| radius.tag / image | `4px` / `6px` | 标签、图片 |
| shadow.card | `0 2px 8px rgba(0,0,0,0.06)` | 仅需要浮起层级的卡片 |
| motion.duration | `120–200ms` | 位移、透明度、阴影；ease-out |

正文系统字体优先 PingFang SC、HarmonyOS Sans、system-ui；14–15px、行高约 1.7，章节标题 20–24px。间距从 `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96` 选取。正文与标题左对齐，层级先用字号、字重和明度表达，避免容器连续套边框、底色与阴影。

术语锚点采用加深粉色文字和虚线下划线；活动词加浅粉底。长词优先匹配，中英文按词边界控制；同屏高亮有密度上限，超出项降级为 hover 提示，键盘仍可访问。所有可点击项保留 focus-visible 粉色描边；支持 reduced-motion。

## 3. 组件树与状态所有权

```text
AppShell
├─ TopNavigation
└─ WorkspaceLayout
   ├─ DocumentSidebar
   │  ├─ DocumentLibrary / ImportProgress
   │  └─ OutlineTree / SectionEditor
   ├─ ReaderWorkspace
   │  ├─ ReaderToolbar
   │  ├─ ReaderPaper
   │  │  └─ BlockRenderer
   │  │     ├─ AnnotatedText / SourceMarker
   │  │     └─ AnnotationLayer
   │  ├─ SelectionContextEntry
   │  └─ GlobalQuestionEntry
   └─ ExplorationPanel
      ├─ SessionSwitcher
      ├─ ExplorationBreadcrumbs
      ├─ HierarchicalNodeStack
      │  └─ ExplorationNodeCard
      │     ├─ NodeOrigin / AnnotatedAnswer
      │     ├─ CitationList
      │     └─ NodeActions
      ├─ ExplorationTree
      └─ ExplorationComposer
         ├─ DraftContextChips
         ├─ MessageEditor
         └─ AddContextMenu
```

`WorkspaceLayout` 只处理栏宽、折叠和断点。`BlockRenderer` 只读统一文档模型，每个块只渲染一次；章节和章节内块都按持久化 displayOrder 展示，以 sourceOrder 和 ID 稳定消歧。初次解析时 displayOrder 继承 sourceOrder；手动调整只改变显示序，原始来源序不改。去重使用块 ID 或明确来源身份，不能按纯文本删除不同原位置的重复内容。

`AnnotatedText` 共用于正文和卡片，负责文本分段、术语匹配及事件，不直接访问数据库或 AI。`AnnotationLayer` 单独承载视觉标注与命中，不替换或改写原文。业务编排层负责将事件转换为 adapter 命令，维护文档/会话/请求序号校验，防止旧响应覆盖新选择。

右栏以活动路径组织卡片。父卡可折叠为标题摘要，当前卡展示完整内容；关系类型、面包屑和树共同表达层级，不能把全部回答累积成无限聊天流。树总览可收起，不改变节点数据。

## 4. 层级探索统一动作

后续领域动作统一使用 `deepen | relate | branch`，文本问答是节点内容类型，不再引入第二套关系枚举。

| 动作 | 父子与关联含义 | 上下文继承 |
| --- | --- | --- |
| deepen | 针对当前概念进一步解释，形成子节点 | 当前节点、祖先路径摘要、原文锚点与可检索证据 |
| relate | 从当前概念探索横向关联；既保留探索父节点，也记录语义关联边 | 当前概念与原文范围，回答仍须说明引用依据 |
| branch | 从当前节点创建独立探索分支，原分支保持可访问 | 创建时冻结的父路径上下文；后续两个分支互不覆盖 |

持久化父子关系只存于 `explore_edges.edge_role = 'tree'` 的边；DTO 对应 `role: 'tree'`，具体动作放 relation（SQL relation_kind）。不在 `explore_nodes` 重复保存父节点列。对 tree 边的 to_node_id 设置部分唯一约束，保证每个节点最多只有一个探索父节点；一般环、根节点无入边、非根恰有一个父节点由后续 Core 事务校验。创建请求使用 parentNodeId，返回 DTO 使用 derivedParentNodeId，均非节点表字段。语义关联使用 role 为 reference 的边，可跨分支，不参与面包屑父路径计算。每个会话有一个系统 root；原文 source 节点挂在该 root 下，作为用户可见路径的起点并保留 document/version/block/quote。

当前草稿使用 `deepens / related / branch`；下一阶段在 adapter 边界兼容读取，并通过受控迁移统一保存为新枚举。本轮不改现有 contracts 的 runtime 出口、不迁移现有数据；新增 vnext 纯类型草案用于描述目标契约，不改变现有运行行为。现有 `floatingCards` 视图字段也留待迁移为固定面板状态，不将旧字段作为新浮卡能力继续扩展。

每次明确发送时冻结 context snapshot：父节点、祖先节点版本、来源引用、提问、动作、附件与标注引用、检索范围、provider/model 和能力说明。保存实际使用的证据与节点 origin；模型未配置或失败不能抹去原文和既有路径。

## 5. 独立标注层：语义定位与视觉位置分离

### 5.1 语义锚点是来源身份

文本标注和划选上下文至少保存：

| 字段 | 含义 |
| --- | --- |
| annotationId | 标注自身 ID，与节点、附件独立 |
| documentId / documentVersionId | 文档与不可变解析版本 |
| blockId / sourceBlockKey | 当前块定位及重新解析匹配线索 |
| startOffset / endOffset | 规范化 block.plainText 内 UTF-16 半开区间 |
| exactQuote | 该区间原文，提交时再次校验 |
| prefix / suffix | 区间邻接短文本，用于重排或重新解析后校验 |
| sourceLocator | 格式、页码/幻灯片号、章节路径等人类可读来源 |
| kind / note | 划线、区域、笔迹或评论，以及用户说明 |
| createdAt / updatedAt | 创建与修改时间 |

偏移基于统一模型的原文文本，不包含来源标签、按钮文案或 UI 自动换行。跨块选择应拆为多个有序片段，不用一个模糊范围覆盖多个块。重新解析时只有来源身份与原文校验满足条件才自动重绑；冲突明确标记待确认并保留旧版本来源。

### 5.2 坐标只服务绘制

- 文本标注优先从语义锚点重建 DOM Range，每次滚动、缩放、字体或宽度变化后重新取得 client rects。
- 屏幕 `clientX/clientY`、滚动位置、devicePixelRatio 属于瞬时绘制信息，不作为语义锚点入库。
- 图片区域使用资源 ID、所属块和原图方向规范化后的 `[0,1]` 坐标；自由笔迹保存同一坐标系的点序列，另存画笔属性。
- 规范化坐标要记录目标图像宽高与坐标版本；变换只作用于显示，不累积回写造成漂移。
- 标注层对原文默认 `pointer-events: none`，只有启用注释笔或明确命中标注控件时接收指针；保留文本选择、链接与键盘阅读。
- 显示几何和命中测试放前端；标注内容、文件引用、来源版本与上下文快照通过 adapter 交给 core 保存。

### 5.3 标注状态与事件

状态流：`idle → armed → drawing/selecting → draft → saved`；取消回到 idle，保存失败保留 draft 并显示原因。编辑、删除、撤销只影响标注，不改原文。保存标注不会自动发送问答。

| 事件 | 关键载荷 | 接收后的动作 |
| --- | --- | --- |
| term.activate | termId、语义锚点、可选 contextNodeId | 创建/恢复节点，右栏联动，不调用模型 |
| selection.context | 一个或多个语义锚点 | 加入 composer 待发送上下文 |
| annotation.start / change / commit / cancel | 标注 ID、语义锚点、视觉片段、用户说明 | 更新草稿或持久化标注，不发消息 |
| annotation.context | annotationId 与版本 | 加入待发送上下文，不发消息 |
| node.action | parentNodeId、deepen/relate/branch | 更新 composer 动作与父上下文 |
| composer.submit | 草稿版本、问题、动作、附件/标注引用 | 校验能力，冻结快照后才提交问答 |
| citation.navigate | documentVersionId、blockId、offsets、quote | 跳转并验证原文，旧版本走历史来源视图 |

原文点击产生的 DOM 元素或 rect 不能进入 core。API 参数只传语义 ID、文本范围与必要的规范化视觉数据。

## 6. 右侧 composer：先整理上下文，再发送

composer 固定在右侧探索栏底部，与活动节点明确关联。输入区左下角使用「+」按钮，打开可键盘操作的菜单，包含「添加文件」和「注释笔」。不以 Emoji 代替图标。

- 添加文件：通过平台受控文件选择/上传取得附件句柄，显示文件名、类型、解析状态和移除操作。添加动作只改变草稿上下文，不生成消息、不调用模型。若文件需要转为独立文档，应作为明确的导入动作处理，不能偷偷写入文档库。
- 注释笔：开启中栏独立标注层；完成标注后，显示在 composer 的上下文条目中。每项可预览原文、补充文字、移除或定位。
- 上下文条目同时展示所选原文、附件和标注；父节点、动作和文档范围清楚可见。切换父节点不偷偷发送或丢弃草稿。
- 深挖/关联/分叉选择动作与父上下文，可填入可编辑的提问建议；只有点击发送或明确的提交快捷键才创建问答请求。
- 提交前校验空问题、解析中附件、失效锚点和模型能力；提交中显示状态，错误后保留问题与上下文，允许重试。附件和标注的存储引用留在快照中，可追溯实际发送内容。
- 未配置模型时，原文阅读、原文术语定义和标注仍可使用；发送入口明确提示配置缺失。文档检索无依据时不让模型编造来源。

模型能力由 provider 返回能力声明；自定义兼容服务未知时按无视觉支持处理。当前选择的模型没有视觉能力而草稿含图片/笔迹时，composer 明确显示「当前模型不支持图片或笔迹，尚未发送」。用户可以换支持的模型，或主动选择「仅使用可检索文字与我的文字说明」；不能静默丢弃图片、把笔迹等同于已识别文字，或假称模型已理解图像。OCR 如后续启用，应作为可选流程，并标记识别误差。

前端永不直接请求模型；只提交附件 ID、标注 ID 与语义上下文。实际文件读取、允许的内容类型、provider 适配和密钥读取均在本地后端/core。附件超过大小或格式限制必须显示具体原因。

## 7. 响应式不挤压正文

以下为验收基准，栏宽通过 tokens 与最小内容宽度共同计算，不给整个应用设置固定宽度。

| 视口 | 左栏 | 中央阅读 | 右侧探索 |
| --- | --- | --- | --- |
| 1920px | 240px，可折叠 | 占剩余空间，阅读面居中且正文最大约780px | 360px，独立滚动，底部 composer |
| 1440px | 240px，可折叠 | 弹性宽度，阅读面内边距24–32px | 320px，父卡摘要与当前卡分层 |
| 1280px | 200–220px，可折叠为48px轨道 | 保证舒适行宽；用户可主动收起目录 | 320px，不覆盖原文；必要时压缩次要工具文字 |
| 375px | 目录抽屉 | 阅读/探索页签；阅读页占满内容宽度，16px内边距 | 探索页占满宽度，一次展示活动卡及面包屑，底部 composer |

窄屏保持逻辑三栏和同一份文档/探索状态，通过「阅读 / 探索」页签切换可见主区。点击正文术语后切到探索页；「返回原文」恢复原文块与滚动位置。点击引用切回阅读页并定位。目录抽屉关闭后，其离屏元素不可继续获得 Tab 焦点。

在中间宽度，如果中央最小阅读宽度与侧栏无法同时满足，优先收起目录；仍不足则采用同一页签方案。不能出现横向溢出、卡片重叠、正文贴边或一行仅容纳几个字。

## 8. 持久化与下一阶段边界

core 保存文档版本、章节、块、术语、探索节点/关系、消息、来源引用、标注和上下文快照。图片/附件放用户数据目录，数据库保存受控相对路径；不把文件内容转 base64 存入数据库。密钥只在本机后端配置文件。

固定面板视图状态建议包括 activeNodeId、activeBlockId、expandedNodeIds、collapsedCardIds、cardScrollOffsets 和窄屏 activeTab；前端布局坐标不持久化。草稿按 documentId/chatId/parentNodeId 隔离，保存附件/标注 ID 和文字；附件实体与草稿删除的生命周期由 core 管理，避免失效路径。迁移字段和恢复优先级在下一阶段与统一 contracts 一起落地。

本轮只设计并初始化文档。下一阶段先移除未整合浮卡入口、恢复可构建的固定三栏，再实现统一动作、标注层和 composer。保留已有解析、存储与竞态防护，不以重做 UI 为由拆成独立工程。

后续可验证标准：四种基准宽度无溢出；术语点击不自动发模型请求；父卡术语产生可回溯子节点；添加附件/标注不产生消息；无视觉模型有明确能力提示；刷新恢复活动路径和阅读位置；引用跳回对应版本与内容块；键盘可完成目录、卡片和 composer 操作。本文不声明这些检查已通过。
