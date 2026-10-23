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

  // 忽略已有翻译容器、已直接替换节点、或包含已翻译子块的外层容器，彻底杜绝已替换后二次重复提取与覆盖掏空
  if (
    element.classList?.contains('translate-king-wrapper') ||
    (typeof element.closest === 'function' && element.closest('.translate-king-wrapper')) ||
    (typeof element.hasAttribute === 'function' && element.hasAttribute('data-tk-replaced')) ||
    (typeof element.closest === 'function' && element.closest('[data-tk-replaced]')) ||
    (typeof element.querySelector === 'function' && element.querySelector('[data-tk-id], [data-tk-replaced]'))
  ) {
    return true;
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
