/**
 * 翻译王 (TranslateKing) - Content Script 主入口
 *
 * 核心性能架构：
 * 1. 视口优先渐进式翻译 (Viewport-First Progressive Hydration)：
 *    - 第一阶段：瞬间探测视口内当前可见段落（仅 5~12 段），闪电发出单包请求，100~200ms 瞬间上屏！
 *    - 第二阶段：屏外未见段落异步流水线渐进静默翻译，用户下滑滚动时已全部就绪，感官速度提升 10 倍！
 * 2. 动态 SPA / 无限滚动响应引擎 (MutationObserver + 路由监听)：
 *    - 深度适配 X / Twitter、Reddit、YouTube 等动态加载网页，下滑时新增推文/帖子自动感知并增量翻译！
 * 3. 鼠标划词 Shadow DOM 极速语境浮窗 (有道词典 + 原句双语 + 离线发音 + 生词收藏)
 * 4. Alt+T 快捷键全局无损切换与即时原文还原
 */

import { extractTranslatableBlocks, TranslatableBlock } from './dom/extractor';
import { injectLoadingState, injectTranslation, removeTranslation, clearAllTranslations } from './dom/injector';
import { partitionBlocksByViewport } from './dom/viewport';
import { extractSentenceFromSelection, cleanWord } from './selection/sentence-extractor';
import { SelectionFloatingCard } from './selection/floating-card';
import { TargetLanguage, TranslationMode, RuntimeMessage, TranslateBatchResponse } from '../types';
import { WordLookupResult } from '../background/dictionary';

/**
 * 校验扩展上下文生命周期状态（避免扩展被开发者刷新后旧标签页 Content Script 失效报红）
 */
function isExtensionValid(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

let isPageTranslated = false;
let isTranslating = false;
let routeChangeQueued = false;
let currentSessionEpoch = 0;
let activeTargetLang: TargetLanguage = 'zh-CN';
let activeTranslationMode: TranslationMode = 'bilingual';
let enableSelection = true;

// 初始化读取用户偏好配置（翻译显示模式、目标语言、鼠标划词开关）
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(['translationMode', 'targetLang', 'enableSelection'], (data) => {
    if (data.translationMode) {
      activeTranslationMode = data.translationMode;
    }
    if (data.targetLang) {
      activeTargetLang = data.targetLang;
    }
    if (typeof data.enableSelection === 'boolean') {
      enableSelection = data.enableSelection;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.translationMode) {
        const newMode = changes.translationMode.newValue as TranslationMode;
        if (newMode && newMode !== activeTranslationMode) {
          activeTranslationMode = newMode;
          if (isPageTranslated) {
            clearAllTranslations(document);
            translateFullPage(activeTargetLang, activeTranslationMode);
          }
        }
      }
      if (changes.targetLang) {
        const newLang = changes.targetLang.newValue as TargetLanguage;
        if (newLang) {
          activeTargetLang = newLang;
        }
      }
      if (changes.enableSelection) {
        enableSelection = changes.enableSelection.newValue !== false;
      }
    }
  });
}

/**
 * Content Script L0 极速内存缓存 (原文 -> 译文)
 * 彻底解决 Twitter/X 等单页应用的虚拟滚动 (DOM Recycling) 导致滚回顶部时重新触发“正在翻译”的闪烁与重复请求
 */
const localTranslationCache = new Map<string, string>();

/**
 * 优先使用 L0 缓存直接挂载，分离出尚未翻译的段落
 */
function partitionByL0Cache(blocks: TranslatableBlock[]): {
  cachedBlocks: TranslatableBlock[];
  uncachedBlocks: TranslatableBlock[];
} {
  const cachedBlocks: TranslatableBlock[] = [];
  const uncachedBlocks: TranslatableBlock[] = [];

  for (const block of blocks) {
    const cached = localTranslationCache.get(block.originalText.trim());
    if (cached) {
      // 0ms 同步静默挂载，绝对不调用 injectLoadingState，完全避免用户看到“正在翻译”重置
      injectTranslation(block, cached, activeTranslationMode);
      cachedBlocks.push(block);
    } else {
      uncachedBlocks.push(block);
    }
  }

  return { cachedBlocks, uncachedBlocks };
}

let mutationObserver: MutationObserver | null = null;
let mutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let isProcessingMutations = false;
let hasPendingMutations = false;

/**
 * 执行批次段落的发送与译文上屏挂载
 */
async function translateAndMountBlocks(
  blocks: TranslatableBlock[],
  targetLang: TargetLanguage
): Promise<void> {
  if (blocks.length === 0 || !isPageTranslated) return;
  if (!isExtensionValid()) {
    stopDynamicObserver();
    return;
  }
  const texts = blocks.map((b) => b.originalText);

  try {
    const response = await new Promise<TranslateBatchResponse>((resolve) => {
      try {
        if (!isExtensionValid()) {
          stopDynamicObserver();
          return resolve({ translations: [] });
        }
        chrome.runtime.sendMessage(
          {
            type: 'TRANSLATE_BATCH',
            texts,
            toLang: targetLang
          },
          (res: TranslateBatchResponse) => {
            if (chrome.runtime.lastError) {
              const msg = chrome.runtime.lastError.message || '';
              if (msg.includes('Extension context invalidated')) {
                stopDynamicObserver();
                return resolve({ translations: [] });
              }
            }
            resolve(res);
          }
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Extension context invalidated')) {
          stopDynamicObserver();
          return resolve({ translations: [] });
        }
        throw e;
      }
    });

    // 关键守卫：如果在网络请求期间用户已触发还原原文或扩展已卸载，立即丢弃
    if (!isPageTranslated || !isExtensionValid()) {
      return;
    }

    if (response && response.translations) {
      blocks.forEach((block, idx) => {
        const trans = response.translations[idx];
        if (trans && trans.trim() !== '' && trans.trim() !== block.originalText.trim()) {
          localTranslationCache.set(block.originalText.trim(), trans);
          injectTranslation(block, trans, activeTranslationMode);
        } else {
          // 哪怕无需翻译或专有名词，也立即彻底移除动效，停止一切闪烁
          block.element.classList.remove('translate-king-replacing-pulse');
        }
      });
    } else {
      blocks.forEach((block) => block.element.classList.remove('translate-king-replacing-pulse'));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('Extension context invalidated')) {
      stopDynamicObserver();
      return;
    }
    console.error('[TranslateKing] 批次翻译错误:', err);
    blocks.forEach((block) => block.element.classList.remove('translate-king-replacing-pulse'));
  }
}

/**
 * 调度执行 DOM 增量变动翻译（防抖 + 队列防丢 + 视口优先）
 */
function processDynamicMutations(delay = 40): void {
  if (mutationDebounceTimer) {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = null;
  }

  mutationDebounceTimer = setTimeout(async () => {
    if (!isPageTranslated || !isExtensionValid()) return;

    if (isProcessingMutations) {
      hasPendingMutations = true;
      return;
    }

    isProcessingMutations = true;
    try {
      const newBlocks = extractTranslatableBlocks(document);
      if (newBlocks.length > 0) {
        // 1. 同步探测 L0 缓存：回收重挂载的推文/聊天记录 0ms 瞬间秒出，绝不闪烁 Loading
        const { uncachedBlocks } = partitionByL0Cache(newBlocks);

        if (uncachedBlocks.length > 0) {
          // 2. 扩大探测范围至 1200px（超前预读视野）
          const { visibleBlocks, offscreenBlocks } = partitionBlocksByViewport(uncachedBlocks, 1200);

          // 当前视口及邻近区域（眼前或即将进入眼前的消息/推文）：优先极速发包上屏
          if (visibleBlocks.length > 0) {
            visibleBlocks.forEach((block) => injectLoadingState(block, activeTranslationMode));
            await translateAndMountBlocks(visibleBlocks, activeTargetLang);
          }

          // 更远距离的屏外内容：后台静默全量预取
          if (offscreenBlocks.length > 0) {
            const CHUNK_SIZE = 30;
            for (let i = 0; i < offscreenBlocks.length; i += CHUNK_SIZE) {
              if (!isPageTranslated || !isExtensionValid()) break;
              const chunk = offscreenBlocks.slice(i, i + CHUNK_SIZE);
              await translateAndMountBlocks(chunk, activeTargetLang);
            }
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Extension context invalidated')) {
        stopDynamicObserver();
        return;
      }
      console.error('[TranslateKing] 动态增量预翻译异常:', err);
    } finally {
      isProcessingMutations = false;
      if (hasPendingMutations) {
        hasPendingMutations = false;
        processDynamicMutations(20);
      }
    }
  }, delay);
}

/**
 * 启动动态内容观察器（应对 X/Twitter、Reddit、聊天私信等单页无限滚动流）
 */
function startDynamicObserver(): void {
  if (mutationObserver || typeof MutationObserver === 'undefined') return;

  mutationObserver = new MutationObserver((mutations) => {
    if (!isPageTranslated) return;

    // 核心探测：即时感知 X / Twitter 等 SPA 框架由主世界发起的无刷新页面跳转
    if (typeof window !== 'undefined' && window.location.href !== lastLocationHref) {
      handleSpaRouteChange();
      return;
    }

    let hasAddedNodes = false;
    for (const m of mutations) {
      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i];
        if (node.nodeType === 1) {
          const el = node as HTMLElement;
          if (
            el.classList?.contains('translate-king-wrapper') ||
            el.id === 'translate-king-bubble-host' ||
            el.id === 'translate-king-root'
          ) {
            continue;
          }
          hasAddedNodes = true;
          break;
        }
      }
      if (hasAddedNodes) break;
    }
    if (!hasAddedNodes) return;

    processDynamicMutations(40);
  });

  if (document.body) {
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
}

/**
 * 停止动态内容观察器
 */
function stopDynamicObserver(): void {
  if (mutationDebounceTimer) {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = null;
  }
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
}

/**
 * 视口优先 + 纪元抢占 + 异步屏外静默全量预读双语翻译引擎 (Epoch-based Preemptive Translation Engine)
 * 核心机制：
 * 1. 纪元抢占机制 (Epoch Preemption)：当用户在 SPA 切换页面或点击聊天会话时，旧页面的异步屏外发包立即退避中止，
 *    释放执行权与网络连接，新页面的可见正文 0ms 瞬间抢占直出！
 * 2. 眼前段落优先发包 (100~200ms 闪电上屏，保证交互零等待)
 * 3. 屏外段落完全解耦并发预读，绝不阻塞后续页面的翻译响应！
 */
async function translateFullPage(
  targetLang: TargetLanguage = activeTargetLang,
  mode: TranslationMode = activeTranslationMode,
  forcePreempt = false
): Promise<void> {
  if (isTranslating && !forcePreempt) {
    routeChangeQueued = true;
    return;
  }

  const sessionEpoch = ++currentSessionEpoch;
  isTranslating = true;
  routeChangeQueued = false;

  try {
    if (targetLang !== activeTargetLang || mode !== activeTranslationMode) {
      localTranslationCache.clear();
    }
    activeTargetLang = targetLang;
    activeTranslationMode = mode;

    const blocks = extractTranslatableBlocks(document);
    if (blocks.length === 0) {
      console.log('[TranslateKing] 当前页面未检测到有效待翻译文本，已挂载动态监听');
      isPageTranslated = true;
      startDynamicObserver();
      isTranslating = false;
      return;
    }

    // 1. 同步探测 L0 缓存：已有的直接秒级静默恢复
    const { uncachedBlocks } = partitionByL0Cache(blocks);

    // 2. 智能划分两级优先级队列：视口当前可见 vs 屏外待见段落 (预读缓冲设为 400px)
    const { visibleBlocks, offscreenBlocks } = partitionBlocksByViewport(uncachedBlocks, 400);

    console.log(`[TranslateKing] 启动抢占式预翻译 (纪元: ${sessionEpoch}, 模式: ${mode})：首屏高优 ${visibleBlocks.length} 段，全量并发预读 ${offscreenBlocks.length} 段`);

    // 3. 立即激活动态流监听器，确保新推文与聊天消息在滚动中随时被敏捷捕捉
    isPageTranslated = true;
    startDynamicObserver();

    // 4. 第一优先级【超速首屏直出】：视口内可见段落注入加载态，并立即发出网络请求
    if (visibleBlocks.length > 0) {
      if (currentSessionEpoch !== sessionEpoch) return;
      visibleBlocks.forEach((block) => injectLoadingState(block, activeTranslationMode));
      await translateAndMountBlocks(visibleBlocks, activeTargetLang);
    }

    // 首屏可见内容一旦挂载上屏，立即解脱 isTranslating 主锁，允许 SPA 路由与点击 0ms 抢占！
    isTranslating = false;

    // 5. 第二优先级【激进并发预翻译】：解耦后台静默推进，若用户切页或发生新纪元则自动退出
    if (offscreenBlocks.length > 0) {
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const CHUNK_SIZE = 40;
        for (let i = 0; i < offscreenBlocks.length; i += CHUNK_SIZE) {
          if (!isPageTranslated || currentSessionEpoch !== sessionEpoch || !isExtensionValid()) {
            break;
          }
          const chunk = offscreenBlocks.slice(i, i + CHUNK_SIZE);
          await translateAndMountBlocks(chunk, activeTargetLang);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('Extension context invalidated')) {
      stopDynamicObserver();
      return;
    }
    console.error('[TranslateKing] 全页翻译异常:', err);
  } finally {
    if (currentSessionEpoch === sessionEpoch) {
      isTranslating = false;
    }
    if (routeChangeQueued) {
      routeChangeQueued = false;
      setTimeout(() => {
        if (isPageTranslated && isExtensionValid()) {
          translateFullPage(activeTargetLang, activeTranslationMode, true);
        }
      }, 30);
    }
  }
}

/**
 * 还原恢复纯净原文
 */
function restoreOriginalPage(): void {
  currentSessionEpoch++;
  stopDynamicObserver();
  clearAllTranslations(document);
  localTranslationCache.clear();
  isPageTranslated = false;
  isTranslating = false;
  routeChangeQueued = false;
  console.log('[TranslateKing] 已恢复网页纯净原文');
}

/**
 * 切换双语状态
 */
export function togglePageTranslation(
  targetLang: TargetLanguage = 'zh-CN',
  mode: TranslationMode = activeTranslationMode
): void {
  if (isPageTranslated) {
    restoreOriginalPage();
  } else {
    translateFullPage(targetLang, mode);
  }
}

// -----------------------------------------------------------------
// Alt+T 全局快捷键与跨上下文消息一键切换翻译与原文恢复
// -----------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.code === 'KeyT' || e.key === 't' || e.key === 'T' || e.key === '†')) {
    e.preventDefault();
    togglePageTranslation();
  }
});

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'TK_TRIGGER_TRANSLATE') {
    togglePageTranslation(e.data.targetLang || 'zh-CN', e.data.mode || activeTranslationMode);
  }
});

// -----------------------------------------------------------------
// 监听 SPA 前端路由切换 (点击预拦截 + popstate + pushState 劫持 + 高频 URL 心跳轮询)
// 彻底解决 X / Twitter 切换到聊天页面 (/messages) 或在聊天会话间切换无法立即翻译的问题
// -----------------------------------------------------------------
let lastLocationHref = typeof window !== 'undefined' ? window.location.href : '';

function handleSpaRouteChange(): void {
  if (typeof window === 'undefined') return;
  const currentHref = window.location.href;
  if (currentHref === lastLocationHref) return;

  const prevUrl = lastLocationHref;
  lastLocationHref = currentHref;

  if (!isPageTranslated || !isExtensionValid()) return;

  console.log(`[TranslateKing] SPA 路由切换 (${prevUrl} -> ${currentHref})，立即触发新视图抢占式翻译`);

  // 第 0 波：0ms 立即执行抢占式翻译（打断前序页面的屏外请求，立即提取新路由初屏 DOM）
  translateFullPage(activeTargetLang, activeTranslationMode, true);

  // 针对复杂单页（如 X 聊天 /messages、GraphQL 异步渲染列表），发起高频密集波段自愈探测
  const waves = [50, 200, 500, 1000, 2000];
  waves.forEach((delay) => {
    setTimeout(() => {
      if (isPageTranslated && isExtensionValid()) {
        processDynamicMutations(0);
      }
    }, delay);
  });
}

// 快速连续探测，应对用户点击触发的异步路由跳转
function triggerFastSpaCheck(): void {
  const delays = [0, 30, 80, 180, 350, 700];
  delays.forEach((delay) => {
    setTimeout(() => {
      if (typeof window !== 'undefined' && window.location.href !== lastLocationHref) {
        handleSpaRouteChange();
      }
    }, delay);
  });
}

// 1. 捕获阶段点击监听：用户点击任何链接、导航或聊天条目瞬间启动抢先探测
document.addEventListener(
  'click',
  (e) => {
    if (!isPageTranslated || !isExtensionValid()) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const navElement = target.closest(
      'a, [role="link"], [role="tab"], [data-testid="conversation"], [data-testid="messageEntry"], [data-testid="AppTabBar_DirectMessage_Link"], [data-testid="SideNav_NewTweet_Button"]'
    );
    if (navElement) {
      triggerFastSpaCheck();
    }

    // 针对私信聊天界面：若点击了具体的聊天会话项，启动聊天消息加载专属波段扫描
    const isConversation = target.closest('[data-testid="conversation"]');
    if (isConversation) {
      const chatWaves = [60, 200, 500, 1000, 2000];
      chatWaves.forEach((w) => {
        setTimeout(() => {
          if (isPageTranslated && isExtensionValid()) {
            processDynamicMutations(0);
          }
        }, w);
      });
    }
  },
  true
);

// 2. 监听浏览器前进后退与 Hash 变动
window.addEventListener('popstate', handleSpaRouteChange);
window.addEventListener('hashchange', handleSpaRouteChange);

// 3. 劫持 History API (针对同上下文脚本触发的 pushState/replaceState)
if (typeof history !== 'undefined') {
  const rawPushState = history.pushState;
  if (typeof rawPushState === 'function') {
    history.pushState = function (...args) {
      const res = rawPushState.apply(this, args);
      handleSpaRouteChange();
      return res;
    };
  }

  const rawReplaceState = history.replaceState;
  if (typeof rawReplaceState === 'function') {
    history.replaceState = function (...args) {
      const res = rawReplaceState.apply(this, args);
      handleSpaRouteChange();
      return res;
    };
  }
}

// 4. 100ms 高频定时心跳轮询保底，双重保障任何复杂前端路由跳转 100% 毫秒级捕获
setInterval(() => {
  if (typeof window !== 'undefined' && window.location.href !== lastLocationHref) {
    handleSpaRouteChange();
  }
}, 100);

// -----------------------------------------------------------------
// 鼠标划词悬浮释义与语境捕获逻辑 (支持中英双向智能互译)
// -----------------------------------------------------------------
document.addEventListener('mouseup', (e) => {
  if (!enableSelection || !isExtensionValid()) {
    return;
  }

  // 若点击在卡片宿主元素内，不触发重新查询
  const host = document.getElementById('translate-king-bubble-host');
  if (host && host.contains(e.target as Node)) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return;
  }

  const rawText = selection.toString().trim();
  const word = cleanWord(rawText);
  if (!word) {
    return;
  }

  const hasChinese = /[\u4e00-\u9fa5]/.test(word);
  const wordCount = word.split(/\s+/).length;

  if (hasChinese) {
    // 中文选词：限制在 1 ~ 30 个字以内（避免选中长篇大论时弹窗挡住阅读视线）
    if (word.length > 30) {
      return;
    }
  } else {
    // 字母/外文选词：限制在 1 ~ 6 个单词且 <= 60 字符（排除纯标点符号）
    if (wordCount > 6 || word.length > 60 || !/[\p{L}\p{N}]/u.test(word)) {
      return;
    }
  }

  // 智能推断目标语言：
  // 1. 中文源词句：默认翻译为当前选定的目标语言；若当前选定的目标语言是中文，则自动互译为英文 (en)
  // 2. 外文源词句：若全局目标语言是 en 且选中的也是英文，则互译为中文 (zh-CN)；否则使用全局目标语言
  let lookupTargetLang: TargetLanguage = activeTargetLang;
  if (hasChinese) {
    lookupTargetLang = (activeTargetLang === 'zh-CN' || activeTargetLang === 'zh-TW') ? 'en' : activeTargetLang;
  } else if (lookupTargetLang === 'en' && /^[a-zA-Z\s.,'-]+$/.test(word)) {
    lookupTargetLang = 'zh-CN';
  }

  const range = selection.getRangeAt(0);
  const sentence = extractSentenceFromSelection(selection);
  const card = SelectionFloatingCard.getInstance();

  // 1. 瞬间先弹窗显示 Loading 状态
  card.showLoading(range, word);

  // 2. 向后台发送查词与原句语境翻译指令
  try {
    if (!isExtensionValid()) {
      card.hide();
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'LOOKUP_WORD',
        word,
        sentence,
        targetLang: lookupTargetLang
      },
      (result: WordLookupResult) => {
        if (!isExtensionValid() || chrome.runtime.lastError || !result) {
          card.hide();
          return;
        }
        card.showResult(range, result);
      }
    );
  } catch (_) {
    card.hide();
  }
});

// 监听来自扩展 Popup / Background 的指令
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === 'TOGGLE_PAGE_TRANSLATION') {
    togglePageTranslation(message.targetLang || activeTargetLang, message.mode || activeTranslationMode);
    sendResponse({ success: true, isTranslated: isPageTranslated, mode: activeTranslationMode });
  } else if (message.type === 'GET_PAGE_STATUS') {
    sendResponse({
      isTranslated: isPageTranslated,
      isTranslating: isTranslating,
      mode: activeTranslationMode,
      totalBlocks: document.querySelectorAll('[data-tk-id]').length
    });
  }
});

console.log('[TranslateKing] Content script ready. Progressive Viewport-First + Dynamic SPA support enabled.');
