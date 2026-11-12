# Changelog

## Unreleased

- Moved the document question composer to the bottom of the right exploration panel, including its narrow-screen drawer. Removed the disabled placeholder from the reading area.
- Connected document questions to the existing exploration API with loading feedback, model setup, source citations, and retryable errors that preserve the question.

## v0.2.0 - 2026-11-12

Native PDF and DOCX parsing for the local Web reader.

### Included

- PDF text-layer parsing through pdfjs-dist, including page locators, native outlines, automatic heading inference, conservative tables, embedded images, multi-column warnings, encrypted-file errors, and explicit scan-only refusal without OCR.
- DOCX OOXML parsing through local JSZip and XML readers, including Heading styles, paragraphs, lists, tables, basic run emphasis, embedded media, and best-effort notes.
- PDF/DOCX imports reuse SHA-256 deduplication, the background worker, progress polling, versioned reparse, section edits, source citations, terms, annotations, and exploration.
- Extracted images are stored under the local data directory; the database stores asset paths and metadata.
- Native image dimensions reserve reader space before lazy loading, keeping page and citation jumps stable. Historical citations resolve to unchanged current-version blocks only when their immutable source and content match uniquely.
- Native parser regression fixtures and a local validation script.

### Known limitations

- No OCR. PDFs with an empty or extremely sparse text layer are rejected as scans.
- PDF multi-column, rotated, overlapping and complex table layouts can still produce an order warning or text fallback.
- DOCX complex layout, field codes, some numbering inheritance, SmartArt, vector/TIFF media and some note relationships are simplified or ignored.
- Annotations remain bound to their original parse version; automatic migration of drawn marks is not implemented. Very long readers are not virtualized, and browser frame-rate/memory limits have not been benchmarked.
- The supplied TB1 PDFs all contain native text and outlines; no real scan PDF was available, so scan rejection uses a local image-only fixture. The supplied lecture DOCX has no images, while the local course-report DOCX yields one embedded image; OOXML fixtures cover image relationship edge cases.

## v0.1.0 - 2026-11-11

First local browser release scope.

### Included

- Vue 3 + Vite three-column reader with document library, collapsible outline, structured reading area, and right-side exploration panel.
- Local import and parsing for Markdown, TXT, and PPTX; SHA-256 duplicate detection, reparse versions, source locators, and persisted section edits.
- Local SQLite storage for documents, extracted assets, annotations, model profiles, chats, exploration nodes, and citations.
- Term anchors and hierarchical exploration actions for deepening, related concepts, branching, and follow-up questions. Retrieved citations link back to source blocks.
- Pointer, pen, highlighter, eraser, and lasso annotation tools. Annotation targets are stored in normalized coordinates; lasso selections can start an exploration request.
- Model profile management and connection testing for OpenAI-compatible chat APIs, including DeepSeek through its compatible protocol, and local Ollama.
- Local Node service bound to loopback with request-origin checks; model credentials are stored outside the source repository.

### Known limitations

- At the v0.1.0 release point, PDF and DOCX were recognized but not parsed. OCR, translation, and full-fidelity Markdown rendering were not included in that release.
- Advanced PPTX elements such as SmartArt, charts, complex tables, and exact slide layout are not fully supported.
- AI actions require a configured model. Without one, reading, annotations, and local note nodes remain available.
- The bottom global question composer is a disabled placeholder. Questions are currently started from terms, exploration nodes, and lasso selections.
- Anthropic Messages is reserved but has no working adapter. Provider streaming capability can be configured, but the exploration UI does not currently render streamed tokens.
- Very long documents do not use virtualized rendering; large-document performance has not been fully measured.
- Electron main/preload code, renderer isolation, packaging, and Windows EXE builds are not implemented.
- Browser reading position and panel state use browser localStorage; they are not part of the SQLite data-directory backup.

