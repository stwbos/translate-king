/**
 * 翻译王 (TranslateKing) - 译文渲染器 (支持双语对照与纯中文原地直接替换模式)
 */

import { TranslatableBlock } from './extractor';
import { TranslationMode } from '../../types';

const SHOW_TEXT_FILTER = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;

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
 * 递归收集所有非空文本节点（用于精准替换多 span 拼接的段落/Bio）
 */
function findAllNonEmptyTextNodes(root: Node, doc: Document): Text[] {
  if (typeof doc.createTreeWalker !== 'function') return [];
  const nodes: Text[] = [];
  try {
    const walker = doc.createTreeWalker(root, SHOW_TEXT_FILTER);
    let current: Text | null = null;
    while ((current = walker.nextNode() as Text | null)) {
      if (current.nodeValue && current.nodeValue.trim().length > 0) {
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

  // 2. 移除替换模式动效类
  element.classList.remove('translate-king-replacing-pulse');

  // 3. 恢复直接替换模式的原始文本
  if (element.hasAttribute('data-tk-orig-html')) {
    element.innerHTML = element.getAttribute('data-tk-orig-html') || '';
    element.removeAttribute('data-tk-orig-html');
  } else if (element.hasAttribute('data-tk-orig-text')) {
    const orig = element.getAttribute('data-tk-orig-text');
    if (orig !== null) {
      const doc = element.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (doc) {
        // 先还原后续多 span 的 extraText
        if (element.hasAttribute('data-tk-extra-text')) {
          try {
            const extraData = JSON.parse(element.getAttribute('data-tk-extra-text') || '[]') as string[];
            const allTextNodes: Text[] = [];
            const walker = doc.createTreeWalker(element, SHOW_TEXT_FILTER);
            let curr: Text | null = null;
            while ((curr = walker.nextNode() as Text | null)) {
              allTextNodes.push(curr);
            }
            for (let i = 0; i < extraData.length && i + 1 < allTextNodes.length; i++) {
              allTextNodes[i + 1].nodeValue = extraData[i];
            }
          } catch {
            // ignore
          }
          element.removeAttribute('data-tk-extra-text');
        }

        const primaryTextNode = findPrimaryTextNode(element, doc);
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
  // 核心守卫：已翻译替换过的元素绝对不再注入任何加载态或脉冲动效，彻底保持静止
  if (
    block.element.hasAttribute('data-tk-replaced') ||
    (typeof block.element.closest === 'function' && block.element.closest('[data-tk-replaced]'))
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
  block.element.appendChild(wrapper);

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

    // 核心分支 A：若当前块包含行内超链接/加粗/引用等子元素，采用 DOM 片段重构机制
    // 彻底解决段落翻译时 <a> 超链接被掏空、[1] 引用变成纯文本的重大缺陷！
    if (block.inlineElements && block.inlineElements.length > 0 && doc) {
      if (!el.hasAttribute('data-tk-orig-html')) {
        el.setAttribute('data-tk-orig-html', el.innerHTML);
      }
      const fragment = reconstructFragmentFromPlaceholders(translatedText, block.inlineElements, doc);

      // 智能保留原段落的外层统一样式容器 (例如段落全部文字被 <strong> 或 <b> 包裹时，保留加粗外壳)
      const firstChildEl = el.firstElementChild as HTMLElement | null;
      const isFullWrapper =
        firstChildEl &&
        ['STRONG', 'B', 'EM', 'I'].includes(firstChildEl.tagName) &&
        firstChildEl.textContent?.trim() === el.textContent?.trim();

      el.innerHTML = '';
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
    const textNodes = doc ? findAllNonEmptyTextNodes(el, doc) : [];

    if (textNodes.length > 0) {
      const primaryTextNode = textNodes[0];

      if (!el.hasAttribute('data-tk-orig-text')) {
        el.setAttribute('data-tk-orig-text', primaryTextNode.nodeValue || block.originalText);
      }
      primaryTextNode.nodeValue = translatedText;

      // 如果当前元素包含多个子文本节点（例如 Twitter 多 span 拼接的 Bio / 简介 / 混合链接）：
      // 将后续的子文本节点清空为 ''，彻底杜绝多 span 拼接残留英文！
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
  // 在双语模式下，对于尺寸狭小的操作按钮不强行挂载多行双语，避免界面布局错位
  if (isInteractiveButton(el)) {
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
  block.element.appendChild(wrapper);
}

/**
 * 全局清空所有已注入的译文容器，恢复 100% 纯净原文
 */
export function clearAllTranslations(root: ParentNode = document): void {
  // 1. 清除双语容器
  const allWrappers = root.querySelectorAll('.translate-king-wrapper');
  allWrappers.forEach((node) => node.remove());

  // 2. 还原直接替换过的文本
  const allReplaced = root.querySelectorAll('[data-tk-replaced]');
  allReplaced.forEach((el) => {
    const htmlEl = el as HTMLElement;
    htmlEl.classList.remove('translate-king-replacing-pulse');

    if (htmlEl.hasAttribute('data-tk-orig-html')) {
      htmlEl.innerHTML = htmlEl.getAttribute('data-tk-orig-html') || '';
      htmlEl.removeAttribute('data-tk-orig-html');
    } else if (htmlEl.hasAttribute('data-tk-orig-text')) {
      const orig = htmlEl.getAttribute('data-tk-orig-text');
      if (orig !== null) {
        const doc = htmlEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (doc) {
          if (htmlEl.hasAttribute('data-tk-extra-text')) {
            try {
              const extraData = JSON.parse(htmlEl.getAttribute('data-tk-extra-text') || '[]') as string[];
              const allTextNodes: Text[] = [];
              const walker = doc.createTreeWalker(htmlEl, SHOW_TEXT_FILTER);
              let curr: Text | null = null;
              while ((curr = walker.nextNode() as Text | null)) {
                allTextNodes.push(curr);
              }
              for (let i = 0; i < extraData.length && i + 1 < allTextNodes.length; i++) {
                allTextNodes[i + 1].nodeValue = extraData[i];
              }
            } catch {
              // ignore
            }
            htmlEl.removeAttribute('data-tk-extra-text');
          }

          const primaryTextNode = findPrimaryTextNode(htmlEl, doc);
          if (primaryTextNode) {
            primaryTextNode.nodeValue = orig;
          } else {
            htmlEl.textContent = orig;
          }
        } else {
          htmlEl.textContent = orig;
        }
      }
      htmlEl.removeAttribute('data-tk-orig-text');
    }
    htmlEl.removeAttribute('data-tk-replaced');
  });

  // 3. 清理标记
  const allTagged = root.querySelectorAll('[data-tk-id]');
  allTagged.forEach((node) => node.removeAttribute('data-tk-id'));
}
