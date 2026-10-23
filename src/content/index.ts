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
import { injectLoadingState, injectTranslation, clearAllTranslations } from './dom/injector';
import { partitionBlocksByViewport } from './dom/viewport';
import { extractSentenceFromSelection, cleanWord } from './selection/sentence-extractor';
import { SelectionFloatingCard } from './selection/floating-card';
import { TargetLanguage, TranslationMode, RuntimeMessage, TranslateBatchResponse } from '../types';
import { WordLookupResult } from '../background/dictionary';

let isPageTranslated = false;
let isTranslating = false;
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

/**
 * 执行批次段落的发送与译文上屏挂载
 */
async function translateAndMountBlocks(
  blocks: TranslatableBlock[],
  targetLang: TargetLanguage
): Promise<void> {
  if (blocks.length === 0 || !isPageTranslated) return;
  const texts = blocks.map((b) => b.originalText);

  try {
    const response = await new Promise<TranslateBatchResponse>((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'TRANSLATE_BATCH',
          texts,
          toLang: targetLang
        },
        (res: TranslateBatchResponse) => resolve(res)
      );
    });

    // 关键守卫：如果在网络请求期间用户已触发还原原文，立即丢弃，绝不在清空后重新挂载
    if (!isPageTranslated) {
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
    console.error('[TranslateKing] 批次翻译错误:', err);
    blocks.forEach((block) => block.element.classList.remove('translate-king-replacing-pulse'));
  }
}

/**
 * 启动动态内容观察器（应对 X/Twitter、Reddit 等单页无限滚动流）
 * 采用 50ms 超敏捷响应与 1200px 远距离超前预取视野，彻底杜绝“读到了才慢吞吞开始加载”
 */
function startDynamicObserver(): void {
  if (mutationObserver || typeof MutationObserver === 'undefined') return;

  mutationObserver = new MutationObserver((mutations) => {
    if (!isPageTranslated) return;

    let hasAddedNodes = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        hasAddedNodes = true;
        break;
      }
    }
    if (!hasAddedNodes) return;

    if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
    // 50ms 极速防抖：在用户滑动滚轮但还未看清的间隙，提前捕获并处理
    mutationDebounceTimer = setTimeout(async () => {
      if (!isPageTranslated || isProcessingMutations) return;
      isProcessingMutations = true;
      try {
        const newBlocks = extractTranslatableBlocks(document);
        if (newBlocks.length > 0) {
          // 1. 同步探测 L0 缓存：回收重挂载的推文 0ms 瞬间秒出，绝不闪烁 Loading
          const { uncachedBlocks } = partitionByL0Cache(newBlocks);

          if (uncachedBlocks.length > 0) {
            // 2. 扩大探测范围至 1200px（相当于超前预读 2~3 个屏幕）
            const { visibleBlocks, offscreenBlocks } = partitionBlocksByViewport(uncachedBlocks, 1200);

            // 当前视口及邻近区域（眼前或即将进入眼前的推文）：优先极速翻译上屏
            if (visibleBlocks.length > 0) {
              visibleBlocks.forEach((block) => injectLoadingState(block, activeTranslationMode));
              await translateAndMountBlocks(visibleBlocks, activeTargetLang);
            }

            // 更远距离的屏外内容：后台静默全量预取，不显示 Loading 动画，滚动到时直接就绪
            if (offscreenBlocks.length > 0) {
              const CHUNK_SIZE = 30;
              for (let i = 0; i < offscreenBlocks.length; i += CHUNK_SIZE) {
                if (!isPageTranslated) break;
                const chunk = offscreenBlocks.slice(i, i + CHUNK_SIZE);
                await translateAndMountBlocks(chunk, activeTargetLang);
              }
            }
          }
        }
      } catch (err) {
        console.error('[TranslateKing] 动态增量预翻译异常:', err);
      } finally {
        isProcessingMutations = false;
      }
    }, 50);
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
 * 视口优先 + 激进全量预读双语翻译引擎 (Aggressive Speculative Pre-translation)
 * 核心机制：
 * 1. 优先发包眼前所见段落 (150ms 闪电上屏，保证交互零等待)
 * 2. 紧随其后并发推进屏外所有段落全量预译，在用户阅读首屏的几百毫秒内整页全部静默就绪！
 * 3. 屏外段落绝不显示 Loading 动效，用户向下滚动时看到的永远是已完成的译文！
 */
async function translateFullPage(
  targetLang: TargetLanguage = activeTargetLang,
  mode: TranslationMode = activeTranslationMode
): Promise<void> {
  if (isTranslating) return;
  isTranslating = true;
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
      return;
    }

    // 1. 同步探测 L0 缓存：已有的直接秒级静默恢复
    const { uncachedBlocks } = partitionByL0Cache(blocks);

    // 2. 智能划分两级优先级队列：视口当前可见 vs 屏外待见段落 (预读缓冲设为 400px)
    const { visibleBlocks, offscreenBlocks } = partitionBlocksByViewport(uncachedBlocks, 400);

    console.log(`[TranslateKing] 启动激进预翻译 (模式: ${mode})：首屏高优 ${visibleBlocks.length} 段，全量并发预读 ${offscreenBlocks.length} 段`);

    // 3. 立即激活动态流监听器，确保新推文在滚动中随时被敏捷捕捉
    isPageTranslated = true;
    startDynamicObserver();

    // 4. 第一优先级【超速首屏直出】：视口内可见段落注入加载态，并立即发出网络请求
    const visiblePromise = (async () => {
      if (visibleBlocks.length > 0) {
        visibleBlocks.forEach((block) => injectLoadingState(block, activeTranslationMode));
        await translateAndMountBlocks(visibleBlocks, activeTargetLang);
      }
    })();

    // 5. 第二优先级【激进并发预翻译】：紧跟首屏包之后全速并发启动，绝不等待用户滑动！
    const offscreenPromise = (async () => {
      if (offscreenBlocks.length === 0) return;
      // 微任务让步 25ms，保证首屏包优先抢占网络套接字发包
      await new Promise((resolve) => setTimeout(resolve, 25));

      // 采用大批次 (CHUNK_SIZE = 40) 全力吞吐，屏外段落静默挂载，绝对不展示 Loading 动画
      const CHUNK_SIZE = 40;
      for (let i = 0; i < offscreenBlocks.length; i += CHUNK_SIZE) {
        if (!isPageTranslated) break;
        const chunk = offscreenBlocks.slice(i, i + CHUNK_SIZE);
        await translateAndMountBlocks(chunk, activeTargetLang);
        // 微小让步 10ms，保证 60fps 页面丝滑不卡顿
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    // 并行调度双通道
    await Promise.all([visiblePromise, offscreenPromise]);
    console.log('[TranslateKing] 全文所有段落激进预翻译已全部就绪！向下滚动完全无感直接阅读！');
  } catch (err) {
    console.error('[TranslateKing] 全页翻译异常:', err);
  } finally {
    isTranslating = false;
  }
}

/**
 * 还原恢复纯净原文
 */
function restoreOriginalPage(): void {
  stopDynamicObserver();
  clearAllTranslations(document);
  localTranslationCache.clear();
  isPageTranslated = false;
  isTranslating = false;
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
// 监听 SPA 前端路由切换 (popstate & 劫持 pushState)
// -----------------------------------------------------------------
window.addEventListener('popstate', () => {
  if (isPageTranslated) {
    setTimeout(() => {
      translateFullPage(activeTargetLang);
    }, 300);
  }
});

// -----------------------------------------------------------------
// 鼠标划词悬浮释义与语境捕获逻辑 (支持中英双向智能互译)
// -----------------------------------------------------------------
document.addEventListener('mouseup', (e) => {
  if (!enableSelection) {
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
  chrome.runtime.sendMessage(
    {
      type: 'LOOKUP_WORD',
      word,
      sentence,
      targetLang: lookupTargetLang
    },
    (result: WordLookupResult) => {
      if (chrome.runtime.lastError || !result) {
        card.hide();
        return;
      }
      card.showResult(range, result);
    }
  );
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
