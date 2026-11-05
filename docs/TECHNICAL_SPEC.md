# 翻译王 (TranslateKing) 系统架构与核心技术规范

> **文档版本**：v1.3.0  
> **核心目标**：构建 100% 自主可控、轻量高速、零隐私追踪的沉浸式网页双语对照与全平台视频（YouTube / Bilibili / 全网 HTML5 视频）双语字幕与时间轴总结 Chrome 扩展（Manifest V3）。

---

## 一、 核心架构总览

翻译王采用高内聚的四层架构：
1. **网页 DOM 语义解析、Shadow DOM 穿透与 6 主题无损挂载引擎 (`src/content/dom/`)**
2. **全平台视频整句双语字幕与全时长总结引擎 (`src/content/youtube/`, `src/content/bilibili/`, `src/content/video/`)**
3. **统一品牌视觉系统、Shadow DOM 视口自适应划词精读、悬浮球与三击空格输入翻译 (`src/content/logo.ts`, `src/content/selection/`, `floating-ball.ts`, `input-translate.ts`)**
4. **多引擎高可用翻译网关与全屏设置中心 (`src/background/translator.ts`, `src/options/`)**

---

## 二、 核心模块设计详解

### 模块 1：网页 DOM 语义解析与无损双语挂载 (`src/content/dom/`)

1. **多行换行与富文本结构保护 (`extractor.ts` & `injector.ts`)**：
   - 将块级节点内的 `<br>` 与真实换行符 `\n` 统一规整，按换行拆分为独立翻译子段后重组，确保 YouTube 评论区（`#content-text`）、LinkedIn 动态流与长帖在「双语对照」和「仅看译文」模式下 100% 保留原始段落换行与展开按钮交互。
   - 支持开放 `ShadowRoot` 递归穿透（如 Bilibili `bili-comments` 评论区组件树）。
2. **6 款双语视觉主题 (`content.css`)**：
   - 支持 `blockquote`（皇家蓝引用边栏，默认）、`warm`（暖金护眼微底）、`clean`（纯净无框，继承原文排版）、`dashed`（虚线底边）、`highlight`（荧光高亮）、`mask`（高斯模糊遮罩，悬停显形）。
3. **防重复翻译与防频闪守卫 (`second_pass`)**：
   - 通过 `data-translate-king-id`、`data-tk-translated` 以及内嵌 `.translate-king-block` 守卫，确保 `MutationObserver` 动态扫描 0 重复提取。

---

### 模块 2：全平台视频双语字幕与全时长总结引擎 (`src/content/youtube/`, `src/content/bilibili/`, `src/content/video/`)

1. **MAIN 世界零副作用字幕流拦截器 (`yt-bridge.ts`)**：
   - 在 `document_start` 阶段挂载于 YouTube 与 Bilibili 的 `MAIN` 执行世界，被动拦截 `XMLHttpRequest` 与 `fetch` 发出的带合法签名的 `/api/timedtext`（YouTube）以及 `aisubtitle.hdslb.com` / `/x/player/wbi/v2`（Bilibili）请求，并支持通过 `performance.getEntriesByType('resource')` 回溯已加载字幕流。
   - 严格校验 `videoId`（YouTube `v=` 参数 / Bilibili `BV号_p分集号`），在 SPA 切视频与浏览器后退时主动清理旧视频缓存，根绝切视频串台。
2. **Bilibili 双语字幕无痕接管与反爬假字幕蜜罐防御 (`bilibili/index.ts` & `summary-panel.ts`)**：
   - 自动探测并开启 B站播放器的「中文 AI」或 CC 字幕，将 `#translate-king-bili-subtitle-line` 直接挂载于 `.bpx-player-video-area` 底部安全区（`bottom: 54px`），并隐藏 `.bili-subtitle-x-subtitle-panel` 等原生灰底容器，在同一弹性框内通过 `flex-direction: column / column-reverse` 呈现「译文在原文下方 / 译文在原文上方」。
   - 内置 `isBiliHoneyPotRawText` 与 `isBiliHoneyPotCues` 校验器，精准识别并过滤 B站未签名接口返回的“亚历克斯独自抚养孩子”反爬假字幕蜜罐。
3. **YouTube ASR 逐词语音字幕断句合并引擎 (`extractor.ts` & `native-observer.ts`)**：
   - 兼容 `json3`、`srv1`、`srv3`、Bilibili JSON（`{ body: [{ from, to, content }] }`）以及通用 `WebVTT` / `SRT` 格式。
   - 自动探测逐词偏移时间戳（`tOffsetMs > 0`），通过 `mergeAsrSubtitles` 归一化跨事件 `endMs` 重叠区间，按词间自然停顿、句末标点与词数上限重组为完整语义长句。
4. **翻译王宝石蓝主题全时长视频总结面板 (`summary-panel.ts`)**：
   - 采用翻译王深海宝石蓝渐变主题（`#0f1d3a -> #091122`）与品牌图标，在 Bilibili 精准挂载于 `#danmukuBox` 正上方（`.up-panel-container` 下方），避开顶部导航栏遮挡并阻断宿主页面事件吞噬。
   - 动态计算视频首尾总时长（适配 5 分钟至 3+ 小时视频），均分为 ~24 个时间轴章节要点与 ~18 秒一段的双语文字稿，支持点击时间戳跨世界跳转播放（`TK_SEEK_TO_SECONDS`）与一键复制。

---

### 模块 3：统一品牌图标、划词卡片视口防溢出与三击空格输入翻译

1. **纯 DOM API 官方品牌图标组件 (`src/content/logo.ts`)**：
   - 采用 `document.createElementNS('http://www.w3.org/2000/svg', ...)` 构建带唯一渐变 ID 的皇家蓝底 + 金色「A/文」品牌徽章，100% 兼容 YouTube / Bilibili 严格 `TrustedTypes` CSP 策略。
2. **划词精读浮窗 (`src/content/selection/floating-card.ts`)**：
   - 挂载于独立 `ShadowRoot` 中，实测宽高动态计算上下翻转与左右边界吸附，确保长句翻译绝不超出屏幕。
3. **三击空格输入翻译 (`src/content/input-translate.ts`)**：
   - 监听 `<input>`、`<textarea>` 与 `contenteditable` 富文本输入框的连按三次空格手势（`Space × 3`），无损回填译文。

---

### 模块 4：单文件 Content Script 打包约束 (`vite.config.ts`)

- Chrome MV3 的 `content_scripts` 不支持顶层 ES Module `import` 语句。
- `src/options/options.ts` 与 `src/popup/popup.ts` 严禁直接从 `src/content/*` 导入运行时函数（仅允许 `import type`），确保 Rollup 将 `dist/content.js` 编译为 100% 零外部依赖的自包含单文件。
