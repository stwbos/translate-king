# 翻译王 (TranslateKing) Chrome Web Store 上架提审指南

本文档提供在 Google Chrome Web Store 开发者后台发布提审时，**所有必须填写的表单字段、权限声明与文案（可直接复制粘贴）**。

---

## 1. 提审准备包路径

* **可直接上传的发布包 ZIP**：
  `translate-king-v0.0.39-chrome.zip`（位于当前项目根目录下，体积仅 19.4 MB，完全符合 <20MB 极速过审门槛）
* **本地已解压测试目录**：
  `extension-preview`（可直接在 `chrome://extensions` 刷新验证）
* **应用商店图标源文件**：
  `public/icons/icon-1024.png`（1024x1024 高清图）及 `public/icons/icon-128.png`

---

## 2. 商店基本信息 (Store Listing)

### 中文 (zh-CN)
* **扩展名称 (Title)**：`翻译王 - 网页双语对照 · 视频字幕 · PDF翻译`
* **简短描述 (Short Description, 132字以内)**：
  ```text
  全网双语对照，一秒读懂世界。支持网页正文双语对照、YouTube视频实时字幕、PDF原版面排版翻译与AI语境精读。
  ```
* **详细描述 (Detailed Description)**：
  ```text
  全网双语对照，一秒读懂世界。

  翻译王（TranslateKing）是一款专为追求高效外语阅读与学习打造的沉浸式双语翻译浏览器扩展。遵循 GPL-3.0 协议开源，无隐私追踪。

  【核心功能特色】
  1. 智能网页双语对照：自动识别并提取网页正文，在原文下方无缝插入译文，不破坏原网页布局，提供弱化下划线、双色对照、卡片等多种优雅样式。
  2. 视频双语字幕：支持 YouTube 等主流视频播放器的实时双语字幕流，自动同步播放时间轴。
  3. PDF 文档原版面排版：保持学术论文、电子书、公式与多栏排版完整不乱，实现对照阅读。
  4. AI 语境深度解析：支持一键接入 DeepSeek、OpenAI、Claude 等现代大模型，提供精准的上下文释义与词法讲解。
  5. 语境生词本与离线发音：内嵌离线英汉词典与高品质语音合成（TTS），阅读时一键收藏包含原句语境的生词，出处随时可回溯。
  6. 极简与隐私：完全基于本地存储，零服务器中转截留，支持免配 Key 极速开箱即用。

  开源代码与反馈渠道：https://github.com/stwbos/translate-king
  ```

### 英文 (en-US)
* **Title**：`TranslateKing - Bilingual Web, Subtitle & PDF Translator`
* **Short Description**：
  ```text
  Read the world in bilingual clarity. Seamless dual-language webpage translation, YouTube subtitles, PDF layout preservation, and AI reading.
  ```
* **Detailed Description**：
  ```text
  Read the world in bilingual clarity.

  TranslateKing is an open-source, privacy-first browser extension for immersive bilingual translation and contextual reading assistance. Released under the GNU GPL-3.0 license.

  Key Features:
  1. Inline Bilingual Reading: Translates webpage paragraphs in place alongside the original text without breaking responsive layouts.
  2. Dual-Language Video Subtitles: Real-time bilingual subtitle overlay for YouTube and streaming media with synchronized playback.
  3. PDF Layout Preservation: Translates academic papers and manuals while preserving formatting, multi-column designs, and formulas.
  4. AI Context Assistance: DeepSeek and OpenAI compatibility for in-depth sentence breakdown and contextual terminology translation.
  5. Vocabulary Center & Native Audio: Collect unfamiliar words with their authentic sentence context and review with offline text-to-speech.
  6. Zero Tracking & Local Privacy: No intermediary tracking servers; user preferences and translation cache remain strictly on your machine.

  Source Code: https://github.com/stwbos/translate-king
  ```

---

## 3. 隐私与权限审核声明 (Privacy & Single Purpose)

在开发者后台的 **「隐私权规范 (Privacy practices)」** 标签页中，Google 要求针对每项权限填写正当理由：

### 核心单一用途说明 (Single Purpose Description)
```text
TranslateKing serves a single unified purpose: providing users with seamless inline bilingual translation and reading assistance across foreign webpages, streaming video subtitles, and PDF documents.
```

### 权限声明理由 (Permission Justifications)

1. **主机权限 `<all_urls>`**：
   ```text
   Required exclusively to detect foreign-language text content across user-visited webpages and inject translated bilingual text and video subtitle overlays into the DOM.
   ```

2. **`storage` / `unlimitedStorage`**：
   ```text
   Used strictly to store user preferences (target languages, display themes, custom shortcuts), local vocabulary items, and translation cache locally on the client device.
   ```

3. **`offscreen`**：
   ```text
   Used to process document layout parsing and run local Web Speech audio synthesis in an isolated sandbox without freezing the user's active browsing tab.
   ```

4. **`declarativeNetRequestWithHostAccess`**：
   ```text
   Used strictly to adapt request headers (such as Referer/Origin) when contacting user-configured third-party translation provider endpoints to prevent cross-origin blocking.
   ```

5. **`identity`**：
   ```text
   Used only if the user chooses to enable optional personal Google Drive configuration backup.
   ```

### 隐私政策链接 (Privacy Policy URL)
* 如果部署到 GitHub Pages：
  `https://stwbos.github.io/translate-king/privacy.html`
* 或者任何公开可访问的 HTTPS 网址，网页内容已保存在当前项目根目录下的 `privacy.html` 中。

---

## 4. 分类与商店标签

* **主分类 (Primary Category)**：`生产力工具 (Productivity)` 或 `工作流程与规划 (Workflow & Planning)`
* **是否收集个人身份信息 (PII)**：全部勾选 **“否 (No)”**。
