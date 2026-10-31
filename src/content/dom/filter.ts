/**
 * 翻译王 (TranslateKing) - DOM 节点智能过滤引擎
 */

// 绝对忽略的噪声标签
const IGNORED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'CANVAS',
  'CODE',
  'PRE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'TIME'
]);

// 参考文献与文献列表保护选择器：避免将专有书名、期刊名、出版机构、DOI/ISBN 及嵌入式 CSS 暴力机翻导致中英混杂与乱码
const REFERENCE_SELECTORS = [
  '.mw-references-wrap',
  '.reflist',
  'ol.references',
  'ul.references',
  '.mw-cite-backlink',
  '.vector-toc-toggle'
].join(',');

// 社交平台（如 X / Twitter）专属绝对噪声选择器（避免误翻译发推输入框、私信输入框、搜索框）
const NOISE_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  '[data-testid="DMComposerTextInput"]',
  '[data-testid="SearchBox_Search_Input"]',
  '[role="progressbar"]'
].join(',');

// 视频播放器、字幕容器及翻译王自身所有 UI 组件保护选择器
const PLAYER_SUBTITLE_SELECTORS = [
  '#movie_player',
  '.html5-video-player',
  '.caption-window',
  '.ytp-caption-window-bottom',
  '.ytp-caption-segment',
  '.captions-text',
  '.ytp-chrome-bottom',
  '.ytp-chrome-controls',
  '.ytp-right-controls',
  '.ytp-left-controls',
  '.translate-king-bilingual-line',
  '.translate-king-yt-control-btn',
  '.translate-king-yt-action-btn',
  '#translate-king-yt-summary-panel',
  '#translate-king-yt-subtitle-menu',
  '#translate-king-floating-ball',
  '#translate-king-bubble-host',
  '[id^="translate-king-"]',
  '[data-tk-ignore="true"]',
  'ytd-player',
  'ytd-video-meta-block',
  '#metadata-line',
  'ytd-channel-name',
  '#author-text',
  '#vote-count-middle',
  '.bpx-player-container',
  '.bpx-player-control-entity',
  '.bpx-player-control-bottom',
  '.bpx-player-control-bottom-right',
  '.bpx-player-control-bottom-left',
  '.bpx-player-control-top',
  '.bpx-player-subtitle-panel',
  '.bili-subtitle-x-subtitle-panel',
  '.translate-king-bili-control-btn',
  '#translate-king-bili-subtitle-line',
  '#translate-king-bili-toast'
].join(',');

/**
 * 校验某个节点上的 loading 锁是否仍然有效（超过 12 秒视为超时失效并自动清理）
 */
function isLoadingLockActive(el: Element): boolean {
  if (!el.hasAttribute('data-tk-loading')) return false;
  const ts = Number(el.getAttribute('data-tk-loading') || '0');
  if (ts > 0 && Date.now() - ts > 12000) {
    el.removeAttribute('data-tk-loading');
    el.querySelectorAll('.translate-king-wrapper.translate-king-loading').forEach((n) => n.remove());
    return false;
  }
  return true;
}

/**
 * 校验元素是否真正处于翻译生效状态（或正在队列/网络请求中）。
 * 若 React / Vue 等 SPA 框架在前端路由切换或组件重挂载时重置了子节点内容，
 * 则自动清除过期脏标记，允许自愈式重新提取与翻译。
 */
export function isElementEffectivelyTranslated(el: Element): boolean {
  // 1. 自身即为翻译容器
  if (el.classList?.contains('translate-king-wrapper')) {
    return true;
  }

  // 2. 自身正处于异步请求或队列等待锁定态
  if (isLoadingLockActive(el)) {
    return true;
  }

  // 3. 自身内部直接包含已完成或正在加载的翻译容器
  if (typeof el.querySelector === 'function') {
    const activeWrapper = el.querySelector(
      '.translate-king-wrapper.translate-king-done, .translate-king-wrapper.translate-king-loading'
    );
    if (activeWrapper) {
      return true;
    }
  }

  // 4. 若自身标记了 data-tk-translated，但内部 .translate-king-wrapper 已被前端框架重渲染抹除，则自愈清除标记
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-tk-translated')) {
    const hasWrapper = typeof el.querySelector === 'function' && el.querySelector('.translate-king-wrapper');
    if (hasWrapper) {
      return true;
    }
    el.removeAttribute('data-tk-translated');
  }

  // 5. 如果某个祖先节点正在翻译或已经挂载了双语译文容器，
  // 说明该祖先段落已被整体接管，其内部的任何子 <span> / <a> / <b> 绝不能再被拆碎重复提取！
  if (typeof el.closest === 'function') {
    const lockedAncestor = el.closest('[data-tk-translated="true"], [data-tk-loading]');
    if (lockedAncestor && lockedAncestor !== el) {
      if (
        isLoadingLockActive(lockedAncestor) ||
        lockedAncestor.querySelector('.translate-king-wrapper')
      ) {
        return true;
      } else {
        lockedAncestor.removeAttribute('data-tk-translated');
        lockedAncestor.removeAttribute('data-tk-loading');
      }
    }
  }

  // 6. 如果存在直接替换标记，检查其内容是否依然维持译文状态
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-tk-replaced')) {
    const origText = el.getAttribute('data-tk-orig-text')?.trim();
    const transText = el.getAttribute('data-tk-trans-text')?.trim();
    const currentText = el.textContent?.trim();

    const isStillTranslated =
      transText && currentText ? currentText === transText || currentText.includes(transText) : false;

    if (!isStillTranslated || !currentText || (origText && currentText === origText)) {
      el.removeAttribute('data-tk-replaced');
      el.removeAttribute('data-tk-id');
      el.removeAttribute('data-tk-orig-text');
      el.removeAttribute('data-tk-trans-text');
      el.removeAttribute('data-tk-orig-html');
      return false;
    }
    return true;
  }

  // 7. 仅有 data-tk-id 标记但既无 wrapper 容器也无替换状态，说明是 React 重渲染后残留的孤儿属性
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-tk-id')) {
    el.removeAttribute('data-tk-id');
    return false;
  }

  return false;
}

/**
 * 判断指定元素是否应该被忽略（代码、脚本、输入框、已翻译段落的子节点、或明确声明不翻译的节点）
 */
export function shouldIgnoreElement(element: Element): boolean {
  if (IGNORED_TAGS.has(element.tagName)) {
    return true;
  }

  // 严格保护时间标签及其外层紧致包装容器
  if (element.tagName === 'TIME' || (typeof element.closest === 'function' && element.closest('time'))) {
    return true;
  }
  if (typeof element.querySelector === 'function' && element.querySelector('time')) {
    const timeEl = element.querySelector('time');
    if (timeEl && element.textContent?.trim() === timeEl.textContent?.trim()) {
      return true;
    }
  }

  // 参考文献区域保护：保护外层引文容器与回跳箭头，但允许引文中的正文超链接进行独立翻译
  if (
    (typeof element.matches === 'function' && element.matches(REFERENCE_SELECTORS)) ||
    (typeof element.closest === 'function' && element.closest(REFERENCE_SELECTORS))
  ) {
    if (element.tagName === 'A' && !element.closest('.mw-cite-backlink')) {
      return false;
    }
    return true;
  }

  // 忽略已有翻译容器及翻译王自身所有 UI 组件
  if (
    element.classList?.contains('translate-king-wrapper') ||
    (typeof element.closest === 'function' &&
      element.closest('.translate-king-wrapper, [id^="translate-king-"], [data-tk-ignore="true"]'))
  ) {
    return true;
  }

  // 核心防重机制：若当前元素或其任何祖先节点正在队列翻译中 (data-tk-loading) 或已完成双语翻译 (data-tk-translated)，
  // 绝对禁止再提取其内部的任何子 <span> / <a> / <b>（彻底解决评论多行与视频标题重复二次翻译问题！）
  if (typeof element.closest === 'function') {
    const ancestorLocked = element.closest('[data-tk-translated="true"], [data-tk-loading]');
    if (ancestorLocked) {
      if (isLoadingLockActive(ancestorLocked) || ancestorLocked.querySelector('.translate-king-wrapper')) {
        return true;
      }
    }
    // 兜底检查父链（最多向上 4 层）是否直接拥有 .translate-king-wrapper 子节点
    let parent: Element | null = element.parentElement;
    let depth = 0;
    while (parent && depth < 4) {
      if (parent.tagName !== 'BODY' && parent.tagName !== 'MAIN' && parent.tagName !== 'ARTICLE') {
        const directWrapper = Array.from(parent.children).some((c) =>
          c.classList?.contains('translate-king-wrapper')
        );
        if (directWrapper) {
          return true;
        }
      }
      parent = parent.parentElement;
      depth++;
    }
  }

  // 检查自身或最近祖先是否处于有效替换生效状态
  if (typeof element.closest === 'function') {
    const replacedAncestor = element.closest('[data-tk-replaced]');
    if (replacedAncestor && isElementEffectivelyTranslated(replacedAncestor)) {
      return true;
    }
  }

  if (typeof element.hasAttribute === 'function' && element.hasAttribute('data-tk-replaced')) {
    if (isElementEffectivelyTranslated(element)) {
      return true;
    }
  }

  // 若自身包含尚未过期的有效翻译子块或正在加载的子块，则外层容器不作为叶子重复提取
  if (typeof element.querySelector === 'function') {
    const childTranslated = element.querySelector(
      '.translate-king-wrapper, [data-tk-replaced], [data-tk-loading], [data-tk-translated="true"]'
    );
    if (childTranslated && isElementEffectivelyTranslated(childTranslated)) {
      return true;
    }
  }

  // 遵循 W3C 规范：translate="no" 或 class="notranslate"
  if (
    element.getAttribute('translate') === 'no' ||
    element.classList.contains('notranslate') ||
    element.classList.contains('visually-hidden') ||
    element.classList.contains('sr-only') ||
    element.classList.contains('mw-editsection-bracket') ||
    element.classList.contains('vector-toc-numb') ||
    (typeof element.closest === 'function' &&
      element.closest('.mw-editsection-bracket, .vector-toc-numb, [translate="no"], .notranslate, .visually-hidden, .sr-only')) ||
    (element as HTMLElement).isContentEditable
  ) {
    return true;
  }

  // 检查是否属于特定平台噪声容器
  if (typeof element.matches === 'function' && element.matches(NOISE_SELECTORS)) {
    return true;
  }
  if (typeof element.closest === 'function' && element.closest(NOISE_SELECTORS)) {
    return true;
  }

  // 严格保护视频播放器及字幕容器
  if (typeof element.matches === 'function' && element.matches(PLAYER_SUBTITLE_SELECTORS)) {
    return true;
  }
  if (typeof element.closest === 'function' && element.closest(PLAYER_SUBTITLE_SELECTORS)) {
    return true;
  }

  return false;
}

/**
 * 启发式检验文本内容是否承载有效可读语言信息
 */
export function isValidTranslatableText(text: string): boolean {
  // 剔除 <xN> 占位符标签后再检测纯文本语义
  const trimmed = text.replace(/<\/?x\d+[^>]*>/gi, '').trim();
  if (trimmed.length < 2) {
    return false;
  }

  // 必须至少包含一个真正的语言文字字符 (\p{L})，彻底过滤纯 Emoji (如 "🔥", "📔", "👍")、纯数字和纯符号
  if (!/\p{L}/u.test(trimmed)) {
    return false;
  }

  // 纯数字、纯符号、纯日期的无意义零散片段跳过
  if (/^[\d\s.,/#!$%^&*;:{}=\-_`~()@+?><[\]|\\'"“”‘’]+$/.test(trimmed)) {
    return false;
  }

  // 纯单个简短无序编号 (如 "1.", "a)", "•")
  if (/^([0-9a-zA-Z]|[•\-–—*])\s*[:.)]?$/.test(trimmed)) {
    return false;
  }

  // 社交账号 Handle (如 @elonmusk, @jasondemers5) 绝不翻译
  if (/^@[\w_.-]+$/.test(trimmed)) {
    return false;
  }

  // 纯网址链接 (如 https://t.co/..., www.example.com) 绝不翻译
  if (/^(https?:\/\/|www\.)\S+$/i.test(trimmed)) {
    return false;
  }

  // 时间与时钟时间戳 (如 3:15 PM, 12:00 AM, 14:30) 绝不翻译
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?$/i.test(trimmed)) {
    return false;
  }

  // 英文/中文播放量与相对时间短语 (如 2h, 5m, 3 years ago, 411万, 3年前, 4个月前, 11天前, 10,803 条评论, 145 条回复, 4年前（修改过）) 绝不翻译
  if (
    /^\d[\d,.]*\s*(?:[smhdwMykKmMbB]|sec|secs|min|mins|hr|hrs|day|days|week|weeks|month|months|year|years|ago|views|万|亿|次观看|条评论|条回复|年前|个月前|周前|天前|小时前|分钟前|秒前)(?:\s*[（(].*[)）])?$/i.test(
      trimmed
    )
  ) {
    return false;
  }

  // 剔除 @用户名 和 URL 后必须仍包含有效语言文字
  const withoutHandlesAndUrls = trimmed
    .replace(/@[\w_.-]+/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .trim();

  if (!withoutHandlesAndUrls || !/\p{L}/u.test(withoutHandlesAndUrls)) {
    return false;
  }

  return true;
}

/**
 * 判断文本是否已经处于目标语言（例如目标语言为 zh-CN 时，纯中文 UI 词条和中文标题无需再翻译）
 */
export function isAlreadyInTargetLanguage(text: string, targetLang?: string): boolean {
  if (!targetLang || (targetLang !== 'zh-CN' && targetLang !== 'zh-TW')) {
    return false;
  }

  const clean = text
    .replace(/<\/?x\d+[^>]*>/gi, '')
    .replace(/@[\w_.-]+/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .trim();

  const cjkCount = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjkCount === 0) return false;

  const hasForeignWord = /[a-zA-Z\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]{2,}/.test(clean);

  // 1. 含中文且不含任何连续外文单词（如 "排序方式"、"添加评论..."、"已由@programmingwithmosh置顶"、"回复"）
  // 2. 已包含 >= 4 个汉字的中文标题/句子（如 "JavaScript初学者教程：1小时学会JavaScript"）
  if (!hasForeignWord || cjkCount >= 4) {
    return true;
  }

  return false;
}
