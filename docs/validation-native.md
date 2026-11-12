# Native PDF/DOCX validation

验证日期：2026-11-12（America/New_York）。测试均在本机完成，原始文档没有上传到第三方服务。

## 真实样例

### PDF：TB1 77 页课件

样例标识：TB1/b4b6eb3fdf20cc6202ebcfb3946dd48d358887d6.pdf

解析结果：PDF 原生文本层，检测到原生大纲；964 个文本块、117 个图片块、2 个保守表格块。章节树前段如下：

~~~text
文档
├─ Default Section
│  └─ Slide 1: AI Foundations and Applications (EBU4213)
├─ part 2
│  ├─ Slide 2: Week 1
│  ├─ Slide 3: Recommended readings & references
│  └─ Slide 4: Aim & Outcome
└─ …（共 77 页）
~~~

每个内容块均有 sourceLocator.pageNumber；复杂版式被标记为“阅读顺序可能不准”。

第二份真实 PDF：TB1/8bf6106c12813b76af2ff6192ea441bf3a661155.pdf。该文件解析为 55 页、733 个文本块和 123 个图片块，同样检测到原生大纲。

~~~text
文档
├─ Default Section
│  └─ Slide 1: AI Foundations and Applications (EBU4213)
└─ part 3
   ├─ Slide 2: Week 1
   ├─ Slide 3: Aim & Outcome
   └─ …（共 55 页）
~~~

### DOCX：带标题层级与表格的讲稿

样例标识：Speaker3_Script_Annotated.docx

~~~text
文档
├─ 时间分配
├─ 讲稿正文
│  ├─ Slide 15 · Our Design, Phase 1: The Two-Sided Seat Card
│  ├─ Slide 16 · Phase 2: Removing the Dependence on Memory
│  └─ …
├─ 万一超时：按这个顺序删
└─ 预计问答：准备这五条
~~~

该文件解析出 10 个标题块、1 个表格块和 64 个正文块。该讲稿本身没有内嵌图片，因此图片顺序和资产落盘由本地生成的 OOXML fixture 覆盖。

第二份真实 DOCX：课程设计报告.docx（原文件名中的个人信息已略去）。解析出 22 个标题块、3 个表格块、272 个正文块和 1 个图片块；标题树从“一、功能需求说明”到“1) 地图识别模块（recognMap）”保留三级层级。Word 公式对象不计为图片。

~~~text
文档
├─ 一、功能需求说明
│  ├─ 1. 题目要求
│  └─ 2. 功能需求分析
│     ├─ 1) 地图识别与初始化功能
│     ├─ 2) 路径规划功能
│     ├─ 3) 安全评估与决策功能
│     └─ 4) 游戏状态管理功能
├─ 二、概要设计说明
│  ├─ 1. 功能结构设计
│  ├─ 2. 数据结构设计
│  ├─ 3. 算法设计
│  │  ├─ 1) BFS寻路算法（BFStoFood）
│  │  ├─ 2) Flood Fill安全评估算法（floodFillCount）
│  │  └─ 3) 最优方向决策算法（findBestMove）
│  ├─ 4. 状态机设计
│  └─ 5. 交互设计
└─ 三、系统实现与测试
   ├─ 1. 核心模块实现
   │  ├─ 1) 地图识别模块（recognMap）
   │  ├─ 2) 蛇移动模块（snakeGoGoGo）
   │  └─ 3) 地图打印模块（printMap）
   └─ 2. 功能测试
~~~

## 边界回归

- 生成的原生 PDF：文本层、页码定位、图片提取均通过；图片-only PDF 明确失败并返回 SCANNED_PDF。
- 生成的 DOCX：Heading 1、加粗行内运行、表格和 word/media 图片均通过统一文档模型；图片落盘后数据库只保存相对路径。
- 损坏 PDF/DOCX 返回 CORRUPT_PDF / CORRUPT_DOCX；密码保护 PDF 返回 ENCRYPTED_PDF。
- npm test：33 个 Core 测试、23 个集成与引用匹配测试全部通过（Node 报告包含父测试）。
- npm run typecheck、npm run build、npm run check:architecture（10 项）通过；未执行 Electron 打包。
- 两种格式的 HTTP 导入回归同时覆盖哈希去重、术语锚点、套索/画笔标注、离线探索笔记、来源定位、章节改名及重新解析。
- 历史引用通过相同文件哈希、sourceBlockKey、页码/幻灯片位置、类型及文本的唯一匹配回跳；文本变更、来源变更或歧义时拒绝匹配。标注仍保留在原解析版本。

## 后台大文件测试

测试入口：`tests/native.integration.test.ts`，使用本地生成的文件经 `/api/imports` 上传并轮询任务，独立解析子进程处理文件。下列耗时来自本机一次完整回归，仅作记录，不是性能承诺。

| 构造样例 | 本机耗时 | 验证内容 |
| --- | --- | --- |
| 101 页带大纲 PDF | 约 1.51 秒 | 每页来源、原生章节、39 次进度采样、解析中 health 接口可响应 |
| 约 27 MiB DOCX（3072×3072 BMP 内嵌媒体） | 约 0.74 秒 | 上传、解析、图片落盘与取回、标题/表格/编号/强调/备注 |

这里验证了后台任务与 HTTP 可用性；没有测量浏览器帧率、峰值内存或不同硬件下的延迟。

## 实际浏览器复核

通过本机 Web 服务与浏览器文件选择器导入 77 页真实 PDF 和课程设计报告 DOCX，使用隔离的临时数据目录，未配置模型。

- PDF 原生大纲显示 80 个节点（含根节点和空父章节）、1083 个内容块，目录可滚到第 20 页。
- 点击第 2 页术语建立本地探索笔记；重新解析后点击笔记的历史来源，阅读区仍定位到第 2 页，并提示正在展示当前版本的唯一匹配内容。
- 浏览器复核发现图片懒加载会挤移跳转目标，已在原生图片块中保留尺寸，并让统一渲染器预留空间；117 个 PDF 图片均带尺寸，修复后重测第 20 页和第 2 页跳转通过。
- 真实 DOCX 显示 22 个标题、3 张表格和 1 张图片。图片尺寸取自 OOXML，实际加载成功；实际 CSS 视口宽 375px 时，页面宽度为 375px，图片约 308px、容器约 340px，没有横向溢出。
- 本地生成扫描 PDF 经同一文件选择器导入后，界面显示“SCANNED_PDF: 这是扫描件，当前版本未启用 OCR”，没有新增空白文档。
- 本轮浏览器检查未发现 console error；关闭了验证页面和临时服务。

用户没有提供真实扫描 PDF；TB1 目录中的 3 份 PDF 均含原生文本层和大纲。因此扫描件拒绝路径使用本地生成的 image-only PDF fixture；图片 DOCX 的关系、顺序和落盘路径由本地 OOXML fixture 覆盖，真实课程设计报告则额外验证了 1 个图片块。

## 已知限制

- 当前没有 OCR。扫描件不会被伪装成原生解析成功。
- PDF 多栏、旋转文字、重叠对象和复杂表格可能需要人工调整阅读顺序；文档元数据会留下警告。
- DOCX 复杂版式、域、部分编号继承、SmartArt、矢量/TIFF 媒体和部分批注关系会降级或忽略。
- Word 公式对象不做公式重建；合并单元格保留元数据，阅读区按简化行列显示；表格内图片紧跟表格输出。
- 标注绑定解析版本，重新解析不自动迁移笔迹；无法唯一匹配的历史引用会提示，不能直接展示历史版全文。
- 大文件在独立 Node 子进程中解析，Web 轮询显示进度；阅读区尚未做虚拟列表专项优化。
