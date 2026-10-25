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
// 严禁将卡片容器或包含有效文本的组件放入此处的最近祖先查找中，否则会导致卡片内所有正文简介与按钮被整片误杀
const NOISE_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  '[data-testid="DMComposerTextInput"]',
  '[data-testid="SearchBox_Search_Input"]',
  '[role="progressbar"]'
].join(',');

/**
 * 校验元素是否真正处于翻译生效状态。
 * 若 React / Vue 等 SPA 框架在前端路由切换或组件重挂载时重置了子节点内容
 * （表现为译文 wrapper 丢失、或 textContent 还原为 data-tk-orig-text），
 * 则自动清除过期脏标记，允许自愈式重新提取与翻译。
 */
export function isElementEffectivelyTranslated(el: Element): boolean {
  // 1. 如果自身是翻译容器，或包含有效的双语译文容器，视为有效翻译
  if (
    el.classList?.contains('translate-king-wrapper') ||
    (typeof el.querySelector === 'function' && el.querySelector('.translate-king-wrapper'))
  ) {
    return true;
  }

  // 2. 如果存在直接替换标记，检查其内容是否依然维持译文状态
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-tk-replaced')) {
    const origText = el.getAttribute('data-tk-orig-text')?.trim();
    const transText = el.getAttribute('data-tk-trans-text')?.trim();
    const currentText = el.textContent?.trim();

    // 判定情况 A：若当前文本变回了原文，说明已被 React 重新挂载为纯净英文！
    // 判定情况 B：当前文本为空（如 Twitter 侧栏在聊天页切换为纯图标模式，文本被拔除）
    // 判定情况 C：有 transText 但当前文本完全不包含已翻译词汇
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

  // 3. 仅有 data-tk-id 标记但既无 wrapper 容器也无替换状态，说明是 React 重渲染后残留的孤儿属性
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-tk-id')) {
    el.removeAttribute('data-tk-id');
    return false;
  }

  return false;
}

/**
 * 判断指定元素是否应该被忽略（代码、脚本、输入框、或明确声明不翻译的节点）
 */
export function shouldIgnoreElement(element: Element): boolean {
  if (IGNORED_TAGS.has(element.tagName)) {
    return true;
  }

  // 参考文献区域保护：保护外层引文容器与回跳箭头，但允许引文中的正文超链接 (如参考文章标题外链) 进行独立翻译
  if (
    (typeof element.matches === 'function' && element.matches(REFERENCE_SELECTORS)) ||
    (typeof element.closest === 'function' && element.closest(REFERENCE_SELECTORS))
  ) {
    // 仅允许引文正文中的内容超链接 (排除 .mw-cite-backlink 回跳箭头/序号)
    if (element.tagName === 'A' && !element.closest('.mw-cite-backlink')) {
      return false;
    }
    return true;
  }

  // 忽略已有翻译容器
  if (
    element.classList?.contains('translate-king-wrapper') ||
    (typeof element.closest === 'function' && element.closest('.translate-king-wrapper'))
  ) {
    return true;
  }

  // 检查自身或最近祖先是否处于有效替换生效状态 (支持 SPA 框架重刷后自愈)
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

  // 若自身包含尚未过期的有效翻译子块，则外层容器不作为叶子重复提取
  if (typeof element.querySelector === 'function') {
    const childTranslated = element.querySelector('.translate-king-wrapper, [data-tk-replaced]');
    if (childTranslated && isElementEffectivelyTranslated(childTranslated)) {
      return true;
    }
  }

  // 遵循 W3C 规范：translate="no" 或 class="notranslate"
  if (
    element.getAttribute('translate') === 'no' ||
    element.classList.contains('notranslate') ||
    element.classList.contains('mw-editsection-bracket') ||
    element.classList.contains('vector-toc-numb') ||
    (typeof element.closest === 'function' &&
      element.closest('.mw-editsection-bracket, .vector-toc-numb')) ||
    element.isContentEditable
  ) {
    return true;
  }

  // 检查是否属于特定平台噪声容器（如 Twitter 用户名、输入框、趋势）
  if (typeof element.matches === 'function' && element.matches(NOISE_SELECTORS)) {
    return true;
  }
  if (typeof element.closest === 'function' && element.closest(NOISE_SELECTORS)) {
    return true;
  }

  return false;
}

/**
 * 启发式检验文本内容是否承载有效可读语言信息
 */
export function isValidTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
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
  if (/^@[\w_]+$/.test(trimmed)) {
    return false;
  }

  // 纯网址链接 (如 https://t.co/..., www.example.com) 绝不翻译
  if (/^(https?:\/\/|www\.)\S+$/i.test(trimmed)) {
    return false;
  }

  // 时间简写 (如 2h, 5m, 1d, 3w, 10s) 绝不翻译
  if (/^\d+\s*[smhdwMy]$/.test(trimmed)) {
    return false;
  }

  return true;
}
