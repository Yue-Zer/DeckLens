# Changelog

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

- PDF and DOCX are recognized but not parsed. OCR, translation, and full-fidelity Markdown rendering are not included.
- Advanced PPTX elements such as SmartArt, charts, complex tables, and exact slide layout are not fully supported.
- AI actions require a configured model. Without one, reading, annotations, and local note nodes remain available.
- The bottom global question composer is a disabled placeholder. Questions are currently started from terms, exploration nodes, and lasso selections.
- Anthropic Messages is reserved but has no working adapter. Provider streaming capability can be configured, but the exploration UI does not currently render streamed tokens.
- Very long documents do not use virtualized rendering; large-document performance has not been fully measured.
- Electron main/preload code, renderer isolation, packaging, and Windows EXE builds are not implemented.
- Browser reading position and panel state use browser localStorage; they are not part of the SQLite data-directory backup.

