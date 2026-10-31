/**
 * 翻译王 (TranslateKing) - 网页正文段落与全量叶子节点智能提取引擎
 *
 * 核心设计目标：像谷歌翻译一样实现全网页 100% 无死角翻译覆盖，
 * 涵盖推文、文章、用户简介、人名音译、操作按钮、趋势话题、导航选项及标签页。
 */

import {
  shouldIgnoreElement,
  isValidTranslatableText,
  isElementEffectivelyTranslated,
  isAlreadyInTargetLanguage
} from './filter';

export interface TranslatableBlock {
  id: string;
  element: HTMLElement;
  originalText: string;
  inlineElements?: HTMLElement[];
}

const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'CODE', 'SUP', 'SUB']);

function isInlineFormattingTag(el: HTMLElement): boolean {
  if (INLINE_TAGS.has(el.tagName)) return true;
  if (el.tagName === 'SPAN' && typeof el.className === 'string') {
    return (
      el.className.includes('attributed-string--bold') ||
      el.className.includes('attributed-string--italic') ||
      el.className.includes('attributed-string--strikethrough') ||
      el.className.includes('bili-rich-text-module') ||
      el.className.includes('jump-op')
    );
  }
  return false;
}

/**
 * 判断元素是否为保留原生换行符 (\n) 的评论/帖子/预格式化容器
 */
function isPreformattedOrCommentElement(el: HTMLElement): boolean {
  if (
    el.id === 'content-text' ||
    el.id === 'contents' ||
    el.tagName === 'YT-ATTRIBUTED-STRING' ||
    el.tagName === 'YT-FORMATTED-STRING' ||
    el.tagName === 'BILI-RICH-TEXT' ||
    el.classList?.contains('bili-rich-text__content') ||
    el.classList?.contains('update-components-text') ||
    el.classList?.contains('feed-shared-inline-show-more-text') ||
    el.querySelector?.('.yt-core-attributed-string--white-space-pre-wrap, [style*="pre-wrap"], [style*="pre-line"]')
  ) {
    return true;
  }
  if (
    typeof el.matches === 'function' &&
    el.matches(
      '#content-text, #contents, .bili-rich-text__content, .update-components-text, .feed-shared-inline-show-more-text, [class*="feed-shared-inline-show-more-text"], [data-testid="tweetText"], [data-testid="UserDescription"], [data-testid="messageText"], [data-testid="postText"], [slot="comment"], [slot="text-body"]'
    )
  ) {
    return true;
  }
  if (
    typeof el.closest === 'function' &&
    el.closest(
      '#content-text, .update-components-text, .feed-shared-inline-show-more-text, [data-testid="tweetText"], [data-testid="UserDescription"], [data-testid="messageEntry"], shreddit-comment, shreddit-post, bili-rich-text, bili-comment-renderer, bili-comment-thread-renderer'
    )
  ) {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const ws = window.getComputedStyle(el).whiteSpace;
      if (ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces') {
        return true;
      }
      const firstChild = el.firstElementChild as HTMLElement | null;
      if (firstChild) {
        const childWs = window.getComputedStyle(firstChild).whiteSpace;
        if (childWs === 'pre' || childWs === 'pre-wrap' || childWs === 'pre-line' || childWs === 'break-spaces') {
          return true;
        }
      }
    } catch {
      // ignore
    }
  }
  return false;
}

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

        if (isInlineFormattingTag(el) && !isEntireWrapper && !hasMixedAnchor) {
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

  // 1.1 Bilibili (哔哩哔哩) 评论区与动态富文本正文 (Shadow DOM 穿透精准匹配)
  '#contents',
  'p#contents',
  '#contents.bili-rich-text__content',
  '.bili-rich-text__content',
  'bili-rich-text #contents',
  'bili-rich-text',
  '.comment-content',
  '.reply-content',

  // 1.2 LinkedIn (领英) 全架构高容错正文、评论与动态提取规则 (覆盖 /feed/ 与 /feed/foryou/)
  '.feed-shared-update-v2 .update-components-text span[dir]',
  '.feed-shared-update-v2 .update-components-text > span',
  '.feed-shared-update-v2 .update-components-text span.break-words',
  '.occludable-update .update-components-text span[dir]',
  '.occludable-update .update-components-text > span',
  '.occludable-update span[dir]',
  '[data-view-name*="update"] .update-components-text span[dir]',
  '[data-view-name*="update"] span[dir]',
  '[data-id*="urn:li:activity"] .update-components-text span[dir]',
  '[data-id*="urn:li:activity"] span[dir]',
  '[data-urn*="activity"] span[dir]',
  '.update-components-text span[dir]',
  '.update-components-text > span',
  '.update-components-text span.break-words',
  '.update-components-text__text-view',
  '.update-components-text',
  '.feed-shared-inline-show-more-text span[dir]',
  '.feed-shared-inline-show-more-text > span',
  '.feed-shared-inline-show-more-text span.break-words',
  '.feed-shared-inline-show-more-text',
  '[class*="feed-shared-inline-show-more-text"] span[dir]',
  '[class*="feed-shared-inline-show-more-text"]',
  '.feed-shared-update-v2__commentary',
  '.feed-shared-update-v2__description',
  '.feed-shared-text-view',
  '.feed-shared-main-content',
  '.comments-comment-item-content-body span[dir]',
  '.comments-comment-item-content-body',
  '.comments-comment-item__main-content',
  '.comments-reply-item-content-body span[dir]',
  '.comments-reply-item-content-body',
  '.update-components-actor__description',
  '.update-components-actor__sub-description',
  '.update-components-actor__name',
  '.update-components-actor__title',
  '.feed-shared-actor__name',
  '.feed-shared-actor__description',
  '.feed-shared-actor__sub-description',
  '.update-components-header__text-view',
  '.update-components-article__title',
  '.update-components-article__description',
  '.feed-shared-article__title',
  '.feed-shared-article__description',
  '.update-components-mini-update-v2__title',
  '.feed-shared-poll',

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
 * 阶段 0.1：X / Twitter 私信聊天气泡 (Direct Messages) 高精度专属提取器
 * 穿透 React Native Web 复杂嵌套与按钮干扰，100% 提取气泡内的文本节点或正文容器
 */
function extractTwitterDmEntry(
  entry: HTMLElement,
  blocks: TranslatableBlock[],
  processedElements: Set<HTMLElement>
): void {
  if (processedElements.has(entry) || isElementEffectivelyTranslated(entry)) return;
  if (shouldIgnoreElement(entry)) return;

  // 严禁提取私信发信输入框与工具栏
  if (
    entry.closest?.('[data-testid="DMComposer"], [data-testid="dmComposerTextInput"], [role="textbox"]') ||
    entry.querySelector?.('[data-testid="DMComposerTextInput"]')
  ) {
    return;
  }

  // 1. 查找是否存在官方推文/文本标识
  const standardText = entry.querySelector<HTMLElement>('[data-testid="tweetText"], [data-testid="messageText"]');
  if (standardText && !processedElements.has(standardText) && !standardText.closest('button, time')) {
    processElement(standardText, blocks, processedElements);
    return;
  }

  // 2. 查找气泡内的 dir 容器 (dir="auto", dir="ltr", dir="rtl")
  // 排除属于动作按钮区 (<button>)、时间戳 (<time>) 或输入框的容器
  // 注意：绝不使用 cand.closest('[role="group"]') 或 cand.closest('[role="button"]')，因为 Twitter 消息行或 Touchable 气泡自身即挂载这些属性
  const dirCandidates = Array.from(entry.querySelectorAll<HTMLElement>('[dir="auto"], [dir="ltr"], [dir="rtl"]'));
  let foundDir = false;
  for (const cand of dirCandidates) {
    if (processedElements.has(cand)) continue;
    if (cand.closest('button, time, [data-testid*="avatar"], [data-testid="DMComposer"]')) continue;
    // 若 candidate 内部包含其他更深层的 dir 容器，让深层容器处理
    if (cand.querySelector('[dir="auto"], [dir="ltr"], [dir="rtl"]')) continue;

    const text = (cand.textContent || '').trim();
    if (isValidTranslatableText(text)) {
      processElement(cand, blocks, processedElements);
      foundDir = true;
    }
  }
  if (foundDir) return;

  // 3. 兜底扫描：若没有 dir 容器，寻找 entry 中承载文本的非按钮非时间叶子元素 (针对无 dir 属性的 React Native Web 气泡)
  const textLeaves = Array.from(entry.querySelectorAll<HTMLElement>('div, span'));
  for (const leaf of textLeaves) {
    if (processedElements.has(leaf)) continue;
    if (leaf.closest('button, time, [data-testid*="avatar"], [data-testid="DMComposer"]')) continue;
    if (leaf.querySelector('div, button, time, svg')) continue;

    const text = (leaf.textContent || '').trim();
    if (isValidTranslatableText(text)) {
      // 避免父级已收录时子级重复
      let parentHasBlock = false;
      let p: HTMLElement | null = leaf.parentElement;
      while (p && p !== entry) {
        if (processedElements.has(p)) {
          parentHasBlock = true;
          break;
        }
        p = p.parentElement;
      }
      if (!parentHasBlock) {
        processElement(leaf, blocks, processedElements);
      }
    }
  }
}

/**
 * 阶段 0.2：X / Twitter 私信对话列表 (Conversations) 高精度专属提取器
 */
function extractTwitterConversationRow(
  conv: HTMLElement,
  blocks: TranslatableBlock[],
  processedElements: Set<HTMLElement>
): void {
  if (processedElements.has(conv) || isElementEffectivelyTranslated(conv)) return;
  if (shouldIgnoreElement(conv)) return;

  // 1. 提取用户名
  const userNameEl = conv.querySelector<HTMLElement>('[data-testid="User-Name"]');
  if (userNameEl) {
    const nameCandidates = Array.from(userNameEl.querySelectorAll<HTMLElement>('[dir="auto"], [dir="ltr"], span'));
    for (const cand of nameCandidates) {
      if (processedElements.has(cand)) continue;
      if (cand.closest('time')) continue;
      if (cand.querySelector('span, div')) continue;
      processElement(cand, blocks, processedElements);
    }
  }

  // 2. 提取最后一条私信摘要预览文本 (位于 User-Name 之外)
  const allDirs = Array.from(conv.querySelectorAll<HTMLElement>('[dir="auto"], [dir="ltr"]'));
  let foundSnippet = false;
  for (const cand of allDirs) {
    if (processedElements.has(cand)) continue;
    if (cand.closest('[data-testid="User-Name"], time, button')) continue;
    if (cand.querySelector('[dir="auto"], [dir="ltr"]')) continue;
    processElement(cand, blocks, processedElements);
    foundSnippet = true;
  }

  // 3. 兜底：若没有 dir 容器，提取 User-Name 之外的叶子文本
  if (!foundSnippet) {
    const leaves = Array.from(conv.querySelectorAll<HTMLElement>('div, span'));
    for (const leaf of leaves) {
      if (processedElements.has(leaf)) continue;
      if (leaf.closest('[data-testid="User-Name"], time, button, [data-testid*="avatar"]')) continue;
      if (leaf.querySelector('div, span, button, time')) continue;
      const text = (leaf.textContent || '').trim();
      if (isValidTranslatableText(text)) {
        processElement(leaf, blocks, processedElements);
      }
    }
  }
}

/**
 * 递归收集指定根节点及其下所有 Web Components 的 open ShadowRoot
 * 确保对 Bilibili 评论区、Reddit 等复杂 Shadow DOM 架构进行 100% 穿透覆盖
 */
export function collectAllRoots(root: ParentNode = document): ParentNode[] {
  const roots: ParentNode[] = [root];
  const queue: ParentNode[] = [root];
  const seen = new Set<ParentNode>([root]);

  if ((root as any).shadowRoot && !seen.has((root as any).shadowRoot)) {
    const s = (root as any).shadowRoot as ShadowRoot;
    seen.add(s);
    roots.push(s);
    queue.push(s);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const elements = current.querySelectorAll('*');
      for (let i = 0; i < elements.length; i++) {
        const shadow = elements[i].shadowRoot;
        if (shadow && !seen.has(shadow)) {
          seen.add(shadow);
          roots.push(shadow);
          queue.push(shadow);
        }
      }
    } catch {
      // 容错降级
    }
  }

  return roots;
}

/**
 * 遍历 DOM 提取当前页面上承载语义的待翻译文本块
 * 采用“阶段0 Twitter私信专属引擎 + 阶段1 语义原子块优先 + 阶段2 通用叶子文本容器兜底”策略，达到 Google 翻译同款 100% 覆盖率
 */
export function extractTranslatableBlocks(
  root: ParentNode = document,
  targetLang?: string
): TranslatableBlock[] {
  const blocks: TranslatableBlock[] = [];
  const processedElements = new Set<HTMLElement>();
  const allRoots = collectAllRoots(root);

  for (const currentRoot of allRoots) {
    // ---------------------------------------------------------
    // 阶段 0：X / Twitter 私信聊天 (Direct Messages & Conversations) 专用高鲁棒性提取引擎
    // 覆盖全量消息容器：messageEntry、cellInnerDiv、DMConversation、DMChatTranscript、私信 Timeline
    // 针对 X 聊天界面 React Native Web 结构进行专用解析，100% 捕获气泡文本，彻底排除操作按钮与时间戳
    // ---------------------------------------------------------
    try {
      const chatCells = currentRoot.querySelectorAll<HTMLElement>(
        [
          '[data-testid="messageEntry"]',
          '[data-testid="message-entry"]',
          '[data-testid="DMConversation"] [data-testid="cellInnerDiv"]',
          '[data-testid="DMChatTranscript"] [data-testid="cellInnerDiv"]',
          '[data-testid="DMConversationBody"] [data-testid="cellInnerDiv"]',
          '[data-testid="DMDrawer"] [data-testid="cellInnerDiv"]',
          'div[aria-label*="Messages"] [data-testid="cellInnerDiv"]',
          'div[aria-label*="私信"] [data-testid="cellInnerDiv"]',
          'section[aria-label*="Messages"] [data-testid="cellInnerDiv"]',
          'section[aria-label*="私信"] [data-testid="cellInnerDiv"]',
          '[data-testid="DMConversation"] [role="row"]',
          '[data-testid="DMChatTranscript"] [role="row"]'
        ].join(',')
      );
      for (let i = 0; i < chatCells.length; i++) {
        extractTwitterDmEntry(chatCells[i], blocks, processedElements);
      }

      const conversationRows = currentRoot.querySelectorAll<HTMLElement>(
        '[data-testid="conversation"]'
      );
      for (let i = 0; i < conversationRows.length; i++) {
        extractTwitterConversationRow(conversationRows[i], blocks, processedElements);
      }
    } catch {
      // 容错降级
    }

    // ---------------------------------------------------------
    // 阶段 1：提取语义优先的原子块 (Tweets, Bilibili评论, 文章段落, 标题, 按钮)
    // 分块合并查询（每块 6 个选择器），杜绝任何浏览器对单个 CSS 选择器字符串长度的限制（如 2048 字符溢出）
    // ---------------------------------------------------------
    const CHUNK_SIZE = 6;
    for (let i = 0; i < ATOMIC_BLOCK_SELECTORS.length; i += CHUNK_SIZE) {
      const chunkSelector = ATOMIC_BLOCK_SELECTORS.slice(i, i + CHUNK_SIZE).join(',');
      try {
        const atomicElements = currentRoot.querySelectorAll<HTMLElement>(chunkSelector);
        for (let j = 0; j < atomicElements.length; j++) {
          processElement(atomicElements[j], blocks, processedElements, targetLang);
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
      currentRoot.querySelectorAll<HTMLElement>(
        'p, div, li, td, th, dt, dd, a, span'
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

      processElement(el, blocks, processedElements, targetLang);
    }
  }

  return blocks;
}

/**
 * 校验并挂载候选元素为待翻译块
 */
function processElement(
  el: HTMLElement,
  blocks: TranslatableBlock[],
  processedElements: Set<HTMLElement>,
  targetLang?: string
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
    clone.querySelectorAll(
      '.translate-king-wrapper, style, script, noscript, .visually-hidden, .sr-only, .feed-shared-inline-show-more-text__see-more-less-toggle, [class*="see-more"]'
    ).forEach((n) => n.remove());

    // 社交媒体适配：仅对真正的 Emoji 图标保留其 alt 字符，绝不将头像 (如 "Square头像") 或角标混入文本
    clone.querySelectorAll('img').forEach((img) => {
      const alt = (img as HTMLImageElement).alt || '';
      const src = (img as HTMLImageElement).src || '';
      const isEmoji =
        src.includes('/emoji/') ||
        src.includes('twemoji') ||
        src.includes('hdslb.com/bfs/emote') ||
        src.includes('garb/') ||
        img.classList.contains('bili-rich-text-emoji') ||
        img.classList.contains('r-4qtqp9') ||
        /\p{Emoji}/u.test(alt);
      if (isEmoji && alt && typeof (img as any).replaceWith === 'function') {
        (img as any).replaceWith(alt);
      } else {
        img.remove();
      }
    });

    // 将 <br> 换行标签显式转换为换行占位符 \uE000，防止 textContent 丢失网页/评论中的 <br> 换行排版
    clone.querySelectorAll('br').forEach((br) => {
      const next = br.nextSibling;
      if (next && next.nodeType === 3 && next.nodeValue) {
        next.nodeValue = next.nodeValue.replace(/^[ \t]*\r?\n[ \t]*/, '');
      }
      const prev = br.previousSibling;
      if (prev && prev.nodeType === 3 && prev.nodeValue) {
        prev.nodeValue = prev.nodeValue.replace(/[ \t]*\r?\n[ \t]*$/, '');
      }
      if (typeof (br as any).replaceWith === 'function') {
        (br as any).replaceWith('\uE000');
      }
    });
  }

  // 检查是否包含子超链接/加粗/引用等行内元素，若包含则执行占位符编码以保证译文 100% 保留超链接与样式
  const inlineElements = findTopLevelInlineElements(el);
  const preserveNativeNewlines = isPreformattedOrCommentElement(el);
  let rawText = '';

  if (inlineElements.length > 0) {
    const cloneInlines = findTopLevelInlineElements(clone);
    cloneInlines.forEach((childEl, idx) => {
      const childText = (childEl.textContent || '').replace(/\uE000/g, '\n').trim();
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

  if (preserveNativeNewlines) {
    rawText = rawText.replace(/\uE000/g, '\n').replace(/\r\n/g, '\n');
  } else {
    // 非预格式化容器：保留双换行段落间隔与 <br> (\uE000)，将 HTML 源码缩进单换行折叠为空格
    rawText = rawText
      .replace(/\r\n/g, '\n')
      .replace(/\n[ \t]*\n/g, '\uE000\uE000')
      .replace(/[ \t]*\n[ \t]*/g, ' ')
      .replace(/\uE000/g, '\n');
  }

  if (!isValidTranslatableText(rawText) || isAlreadyInTargetLanguage(rawText, targetLang)) {
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
      el.querySelector(
        'button:not(.feed-shared-inline-show-more-text__see-more-less-toggle):not([class*="see-more"]), [data-testid$="-follow"], [data-testid="UserCell"], [data-testid="tweet"], article'
      ) ||
      (el.querySelector('[data-testid="User-Name"]') && el.getAttribute('data-testid') !== 'User-Name') ||
      ((el.tagName === 'BUTTON' ||
        (el.getAttribute('role') === 'button' &&
          !el.closest(
            '[data-testid="messageEntry"], [data-testid="cellInnerDiv"], [data-testid="DMConversation"], [data-testid="DMChatTranscript"]'
          ))) &&
        rawText.length > 50))
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
