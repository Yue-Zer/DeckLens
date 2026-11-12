# Web reader screenshots

These screenshots show the current Web reader, built from the repository source. Refresh them whenever the visible reader layout changes.

| File | Viewport in CSS pixels | Contents |
| --- | --- | --- |
| `web-reader-desktop.jpg` | 1440 × 960 | Folders, outline, source reading, ordinary conversation, citations, and the question composer in the right panel |
| `web-reader-branches.jpg` | 1440 × 960 | Branch path, collapsed answer, follow-up actions, and source references |
| `web-reader-mobile.jpg` | 375 × 816 | Narrow-screen source reading |
| `web-reader-mobile-chat.jpg` | 375 × 816 | Narrow-screen conversation drawer and its bottom question composer |

## Refresh locally

From the project root:

```powershell
npm run build
node scripts/preview-screenshots.mjs
```

Open the local URL printed by the script, select the imported document, and capture the four views above. Expand the final answer's citation list for the desktop views; in branch mode, collapse the first answer. Open the conversation panel for the narrow-screen conversation capture. Replace the JPEG files and review their README captions together. Stop the preview with Ctrl+C when finished.

The preview creates its own fresh `decklens-screenshots-*` directory under the operating system's temporary directory. It does not read the normal DeckLens data directory or configure a model. Its document and conversation text are authored presentation fixtures, and source references point to actual blocks parsed from that document. The screenshots demonstrate the interface, not live model output. Temporary preview data remains outside the repository after shutdown.

Never capture private source documents, provider settings, API keys, or personal file paths. Verify that the narrow-screen page and its question composer stay within the 375px viewport before saving.
