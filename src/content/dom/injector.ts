/**
 * 翻译王 (TranslateKing) - 译文渲染器 (支持双语对照与纯中文原地直接替换模式)
 */

import { TranslatableBlock, collectAllRoots } from './extractor';
import { TranslationMode } from '../../types';

const SHOW_TEXT_FILTER = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
const savedOriginalNodesMap = new WeakMap<HTMLElement, Node[]>();

/**
 * 确保 Shadow DOM 内部挂载翻译王的核心样式表
 */
function ensureShadowStyles(shadow: ShadowRoot): void {
  if (typeof shadow.getElementById === 'function' && shadow.getElementById('translate-king-shadow-styles')) return;
  const doc = shadow.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const style = doc.createElement('style');
  style.id = 'translate-king-shadow-styles';
  style.textContent = `
    .translate-king-wrapper {
      display: block !important;
      margin-top: 6px !important;
      margin-bottom: 4px !important;
      line-height: 1.6 !important;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
      user-select: text !important;
      pointer-events: auto !important;
    }
    .translate-king-wrapper .translate-king-text {
      display: inline-block !important;
      font-size: 0.95em !important;
      color: #2563eb !important;
      letter-spacing: 0.02em !important;
      background: rgba(37, 99, 235, 0.06) !important;
      padding: 3px 8px !important;
      border-radius: 4px !important;
      border-left: 3px solid #3b82f6 !important;
      word-break: break-word !important;
      white-space: pre-line !important;
    }
    .translate-king-wrapper.translate-king-loading .translate-king-text {
      opacity: 0.65 !important;
      font-style: italic !important;
    }
    @media (prefers-color-scheme: dark) {
      .translate-king-wrapper .translate-king-text {
        color: #93c5fd !important;
        background: rgba(147, 197, 253, 0.12) !important;
        border-left-color: #60a5fa !important;
      }
    }
  `;
  shadow.appendChild(style);
}

/**
 * 安全定位承载有效非空文本的主 TextNode 节点（过滤纯空白字符节点）
 */
function findPrimaryTextNode(root: Node, doc: Document): Text | null {
  if (typeof doc.createTreeWalker !== 'function') return null;
  try {
    const walker = doc.createTreeWalker(root, SHOW_TEXT_FILTER);
    let current: Text | null = null;
    while ((current = walker.nextNode() as Text | null)) {
      if (current.nodeValue && current.nodeValue.trim().length > 0) {
        return current;
      }
    }
  } catch {
    // 降级兜底
  }
  return null;
}

/**
 * 递归收集主文本节点及所有后续文本节点（含多 span 之间的 \n 换行节点，确保替换与还原 100% 对齐）
 */
function collectManagedTextNodes(root: Node, doc: Document): Text[] {
  if (typeof doc.createTreeWalker !== 'function') return [];
  const nodes: Text[] = [];
  let foundPrimary = false;
  try {
    const walker = doc.createTreeWalker(root, SHOW_TEXT_FILTER);
    let current: Text | null = null;
    while ((current = walker.nextNode() as Text | null)) {
      if (!foundPrimary) {
        if (current.nodeValue && current.nodeValue.trim().length > 0) {
          foundPrimary = true;
          nodes.push(current);
        }
      } else {
        nodes.push(current);
      }
    }
  } catch {
    // 降级兜底
  }
  return nodes;
}

function isInteractiveButton(el: HTMLElement): boolean {
  if (el.tagName === 'BUTTON') return true;
  // 聊天私信气泡容器（React Native Web Touchable/Pressable 常挂载 role="button"）绝不能视为操作按钮
  if (
    el.getAttribute('role') === 'button' &&
    !el.closest(
      '[data-testid="messageEntry"], [data-testid="cellInnerDiv"], [data-testid="DMConversation"], [data-testid="DMChatTranscript"]'
    ) &&
    (el.textContent || '').trim().length <= 50
  ) {
    return true;
  }
  if (el.tagName === 'A' && (el.classList.contains('btn') || el.classList.contains('button'))) return true;
  return false;
}

/**
 * 移除目标元素中的翻译王译文容器（恢复纯净原文）
 */
export function removeTranslation(element: HTMLElement): void {
  // 1. 清理双语对照容器
  const existing = element.querySelectorAll('.translate-king-wrapper');
  existing.forEach((node) => node.remove());

  // 2. 移除替换模式动效类与状态标记
  element.classList.remove('translate-king-replacing-pulse');
  element.removeAttribute('data-tk-loading');
  element.removeAttribute('data-tk-translated');
  element.removeAttribute('data-tk-multiline');
  if (typeof element.querySelectorAll === 'function') {
    element.querySelectorAll('br[data-tk-hidden-br]').forEach((br) => br.removeAttribute('data-tk-hidden-br'));
  }

  // 3. 恢复直接替换模式的原始文本（优先使用内存 DOM 节点快照，兼容 YouTube Trusted Types）
  if (savedOriginalNodesMap.has(element)) {
    const savedNodes = savedOriginalNodesMap.get(element)!;
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
    savedNodes.forEach((n) => element.appendChild(n.cloneNode(true)));
    savedOriginalNodesMap.delete(element);
    element.removeAttribute('data-tk-orig-html');
    element.removeAttribute('data-tk-orig-text');
  } else if (element.hasAttribute('data-tk-orig-html')) {
    try {
      element.innerHTML = element.getAttribute('data-tk-orig-html') || '';
    } catch {
      const origText = element.getAttribute('data-tk-orig-text');
      if (origText !== null) element.textContent = origText;
    }
    element.removeAttribute('data-tk-orig-html');
    element.removeAttribute('data-tk-orig-text');
  } else if (element.hasAttribute('data-tk-orig-text')) {
    const orig = element.getAttribute('data-tk-orig-text');
    if (orig !== null) {
      const doc = element.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (doc) {
        const allTextNodes = collectManagedTextNodes(element, doc);
        // 先还原后续多 span 的 extraText
        if (element.hasAttribute('data-tk-extra-text')) {
          try {
            const extraData = JSON.parse(element.getAttribute('data-tk-extra-text') || '[]') as string[];
            for (let i = 0; i < extraData.length && i + 1 < allTextNodes.length; i++) {
              allTextNodes[i + 1].nodeValue = extraData[i];
            }
          } catch {
            // ignore
          }
          element.removeAttribute('data-tk-extra-text');
        }

        const primaryTextNode = allTextNodes[0] || findPrimaryTextNode(element, doc);
        if (primaryTextNode) {
          primaryTextNode.nodeValue = orig;
        } else {
          element.textContent = orig;
        }
      } else {
        element.textContent = orig;
      }
    }
    element.removeAttribute('data-tk-orig-text');
  }
  element.removeAttribute('data-tk-trans-text');
  if (element.hasAttribute('data-tk-orig-aria')) {
    element.setAttribute('aria-label', element.getAttribute('data-tk-orig-aria') || '');
    element.removeAttribute('data-tk-orig-aria');
  }
  element.removeAttribute('data-tk-replaced');
}

/**
 * 基于 <xN> 占位符将翻译后的 HTML 片段重构为 DOM Fragment
 * 严格保留原始 DOM 节点的各类属性（href, class, title, rel, id 等）及可点击交互能力
 */
function reconstructFragmentFromPlaceholders(
  translatedText: string,
  inlineElements: HTMLElement[],
  doc: Document
): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const regex = /<x(\d+)>([\s\S]*?)<\/x\1>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let hasMatchedTags = false;

  while ((match = regex.exec(translatedText)) !== null) {
    hasMatchedTags = true;
    if (match.index > lastIndex) {
      const textBefore = translatedText.substring(lastIndex, match.index);
      fragment.appendChild(doc.createTextNode(textBefore));
    }

    const tokenIdx = parseInt(match[1], 10);
    const innerText = match[2];

    if (tokenIdx < inlineElements.length) {
      const origEl = inlineElements[tokenIdx];
      const clonedEl = origEl.cloneNode(true) as HTMLElement;
      clonedEl.removeAttribute('data-tk-id');
      clonedEl.removeAttribute('data-tk-replaced');

      const nestedAnchor = clonedEl.querySelector('a');
      if (nestedAnchor && (clonedEl.tagName === 'A' || clonedEl.textContent?.trim() === nestedAnchor.textContent?.trim())) {
        nestedAnchor.textContent = innerText;
      } else {
        clonedEl.textContent = innerText;
      }
      fragment.appendChild(clonedEl);
    } else {
      fragment.appendChild(doc.createTextNode(innerText));
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < translatedText.length) {
    const textAfter = translatedText.substring(lastIndex);
    fragment.appendChild(doc.createTextNode(textAfter));
  }

  if (!hasMatchedTags) {
    const cleanText = translatedText.replace(/<\/?x\d+[^>]*>/gi, '');
    const fallbackFrag = doc.createDocumentFragment();
    fallbackFrag.appendChild(doc.createTextNode(cleanText));
    return fallbackFrag;
  }

  return fragment;
}

/**
 * 在目标元素下方挂载翻译中 (Loading) 占位浮层 (双语模式) 或添加微动效 (替换模式)
 */
export function injectLoadingState(
  block: TranslatableBlock,
  mode: TranslationMode = 'bilingual'
): HTMLElement | null {
  // 核心守卫：已翻译替换过或父级已挂载双语译文的元素绝对不再注入任何加载态，彻底杜绝嵌套重复翻译
  if (
    block.element.hasAttribute('data-tk-replaced') ||
    (typeof block.element.closest === 'function' &&
      block.element.parentElement?.closest('[data-tk-replaced], [data-tk-translated="true"], [data-tk-loading]'))
  ) {
    return null;
  }

  removeTranslation(block.element);

  if (mode === 'replace') {
    // 替换模式下，仅单次微弱呼吸过渡，绝不无限循环
    block.element.classList.add('translate-king-replacing-pulse');
    return null;
  }

  // 双语模式下，若为按钮则不挂载多行 Loading，避免按钮撑爆
  if (isInteractiveButton(block.element)) {
    return null;
  }

  const doc = block.element.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const wrapper = doc.createElement('span');
  wrapper.className = 'translate-king-wrapper translate-king-loading';
  wrapper.setAttribute('translate', 'no'); // 确保自身不被浏览器二次翻译

  // 防止点击/选中文本时触发外部父级（如 Twitter 帖子卡片）的页面跳转
  wrapper.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const textNode = doc.createElement('span');
  textNode.className = 'translate-king-text translate-king-pulse';
  textNode.textContent = '翻译中...';

  wrapper.appendChild(textNode);
  block.element.setAttribute('data-tk-loading', String(Date.now()));
  block.element.appendChild(wrapper);

  const rootNode = typeof block.element.getRootNode === 'function' ? block.element.getRootNode() : null;
  if (rootNode && (rootNode as any).host && typeof (rootNode as any).getElementById === 'function') {
    ensureShadowStyles(rootNode as ShadowRoot);
  }

  return wrapper;
}

/**
 * 注入成功译文 (支持直接替换与双语对照)
 */
export function injectTranslation(
  block: TranslatableBlock,
  translatedText: string,
  mode: TranslationMode = 'bilingual'
): void {
  removeTranslation(block.element);

  if (!translatedText || translatedText.trim() === '') {
    return;
  }

  // 若父级祖先已经存在完成的双语译文框 (.translate-king-wrapper.translate-king-done)，绝不在子级重复注入第二条相同译文！
  if (
    mode === 'bilingual' &&
    block.element.parentElement &&
    typeof block.element.parentElement.closest === 'function'
  ) {
    const ancestorTranslated = block.element.parentElement.closest('[data-tk-translated="true"]');
    if (ancestorTranslated && ancestorTranslated.querySelector('.translate-king-wrapper.translate-king-done')) {
      return;
    }
  }

  // 若译文与原文完全相同（例如原帖本身即为中文、或者纯英文专有名词），不挂载冗余重复条目
  if (translatedText.trim() === block.originalText.trim()) {
    return;
  }

  const el = block.element;
  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);

  // ========================================================
  // 模式 1：0基础英语 · 纯中文原地直接替换模式 (像谷歌翻译一样无感)
  // ========================================================
  if (mode === 'replace') {
    el.classList.remove('translate-king-replacing-pulse');
    if (translatedText.includes('\n')) {
      el.setAttribute('data-tk-multiline', 'true');
    }

    // 核心分支 A：若当前块包含行内超链接/加粗/引用等子元素，采用 DOM 片段重构机制
    // 彻底解决段落翻译时 <a> 超链接被掏空、[1] 引用变成纯文本的重大缺陷！
    if (block.inlineElements && block.inlineElements.length > 0 && doc) {
      if (!savedOriginalNodesMap.has(el)) {
        savedOriginalNodesMap.set(
          el,
          Array.from(el.childNodes).map((n) => n.cloneNode(true))
        );
      }
      if (!el.hasAttribute('data-tk-orig-html')) {
        el.setAttribute('data-tk-orig-html', el.innerHTML);
      }
      if (!el.hasAttribute('data-tk-orig-text')) {
        el.setAttribute('data-tk-orig-text', block.originalText);
      }
      const fragment = reconstructFragmentFromPlaceholders(translatedText, block.inlineElements, doc);

      // 智能保留原段落的外层统一样式容器 (例如 YouTube #content-text 内部的 span.yt-core-attributed-string--white-space-pre-wrap 或 <strong>/<b>)
      const firstChildEl = el.firstElementChild as HTMLElement | null;
      const isFullWrapper =
        firstChildEl &&
        ['STRONG', 'B', 'EM', 'I', 'SPAN', 'FONT'].includes(firstChildEl.tagName) &&
        firstChildEl.textContent?.trim() === el.textContent?.trim();

      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
      if (isFullWrapper) {
        const wrapperTag = firstChildEl.cloneNode(false) as HTMLElement;
        wrapperTag.appendChild(fragment);
        el.appendChild(wrapperTag);
      } else {
        el.appendChild(fragment);
      }

      el.setAttribute('data-tk-trans-text', translatedText.replace(/<\/?x\d+[^>]*>/gi, ''));
      el.setAttribute('data-tk-replaced', 'true');
      return;
    }

    // 核心分支 B：普通文本块（无子行内元素）
    if (typeof el.querySelectorAll === 'function') {
      el.querySelectorAll('br').forEach((br) => br.setAttribute('data-tk-hidden-br', 'true'));
    }
    const textNodes = doc ? collectManagedTextNodes(el, doc) : [];

    if (textNodes.length > 0) {
      const primaryTextNode = textNodes[0];

      if (!el.hasAttribute('data-tk-orig-text')) {
        el.setAttribute('data-tk-orig-text', primaryTextNode.nodeValue || block.originalText);
      }
      primaryTextNode.nodeValue = translatedText;

      // 如果当前元素包含多个子文本节点（例如多行评论、Twitter 多 span 拼接的 Bio / 简介）：
      // 将后续的子文本节点清空为 ''，彻底杜绝多 span 拼接残留英文或尾部多余空行！
      if (textNodes.length > 1 && !el.hasAttribute('data-tk-extra-text')) {
        const extraData: string[] = [];
        for (let i = 1; i < textNodes.length; i++) {
          extraData.push(textNodes[i].nodeValue || '');
          textNodes[i].nodeValue = '';
        }
        el.setAttribute('data-tk-extra-text', JSON.stringify(extraData));
      }
    } else {
      if (!el.hasAttribute('data-tk-orig-text')) {
        el.setAttribute('data-tk-orig-text', block.originalText);
      }
      el.textContent = translatedText;
    }

    el.setAttribute('data-tk-trans-text', translatedText);

    // 同步翻译 aria-label（适配 Twitter 紧凑模式图标提示）
    if (el.hasAttribute('aria-label')) {
      const origAria = el.getAttribute('aria-label') || '';
      if (origAria.trim() === block.originalText.trim()) {
        if (!el.hasAttribute('data-tk-orig-aria')) {
          el.setAttribute('data-tk-orig-aria', origAria);
        }
        el.setAttribute('aria-label', translatedText);
      }
    }

    el.setAttribute('data-tk-replaced', 'true');
    return;
  }

  // ========================================================
  // 模式 2：有英语基础 · 双语对照伴读模式 (英文在上，中文在下)
  // ========================================================
  // 对于操作按钮，在双语模式下直接原地替换文本（避免在小按钮内塞入双行导致界面错位）
  // 核心保护：严禁使用 el.textContent 暴力抹除内部 DOM，必须定位文本节点安全更新，完整保留 SVG 图标与 React 事件绑定
  if (isInteractiveButton(el)) {
    if (!el.hasAttribute('data-tk-orig-text')) {
      el.setAttribute('data-tk-orig-text', block.originalText);
    }
    const textNodes = doc ? collectManagedTextNodes(el, doc) : [];
    if (textNodes.length > 0) {
      textNodes[0].nodeValue = translatedText;
      for (let i = 1; i < textNodes.length; i++) {
        textNodes[i].nodeValue = '';
      }
    } else {
      el.textContent = translatedText;
    }
    el.setAttribute('data-tk-trans-text', translatedText);
    el.setAttribute('data-tk-replaced', 'true');
    return;
  }

  if (!doc) return;

  const wrapper = doc.createElement('span');
  wrapper.className = 'translate-king-wrapper translate-king-done';
  wrapper.setAttribute('translate', 'no');

  // 防止点击/选中译文时触发外部父容器（如 X / Twitter 卡片、论坛主贴）的跳转
  wrapper.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const textNode = doc.createElement('span');
  textNode.className = 'translate-king-text';

  if (block.inlineElements && block.inlineElements.length > 0) {
    const fragment = reconstructFragmentFromPlaceholders(translatedText, block.inlineElements, doc);
    textNode.appendChild(fragment);
  } else {
    textNode.textContent = translatedText.replace(/<\/?x\d+[^>]*>/gi, '');
  }

  wrapper.appendChild(textNode);
  block.element.setAttribute('data-tk-translated', 'true');
  block.element.appendChild(wrapper);

  const rootNode = typeof block.element.getRootNode === 'function' ? block.element.getRootNode() : null;
  if (rootNode && (rootNode as any).host && typeof (rootNode as any).getElementById === 'function') {
    ensureShadowStyles(rootNode as ShadowRoot);
  }
}

/**
 * 全局清空所有已注入的译文容器，恢复 100% 纯净原文
 */
export function clearAllTranslations(root: ParentNode = document): void {
  const allRoots = collectAllRoots(root);
  for (const r of allRoots) {
    // 1. 清除双语容器
    const allWrappers = r.querySelectorAll('.translate-king-wrapper');
    allWrappers.forEach((node) => node.remove());

    // 2. 还原直接替换过的文本
    const allReplaced = r.querySelectorAll('[data-tk-replaced]');
    allReplaced.forEach((el) => {
      removeTranslation(el as HTMLElement);
    });

    // 3. 清理标记
    const allTagged = r.querySelectorAll('[data-tk-id], [data-tk-loading], [data-tk-translated]');
    allTagged.forEach((node) => {
      node.removeAttribute('data-tk-id');
      node.removeAttribute('data-tk-loading');
      node.removeAttribute('data-tk-translated');
    });

    // 4. 清理 shadow style
    if ((r as any).host && typeof (r as any).getElementById === 'function') {
      (r as ShadowRoot).getElementById('translate-king-shadow-styles')?.remove();
    }
  }
}
