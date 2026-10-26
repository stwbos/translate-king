/**
 * 翻译王 (TranslateKing) - 网页正文段落与全量叶子节点智能提取引擎
 *
 * 核心设计目标：像谷歌翻译一样实现全网页 100% 无死角翻译覆盖，
 * 涵盖推文、文章、用户简介、人名音译、操作按钮、趋势话题、导航选项及标签页。
 */

import { shouldIgnoreElement, isValidTranslatableText, isElementEffectivelyTranslated } from './filter';

export interface TranslatableBlock {
  id: string;
  element: HTMLElement;
  originalText: string;
  inlineElements?: HTMLElement[];
}

const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'CODE', 'SUP', 'SUB']);

/**
 * 递归检索当前元素下第一层（顶层）行内格式化与超链接子元素
 * （用于在段落翻译中通过 <xN> 占位符完整保留 <a> 链接、<sup> 引用、<b> 加粗等）
 */
export function findTopLevelInlineElements(root: HTMLElement): HTMLElement[] {
  const results: HTMLElement[] = [];
  function traverse(node: Node) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) { // Node.ELEMENT_NODE
        const el = child as HTMLElement;
        // 如果该内联标签包裹了整个容器的全部文本（如整段被 <strong> 加粗），
        // 或者自身内部包含了子 <a> 链接且含有其他混合正文，则不能作为单一占位符，应深入遍历其内部真实子内联项
        const isEntireWrapper = el.textContent?.trim() === root.textContent?.trim();
        const nestedAnchor = el.querySelector('a');
        const hasMixedAnchor = el.tagName !== 'A' && nestedAnchor !== null && el.textContent?.trim() !== nestedAnchor.textContent?.trim();

        if (INLINE_TAGS.has(el.tagName) && !isEntireWrapper && !hasMixedAnchor) {
          results.push(el);
        } else {
          traverse(el);
        }
      }
    }
  }
  traverse(root);
  return results;
}

// 语义优先原子块（保持整段/推文/长句的完整语境，优先提取）
export const ATOMIC_BLOCK_SELECTORS = [
  // 1. 社交平台正文与推文核心 (最高优先级，完整段落)
  '[data-testid="tweetText"]',
  '[data-testid="UserDescription"]',
  '[data-testid="twitterArticleReadView"] p',
  '[data-testid="card.layoutLarge.detail"] div[dir="auto"]',
  '[data-testid="card.layoutSmall.detail"] div[dir="auto"]',
  'div[role="radio"] div[dir="auto"]',
  '[data-testid="pollChoice"]',
  '[data-testid="postText"]',
  '[data-testid="socialContext"]',
  'shreddit-post [slot="text-body"]',
  'shreddit-comment [slot="comment"]',
  '#content-text',

  // 2. X / Twitter 推荐卡片 (UserCell) 专用高精度抽取规则
  '[data-testid="UserCell"] [dir="auto"]',
  '[data-testid="UserCell"] [dir="ltr"]',
  '[data-testid="UserCell"] [data-testid="User-Name"] a',
  '[data-testid="UserCell"] [data-testid$="-follow"]',
  '[data-testid="UserCell"] [data-testid$="-unfollow"]',

  // 3. X / Twitter 私信与聊天消息 (Direct Messages & Conversations) 核心高精度提取
  '[data-testid="messageEntry"] [data-testid="tweetText"]',
  '[data-testid="messageEntry"] [dir="auto"]',
  '[data-testid="messageEntry"] [dir="ltr"]',
  '[data-testid="messageEntry"] [dir="rtl"]',
  '[data-testid="messageEntry"] [data-testid="messageText"]',
  '[data-testid="messageEntry"] [data-testid="message-bubble"]',
  '[data-testid="messageEntry"] span[data-text="true"]',
  '[data-testid="message-entry"] [dir="auto"]',
  '[data-testid="message-entry"] [dir="ltr"]',
  '[data-testid="conversation"] [dir="auto"]',
  '[data-testid="conversation"] [dir="ltr"]',
  'div[aria-label="Timeline: Messages"] div[dir="auto"]',
  'div[aria-label*="Messages"] [data-testid="messageEntry"]',
  'div[aria-label*="私信"] [data-testid="messageEntry"]',
  '[data-testid="DMConversationBody"] div[dir="auto"]',
  '[data-testid="DMDrawer"] div[dir="auto"]',
  'section[aria-label="Direct Messages"] div[dir="auto"]',
  'section[aria-label*="私信"] div[dir="auto"]',

  // 3. 标题与栏目名称 (如 "Who to follow", "Trends for you", "What's happening")
  '[role="heading"]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',

  // 4. 传统文章正文与排版结构
  'article p',
  'main p',
  'p',
  'blockquote',
  'figcaption',
  '.markdown-body p',
  '.entry-content p',

  // 5. 按钮与独立操作选项
  'button',
  '[data-testid$="-follow"]',
  '[data-testid$="-unfollow"]',
  '[data-testid="SideNav_NewTweet_Button"]',
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="tweetButtonInline"]',
  '[data-testid="tweetButton"]',
  'header[role="banner"] nav a',
  'header[role="banner"] [role="button"]',
  'nav[aria-label="Primary"] a',
  'nav[aria-label="Primary"] [role="button"]',
  'a.button',
  'a.btn',
  '.vector-toc-text > span:not(.vector-toc-numb)',
  '.mw-editsection a',
  '.reference-text a.external',
  '.reference-text a:not([href^="#cite_ref"])',
  'nav a:not(.vector-toc-link)',
  'a[role="tab"]'
];

// 保留 BLOCK_SELECTORS 供向后兼容及测试用例使用
export const BLOCK_SELECTORS = ATOMIC_BLOCK_SELECTORS;

// 常见复合块级容器选择器（包含这些子元素的容器不能作为叶子文本块）
const CHILD_BLOCK_SELECTOR = 'div, p, article, section, ul, ol, li, table, form, h1, h2, h3, h4, h5, h6, blockquote, button, [data-testid="tweetText"]';

let blockCounter = 0;

/**
 * 遍历 DOM 提取当前页面上承载语义的待翻译文本块
 * 采用“语义原子块优先 + 通用叶子文本容器兜底”策略，达到 Google 翻译同款 100% 覆盖率
 */
export function extractTranslatableBlocks(root: ParentNode = document): TranslatableBlock[] {
  const blocks: TranslatableBlock[] = [];
  const processedElements = new Set<HTMLElement>();

  // ---------------------------------------------------------
  // 阶段 1：提取语义优先的原子块 (Tweets, 文章段落, 标题, 按钮)
  // 分块合并查询（每块 6 个选择器），杜绝任何浏览器对单个 CSS 选择器字符串长度的限制（如 2048 字符溢出）
  // ---------------------------------------------------------
  const CHUNK_SIZE = 6;
  for (let i = 0; i < ATOMIC_BLOCK_SELECTORS.length; i += CHUNK_SIZE) {
    const chunkSelector = ATOMIC_BLOCK_SELECTORS.slice(i, i + CHUNK_SIZE).join(',');
    try {
      const atomicElements = root.querySelectorAll<HTMLElement>(chunkSelector);
      for (let j = 0; j < atomicElements.length; j++) {
        processElement(atomicElements[j], blocks, processedElements);
      }
    } catch {
      // 容错降级
    }
  }

  // ---------------------------------------------------------
  // 阶段 2：通用叶子文本容器兜底扫描 (实现 Google 翻译的全面覆盖)
  // 捕获所有不在原子选择器中的简介、趋势话题、人名、社交说明、标签页
  // ---------------------------------------------------------
  const candidateLeafs = Array.from(
    root.querySelectorAll<HTMLElement>(
      'div, li, td, th, dt, dd, a, span'
    )
  );

  for (const el of candidateLeafs) {
    if (processedElements.has(el)) continue;
    if (isElementEffectivelyTranslated(el)) continue;
    if (shouldIgnoreElement(el)) continue;

    // 若 el 内部包含其他块级容器或已标记/翻译的子块，则说明它是外层布局容器，绝不能整体提取
    if (
      typeof el.querySelector === 'function' &&
      (el.querySelector(CHILD_BLOCK_SELECTOR) || el.querySelector('.translate-king-wrapper, [data-tk-replaced]'))
    ) {
      continue;
    }

    // 若 el 是 span 或 a，且其直接父级 div/li 也是叶子容器，则跳过子级，让父级整体提取整句
    if (
      (el.tagName === 'SPAN' || el.tagName === 'A') &&
      el.parentElement &&
      typeof el.parentElement.querySelector === 'function' &&
      !el.parentElement.querySelector(CHILD_BLOCK_SELECTOR) &&
      !el.parentElement.querySelector('.translate-king-wrapper, [data-tk-replaced]')
    ) {
      continue;
    }

    processElement(el, blocks, processedElements);
  }

  return blocks;
}

/**
 * 校验并挂载候选元素为待翻译块
 */
function processElement(
  el: HTMLElement,
  blocks: TranslatableBlock[],
  processedElements: Set<HTMLElement>
): void {
  if (processedElements.has(el)) return;
  if (isElementEffectivelyTranslated(el)) return;
  if (shouldIgnoreElement(el)) return;

  // 检查元素是否在文档树中有效（过滤 display: none 的不可见元素）
  // 在 Node/Vitest 测试环境中跳过 getClientRects 检查，因为 JSDOM 不包含 CSS 排版渲染引擎
  const isTestEnv = typeof process !== 'undefined' && (process.env?.VITEST || process.env?.NODE_ENV === 'test');
  if (
    !isTestEnv &&
    typeof el.getBoundingClientRect === 'function' &&
    typeof el.getClientRects === 'function'
  ) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && !el.getClientRects().length) {
      return;
    }
  }

  // 提取纯文本内容（忽略已挂载的译文容器，安全处理 Emoji 与内嵌样式脚本）
  const clone = el.cloneNode(true) as HTMLElement;
  if (typeof clone.querySelectorAll === 'function') {
    clone.querySelectorAll('.translate-king-wrapper, style, script, noscript').forEach((n) => n.remove());

    // 社交媒体适配：仅对真正的 Emoji 图标保留其 alt 字符，绝不将头像 (如 "Square头像") 或角标混入文本
    clone.querySelectorAll('img').forEach((img) => {
      const alt = (img as HTMLImageElement).alt || '';
      const src = (img as HTMLImageElement).src || '';
      const isEmoji =
        src.includes('/emoji/') ||
        src.includes('twemoji') ||
        img.classList.contains('r-4qtqp9') ||
        /\p{Emoji}/u.test(alt);
      if (isEmoji && alt && typeof (img as any).replaceWith === 'function') {
        (img as any).replaceWith(alt);
      } else {
        img.remove();
      }
    });
  }

  // 检查是否包含子超链接/加粗/引用等行内元素，若包含则执行占位符编码以保证译文 100% 保留超链接与样式
  const inlineElements = findTopLevelInlineElements(el);
  let rawText = '';

  if (inlineElements.length > 0) {
    const cloneInlines = findTopLevelInlineElements(clone);
    cloneInlines.forEach((childEl, idx) => {
      const childText = (childEl.textContent || '').trim();
      const doc = childEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (doc) {
        const placeholder = doc.createTextNode(`<x${idx}>${childText}</x${idx}>`);
        if (typeof (childEl as any).replaceWith === 'function') {
          (childEl as any).replaceWith(placeholder);
        }
      }
    });
    rawText = (clone.textContent || '').trim();
  } else {
    rawText = (clone.textContent || '').trim();
  }

  if (!isValidTranslatableText(rawText)) {
    return;
  }

  // 若当前元素是按钮内部的子文本容器（如 button > div > span），跳过，统一由外部 button 容器收录
  if (
    el.tagName !== 'BUTTON' &&
    typeof el.closest === 'function' &&
    el.closest('button, [data-testid$="-follow"], [data-testid$="-unfollow"]')
  ) {
    return;
  }

  // 严格防卫：任何含有嵌套卡片、子按钮、已标记/已替换子元素、或复杂组件的复合外层容器，绝不能作为单一片段收录
  if (
    typeof el.querySelector === 'function' &&
    (el.querySelector('[data-tk-id], [data-tk-replaced]') ||
      el.querySelector('button, [data-testid$="-follow"], [data-testid="UserCell"], [data-testid="tweet"], article') ||
      (el.querySelector('[data-testid="User-Name"]') && el.getAttribute('data-testid') !== 'User-Name') ||
      ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && rawText.length > 50))
  ) {
    return;
  }

  // 双向防重叠：避免父元素与子元素重叠（例如嵌套的 <li> 包含 <p>，或卡片嵌套子块）
  let hasOverlap = false;
  for (const b of blocks) {
    if (b.element.contains(el) || el.contains(b.element)) {
      hasOverlap = true;
      break;
    }
  }
  if (hasOverlap) return;

  const id = `tk-block-${++blockCounter}`;
  el.setAttribute('data-tk-id', id);

  blocks.push({
    id,
    element: el,
    originalText: rawText,
    inlineElements: inlineElements.length > 0 ? inlineElements : undefined
  });
  processedElements.add(el);
}
