# 翻译王 (TranslateKing) 系统架构与核心技术规范

> **文档版本**：v1.2.0  
> **核心目标**：构建 100% 自主可控、轻量高速、零隐私追踪的沉浸式网页双语对照与 YouTube 视频双语字幕/总结 Chrome 扩展（Manifest V3）。

---

## 一、 核心架构总览

翻译王采用高内聚的四层架构：
1. **网页 DOM 语义解析与 6 主题无损挂载引擎 (`src/content/dom/`)**
2. **YouTube 视频整句双语字幕与全时长总结引擎 (`src/content/youtube/`)**
3. **Shadow DOM 视口自适应划词精读、悬浮球与三击空格输入翻译 (`src/content/selection/`, `floating-ball.ts`, `input-translate.ts`)**
4. **多引擎高可用翻译网关与全屏设置中心 (`src/background/translator.ts`, `src/options/`)**

---

## 二、 核心模块设计详解

### 模块 1：网页 DOM 语义解析与无损双语挂载 (`src/content/dom/`)

1. **多行换行与富文本结构保护 (`extractor.ts` & `injector.ts`)**：
   - 将块级节点内的 `<br>` 与真实换行符 `\n` 统一规整，按换行拆分为独立翻译子段后重组，确保 YouTube 评论区（`#content-text`）与长帖在「双语对照」和「仅看译文」模式下 100% 保留原始段落换行。
   - 保护 YouTube 评论内层 `<span class="yt-core-attributed-string--white-space-pre-wrap">` 容器不被清空。
2. **6 款双语视觉主题 (`content.css`)**：
   - 支持 `blockquote`（皇家蓝引用边栏，默认）、`warm`（暖金护眼微底）、`clean`（纯净无框，继承原文排版）、`dashed`（虚线底边）、`highlight`（荧光高亮）、`mask`（高斯模糊遮罩，悬停显形）。
3. **防重复翻译与防频闪守卫 (`second_pass`)**：
   - 通过 `data-translate-king-id`、`data-tk-translated` 以及内嵌 `.translate-king-block` 守卫，确保 `MutationObserver` 动态扫描 0 重复提取。

---

### 模块 2：YouTube 双语字幕与全时长视频总结引擎 (`src/content/youtube/`)

1. **MAIN 世界零副作用字幕流拦截器 (`yt-bridge.ts`)**：
   - 在 `document_start` 阶段挂载于 `MAIN` 执行世界，被动拦截 `XMLHttpRequest` 与 `fetch` 发出的带合法 `pot` 签名的 `/api/timedtext` 请求，并支持通过 `performance.getEntriesByType('resource')` 回溯已加载字幕流。
   - 严格校验 `videoId`（`v=` 参数），在 `yt-navigate-start`、`yt-navigate-finish`、`popstate`（浏览器后退）时主动清理旧视频缓存，根绝切视频串台。
2. **ASR 逐词语音字幕断句合并引擎 (`extractor.ts`)**：
   - 兼容 `json3`、`srv1`（`<text start="...">`）及新版 `srv3`（`<p t="..." d="..."><s t="...">`）格式。
   - 自动探测逐词偏移时间戳（`tOffsetMs > 0`），通过 `mergeAsrSubtitles` 归一化跨事件 `endMs` 重叠区间，按词间自然停顿（`>= 450ms`）、句末标点与词数上限（`14` 词）重组为严格非重叠的完整语义长句。
3. **防闪烁、防溢出双语字幕渲染器 (`native-observer.ts` & `scheduler.ts`)**：
   - 当识别到 ASR 滚动窗口（`.ytp-caption-window-rollup`）时，通过父级 CSS `.caption-window.translate-king-rollup-takeover .captions-text { display: none !important; }` 实现 0 帧闪烁遮蔽，并由 `SubtitleScheduler` 提前按 30 句/批滑动窗口预翻译，同步渲染完整英文长句 + 中文译文。
   - 注入 `#translate-king-yt-caption-fix-styles`，通过 CSS `!important` 将 `.caption-window.translate-king-window-managed` 锁定在视频内部 `[7%, 93%]`（最大宽度 `86%`）安全区并开启 `white-space: pre-wrap` 自动折行，杜绝字幕跑出视频画面。
4. **全时长视频章节总结与双语文字稿 (`summary-panel.ts`)**：
   - 动态计算视频首尾总时长（适配 5 分钟至 3+ 小时视频），均分为 ~24 个时间轴章节要点与 ~18 秒一段的双语文字稿，支持点击时间戳跳转播放与一键复制。

---

### 模块 3：划词卡片视口防溢出与三击空格输入翻译

1. **划词精读浮窗 (`src/content/selection/floating-card.ts`)**：
   - 挂载于独立 `ShadowRoot` 中，先渲染 DOM 内容再调用 `getBoundingClientRect()` 实测宽高，动态计算上下翻转与左右边界吸附（`[12px, viewport - size - 12px]`），内置 `.card-body` 滚动区（`max-height: min(310px, calc(100vh - 120px))`），确保长句翻译绝不超出屏幕。
2. **三击空格输入翻译 (`src/content/input-translate.ts`)**：
   - 监听 `<input>`、`<textarea>` 与 `contenteditable` 富文本输入框的连按三次空格手势（`Space × 3`），通过 `document.execCommand('insertText')` 无损回填译文，完美兼容 React/Vue 受控组件。

---

### 模块 4：单文件 Content Script 打包约束 (`vite.config.ts`)

- Chrome MV3 的 `content_scripts` 不支持顶层 ES Module `import` 语句。
- `src/options/options.ts` 与 `src/popup/popup.ts` 严禁直接从 `src/content/*` 导入运行时函数（仅允许 `import type`），确保 Rollup 将 `dist/content.js` 编译为 100% 零外部依赖的自包含单文件。
