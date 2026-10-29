# TranslateKing

<div align="center">

<img src="public/icons/icon-128.png" alt="TranslateKing Logo" width="100" height="100" />

### Read the world in bilingual clarity.
*An ultra-lightweight, zero-config, non-destructive bilingual web & YouTube subtitle translation Chrome extension.*

[![Manifest V3](https://img.shields.io/badge/Manifest-MV3-blue?logo=google-chrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-green.svg)](LICENSE)
[![Tests Passed](https://img.shields.io/badge/Tests-96%2F96%20Passed-brightgreen)](tests/)
[![Vite 5](https://img.shields.io/badge/Built%20With-Vite%205-purple?logo=vite&logoColor=white)](https://vitejs.dev/)
[![TypeScript 5](https://img.shields.io/badge/Language-TypeScript%205-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**[简体中文文档](README.md)** · **[English Documentation](README_EN.md)** · [Key Features](#-key-features) · [Reading Modes & Themes](#-reading-modes--6-visual-themes) · [YouTube Subtitles & Summary](#-youtube-bilingual-subtitles--full-length-summary) · [Selection & Input Translate](#-selection-lookup--triple-space-input-translate) · [Test Matrix](#-automated-testing-matrix-100-passed) · [Quick Start](#-quick-start) · [Privacy Policy](privacy.html)

</div>

---

## 💡 Why TranslateKing?

Most bilingual web translation extensions suffer from **excessive bundle sizes (20MB+), infinite DOM mutation loops, broken Table of Contents (TOC) sidebars, flickering word-by-word YouTube auto-generated captions (ASR), and intrusive tracking**.

**TranslateKing** is built from scratch with a clean, high-performance, resilient architecture:
- **Zero-Configuration + Custom AI Engines**: Built-in Microsoft Edge Neural & Google Translate channels work out of the box with no API keys required; also supports custom **DeepSeek AI, OpenAI (GPT-4o), and Anthropic Claude** endpoints in the full-page Settings Center (`options.html`).
- **Sentence-Merged YouTube Bilingual Subtitles & Video Summary**: Intercepts YouTube `/api/timedtext` streams (`json3`, `srv1`, `srv3`) in the `MAIN` world, merges word-by-word ASR fragments into complete sentences without flickering or overflowing the player, and generates full-duration timestamped video summaries and bilingual transcripts (supporting 3+ hour videos).
- **Non-Destructive Layout & Line-Break Preservation**: Preserves all native DOM nodes, event listeners, navigation anchors, and multi-line comment formatting.
- **100% Private**: Direct gateway communication with zero intermediate telemetry, proxies, or user tracking.

---

## 🌓 Reading Modes & 6 Visual Themes

1. **Bilingual Mode (Default)**: Elegantly injects translations below the original text for side-by-side comparison.
2. **Translation-Only Mode (Replace)**: Replaces original text in place while preserving original fonts, line breaks (`<br>` / `\n`), and interactive buttons.
3. **6 Built-in Visual Styles**:
   - `blockquote` (Default): Classic royal-blue left quote accent bar.
   - `warm`: Amber-gold eye-care accent & tint.
   - `clean`: Borderless & background-free, 100% inheriting the host paragraph's typography.
   - `dashed`: Subtle dashed underline for academic & technical reading.
   - `highlight`: Soft marker highlight.
   - `mask`: Learning blur mask (reveals clearly on hover).

---

## 🎬 YouTube Bilingual Subtitles & Full-Length Summary

- **In-Player `[双语 ON | ⚙]` Control & Console**: Mounted on the left side of YouTube's right control bar. Customize bilingual vs. translation-only mode, top/bottom position, font scale (`80%–145%`), 5 text colors, background opacity, hover-to-pause, blur mask, and **1-click bilingual `.SRT` export**.
- **Flicker-Free ASR Sentence Takeover**: Automatically detects `.ytp-caption-window-rollup` auto-generated captions, merges word streams into complete sentences, pre-translates in 30-sentence sliding windows, and locks subtitles inside the 86% safe player bounds.
- **Full-Duration Video Summary & Bilingual Transcript (`[✨ 视频总结]`)**: Covers 100% of the video timeline from `00:00` to the end (even on 3+ hour videos), with clickable `[MM:SS]` / `[H:MM:SS]` timestamp badges and strict `videoId` isolation across SPA navigation.

---

## 🔍 Selection Lookup & Triple-Space Input Translate

- **Viewport-Clamped Floating Dictionary Card**: Select any word or sentence to view UK/US phonetics, audio pronunciation, contextual sentence translation, and save to your local Wordbook—clamped safely within the viewport with an internal scroll container.
- **Triple-Space Input Box Translation (`Space × 3`)**: Type in any `<input>`, `<textarea>`, or `contenteditable` editor (X/Twitter, GitHub, Discord, Gmail) and press `Space` 3 times rapidly to translate your draft into fluent English in place.
- **Floating Quick-Action Ball**: Draggable right-edge floating ball for one-click bilingual toggling.

---

## 📊 Automated Testing Matrix (100% Passed)

| Test Suite | Scope & Boundary Tests | Count | Status |
| :--- | :--- | :---: | :---: |
| [`tests/youtube_observer.test.ts`](tests/youtube_observer.test.ts) | YouTube dual subtitles, ASR `srv3` sentence takeover, subtitle console, 3-hour summary, SPA video isolation | 11 | ✅ Passed |
| [`tests/youtube_extractor.test.ts`](tests/youtube_extractor.test.ts) | YouTube track selection, ASR word-stream sentence merger, `json3`/`xml` parsing | 9 | ✅ Passed |
| [`tests/youtube_overlay.test.ts`](tests/youtube_overlay.test.ts) | YouTube subtitle overlay, hover-pause, style isolation | 6 | ✅ Passed |
| [`tests/youtube_scheduler.test.ts`](tests/youtube_scheduler.test.ts) | Sliding-window pre-translation (120s window / 30-cue batches), binary search, seek preemption | 4 | ✅ Passed |
| [`tests/twitter_dm.test.ts`](tests/twitter_dm.test.ts) | Twitter DM chat messages, sender bubbles, timestamps, action buttons | 10 | ✅ Passed |
| [`tests/filter.test.ts`](tests/filter.test.ts) | Code blocks, SVG, forms, citation anchors, semantic boundaries | 9 | ✅ Passed |
| [`tests/wikipedia.test.ts`](tests/wikipedia.test.ts) | Full Wikipedia articles, TOC anchor stability, reference links, CSS stripping | 7 | ✅ Passed |
| [`tests/selection.test.ts`](tests/selection.test.ts) | Word & sentence selection detection, viewport clamping, debounce | 5 | ✅ Passed |
| [`tests/viewport.test.ts`](tests/viewport.test.ts) | Viewport-first priority queue sorting | 5 | ✅ Passed |
| [`tests/translator.test.ts`](tests/translator.test.ts) | Multi-gateway failover, empty array safety, L1 cache hit, gateway health | 4 | ✅ Passed |
| [`tests/injector.test.ts`](tests/injector.test.ts) | Non-destructive insertion, multi-line `<br>` preservation, instant rollback | 4 | ✅ Passed |
| [`tests/dictionary.test.ts`](tests/dictionary.test.ts) | Phonetics, definition lookups, audio streams, memory caching | 4 | ✅ Passed |
| [`tests/sentenceExtractor.test.ts`](tests/sentenceExtractor.test.ts) | Complex academic sentence boundary segmentation | 4 | ✅ Passed |
| [`tests/extractor.test.ts`](tests/extractor.test.ts) | Inline tag preservation, multi-line comment extraction | 3 | ✅ Passed |
| [`tests/second_pass.test.ts`](tests/second_pass.test.ts) | MutationObserver second-pass zero re-extraction (anti-flicker) | 3 | ✅ Passed |
| [`tests/twitter_spa_sidebar.test.ts`](tests/twitter_spa_sidebar.test.ts) | Twitter SPA client navigation, persistent sidebar, re-entry lifecycle | 3 | ✅ Passed |
| [`tests/zhihu_richtext.test.ts`](tests/zhihu_richtext.test.ts) | Zhihu rich text formatting, nested links inside bold paragraphs | 2 | ✅ Passed |
| [`tests/toc_batch.test.ts`](tests/toc_batch.test.ts) | Concurrent sidebar TOC item extraction and injection | 1 | ✅ Passed |
| [`tests/usercell_debug.test.ts`](tests/usercell_debug.test.ts) | Twitter / X UserCell bios and action buttons extraction | 1 | ✅ Passed |
| [`tests/twitter_dm_screenshot.test.ts`](tests/twitter_dm_screenshot.test.ts) | Twitter chat visual screenshot regression and layout stability | 1 | ✅ Passed |
| **Total** | **20 Test Suites** | **96 / 96** | **100% Passed** |

---

## 🚀 Quick Start

1. Clone this repository:
   ```bash
   git clone https://github.com/stwbos/translate-king.git
   cd translate-king
   ```
2. Install dependencies & build:
   ```bash
   pnpm install
   pnpm build
   ```
3. Open Google Chrome and navigate to `chrome://extensions`;
4. Enable **Developer mode** in the top-right corner;
5. Click **Load unpacked** in the top-left corner and select the `dist` directory.

---

## 📜 License

This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).
