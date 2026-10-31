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

import { extractTranslatableBlocks, collectAllRoots, TranslatableBlock } from './dom/extractor';
import { injectLoadingState, injectTranslation, removeTranslation, clearAllTranslations } from './dom/injector';
import { partitionBlocksByViewport } from './dom/viewport';
import { extractSentenceFromSelection, cleanWord } from './selection/sentence-extractor';
import { SelectionFloatingCard } from './selection/floating-card';
import { TargetLanguage, TranslationMode, RuntimeMessage, TranslateBatchResponse } from '../types';
import { WordLookupResult } from '../background/dictionary';
import { setupYouTubeLifecycle } from './youtube';
import { setupBilibiliLifecycle } from './bilibili';
import { setupInteractiveShortcuts } from './input-translate';
import {
  setupFloatingBall,
  refreshFloatingBallVisual,
  applyWebTranslationTheme,
  WebTranslationTheme
} from './floating-ball';

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
let activeWebTheme: WebTranslationTheme = 'default';
let autoTranslateList: string[] = [];
let enableFloatingBall = true;
let enableSelection = true;

function mountOrUpdateFloatingBall(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // 悬浮球仅在顶层窗口挂载，避免在嵌入式 iframe 内部重复生成
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }
  setupFloatingBall({
    onToggleTranslate: () => togglePageTranslation(activeTargetLang, activeTranslationMode),
    onChangeMode: (mode) => {
      activeTranslationMode = mode;
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ translationMode: mode });
      }
      if (isPageTranslated) {
        clearAllTranslations(document);
        translateFullPage(activeTargetLang, activeTranslationMode, true);
      }
    },
    onChangeTheme: (theme) => {
      activeWebTheme = theme;
      applyWebTranslationTheme(theme);
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ webTheme: theme });
      }
    },
    onToggleAutoSite: (hostname, enabled) => {
      if (enabled) {
        if (!autoTranslateList.includes(hostname)) autoTranslateList.push(hostname);
        if (!isPageTranslated) {
          translateFullPage(activeTargetLang, activeTranslationMode, true);
        }
      } else {
        autoTranslateList = autoTranslateList.filter((h) => h !== hostname);
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ autoTranslateList });
      }
    },
    getState: () => ({
      isTranslated: isPageTranslated,
      mode: activeTranslationMode,
      theme: activeWebTheme,
      isAutoSite: autoTranslateList.includes(window.location.hostname || ''),
      enabled: enableFloatingBall
    })
  });
}

// 初始化读取用户偏好配置（翻译显示模式、目标语言、鼠标划词开关、悬浮球与自动翻译白名单）
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(
    ['translationMode', 'targetLang', 'enableSelection', 'webTheme', 'autoTranslateList', 'enableFloatingBall'],
    (data) => {
      if (data.translationMode) {
        activeTranslationMode = data.translationMode;
      }
      if (data.targetLang) {
        activeTargetLang = data.targetLang;
        setupYouTubeLifecycle(activeTargetLang);
        setupBilibiliLifecycle(activeTargetLang);
      }
      if (typeof data.enableSelection === 'boolean') {
        enableSelection = data.enableSelection;
      }
      if (data.webTheme) {
        activeWebTheme = data.webTheme;
        applyWebTranslationTheme(activeWebTheme);
      }
      if (Array.isArray(data.autoTranslateList)) {
        autoTranslateList = data.autoTranslateList;
        const host = typeof window !== 'undefined' ? window.location.hostname : '';
        if (host && autoTranslateList.includes(host) && !isPageTranslated) {
          setTimeout(() => translateFullPage(activeTargetLang, activeTranslationMode, true), 150);
        }
      }
      if (typeof data.enableFloatingBall === 'boolean') {
        enableFloatingBall = data.enableFloatingBall;
      }
      mountOrUpdateFloatingBall();
    }
  );

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
          setupYouTubeLifecycle(activeTargetLang);
          setupBilibiliLifecycle(activeTargetLang);
        }
      }
      if (changes.enableSelection) {
        enableSelection = changes.enableSelection.newValue !== false;
      }
      if (changes.webTheme) {
        activeWebTheme = changes.webTheme.newValue || 'default';
        applyWebTranslationTheme(activeWebTheme);
      }
      if (changes.enableFloatingBall) {
        enableFloatingBall = changes.enableFloatingBall.newValue !== false;
        mountOrUpdateFloatingBall();
      }
    }
  });
}

// 启动右侧快捷悬浮球
if (typeof document !== 'undefined') {
  if (document.body) {
    mountOrUpdateFloatingBall();
  } else {
    window.addEventListener('DOMContentLoaded', () => mountOrUpdateFloatingBall());
  }
}

// 启动 YouTube 与 Bilibili 实时双语字幕引擎监听 (无条件顶层常驻)
setupYouTubeLifecycle(activeTargetLang);
setupBilibiliLifecycle(activeTargetLang);

// 启动连按 3 次空格输入框翻译 & 按住 Alt 鼠标悬停单段即时翻译
setupInteractiveShortcuts(() => activeTargetLang);

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
let mutationDebounceFirstTime = 0;
let isProcessingMutations = false;
let processingMutationsStartTime = 0;
let hasPendingMutations = false;
let translatingStartTime = 0;

/**
 * 发送批次翻译指令，内建针对休眠 Service Worker 唤醒重试机制 (最多 2 次重试，退避 200ms)
 */
async function sendBatchMessageWithRetry(
  texts: string[],
  targetLang: TargetLanguage
): Promise<TranslateBatchResponse> {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!isExtensionValid() || !isPageTranslated) {
      return { translations: [] };
    }

    try {
      const result = await new Promise<TranslateBatchResponse>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            reject(new Error('BATCH_RESPONSE_TIMEOUT'));
          }
        }, 8000);

        try {
          chrome.runtime.sendMessage(
            {
              type: 'TRANSLATE_BATCH',
              texts,
              toLang: targetLang
            },
            (res: TranslateBatchResponse) => {
              if (done) return;
              done = true;
              clearTimeout(timer);

              if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message || '';
                if (msg.includes('Extension context invalidated')) {
                  stopDynamicObserver();
                  return resolve({ translations: [] });
                }
                reject(new Error(msg));
              } else {
                resolve(res || { translations: texts });
              }
            }
          );
        } catch (err) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Extension context invalidated')) {
              stopDynamicObserver();
              return resolve({ translations: [] });
            }
            reject(err);
          }
        }
      });

      if (result && Array.isArray(result.translations) && result.translations.length === texts.length) {
        return result;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('Extension context invalidated')) {
        stopDynamicObserver();
        return { translations: [] };
      }
      if (attempt < maxRetries) {
        // 给可能休眠刚被唤醒的 Service Worker 留出就绪时间
        await new Promise((r) => setTimeout(r, 200));
      } else {
        console.warn('[TranslateKing] 批次翻译网络响应重试耗尽，启用降级原文:', errMsg);
      }
    }
  }

  return { translations: texts };
}

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
    const response = await sendBatchMessageWithRetry(texts, targetLang);

    // 关键守卫：如果在网络请求期间用户已触发还原原文或扩展已卸载，立即丢弃
    if (!isPageTranslated || !isExtensionValid()) {
      return;
    }

    if (response && response.translations) {
      blocks.forEach((block, idx) => {
        const trans = response.translations[idx];
        const cleanTrans = trans ? trans.replace(/<\/?x\d+[^>]*>/gi, '').trim() : '';
        const cleanOrig = block.originalText.replace(/<\/?x\d+[^>]*>/gi, '').trim();
        if (trans && cleanTrans !== '' && cleanTrans !== cleanOrig) {
          localTranslationCache.set(block.originalText.trim(), trans);
          injectTranslation(block, trans, activeTranslationMode);
        } else {
          // 若无需翻译、专有名词、或译文与原文一致，必须彻底移除 Loading 占位框与脉冲动效！
          removeTranslation(block.element);
        }
      });
    } else {
      blocks.forEach((block) => removeTranslation(block.element));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('Extension context invalidated')) {
      stopDynamicObserver();
      return;
    }
    console.error('[TranslateKing] 批次翻译错误:', err);
    blocks.forEach((block) => removeTranslation(block.element));
  }
}

/**
 * 调度执行 DOM 增量变动翻译（防抖 + 最大延迟保护 + 队列防丢 + 视口优先）
 */
function processDynamicMutations(delay = 40): void {
  const now = Date.now();
  if (!mutationDebounceFirstTime) {
    mutationDebounceFirstTime = now;
  }

  // 最大延迟守卫：若防抖积压等待已超过 120ms，强制在下一微任务立即执行，绝不因 DOM 高频细碎变动无限推迟
  const effectiveDelay = now - mutationDebounceFirstTime > 120 && delay > 0 ? 0 : delay;

  if (mutationDebounceTimer) {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = null;
  }

  mutationDebounceTimer = setTimeout(async () => {
    mutationDebounceFirstTime = 0;
    if (!isPageTranslated || !isExtensionValid()) return;

    // 超时自愈守卫：若前序批次由于某些原因被挂起超过 8 秒，强制释放锁以恢复增量响应
    if (isProcessingMutations) {
      if (Date.now() - processingMutationsStartTime > 8000) {
        console.warn('[TranslateKing] 发现增量处理锁超时挂起，执行自动复位解脱');
        isProcessingMutations = false;
      } else {
        hasPendingMutations = true;
        return;
      }
    }

    isProcessingMutations = true;
    processingMutationsStartTime = Date.now();
    try {
      const newBlocks = extractTranslatableBlocks(document, activeTargetLang);
      if (newBlocks.length > 0) {
        // 1. 同步探测 L0 缓存：回收重挂载的推文/聊天记录 0ms 瞬间秒出，绝不闪烁 Loading
        const { uncachedBlocks } = partitionByL0Cache(newBlocks);

        if (uncachedBlocks.length > 0) {
          // 立即为所有待翻译块加盖队列锁，防止异步等待期间被 MutationObserver 二次重复扫描拆碎子节点！
          const nowStr = String(Date.now());
          uncachedBlocks.forEach((b) => b.element.setAttribute('data-tk-loading', nowStr));

          // 2. 扩大探测范围至 1200px（超前预读视野）
          const { visibleBlocks, offscreenBlocks } = partitionBlocksByViewport(uncachedBlocks, 1200);

          // 当前视口及邻近区域（眼前或即将进入眼前的消息/推文）：优先极速发包上屏
          if (visibleBlocks.length > 0) {
            visibleBlocks.forEach((block) => injectLoadingState(block, activeTranslationMode));
            await translateAndMountBlocks(visibleBlocks, activeTargetLang);
          }

          // 更远距离的屏外内容：后台异步全量预取，不霸占增量处理主锁
          if (offscreenBlocks.length > 0) {
            (async () => {
              const CHUNK_SIZE = 30;
              for (let i = 0; i < offscreenBlocks.length; i += CHUNK_SIZE) {
                if (!isPageTranslated || !isExtensionValid()) break;
                const chunk = offscreenBlocks.slice(i, i + CHUNK_SIZE);
                await translateAndMountBlocks(chunk, activeTargetLang);
                await new Promise((r) => setTimeout(r, 10));
              }
            })();
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

const observedShadowRoots = new Set<ShadowRoot>();
let scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;

function handlePassiveScroll(): void {
  if (!isPageTranslated || !isExtensionValid()) return;
  if (scrollThrottleTimer) return;
  scrollThrottleTimer = setTimeout(() => {
    scrollThrottleTimer = null;
    if (!isPageTranslated || !isExtensionValid()) return;
    // 检查是否有新挂载的 ShadowRoot (如 B站评论滚动到底部时新增的节点)
    if (typeof document !== 'undefined') {
      const allRoots = collectAllRoots(document);
      for (const r of allRoots) {
        if (r !== document && (r as any).host && mutationObserver) {
          const s = r as ShadowRoot;
          if (!observedShadowRoots.has(s)) {
            observedShadowRoots.add(s);
            try {
              mutationObserver.observe(s, { childList: true, subtree: true });
            } catch {}
          }
        }
      }
    }
    processDynamicMutations(30);
  }, 120);
}

/**
 * 启动动态内容观察器（应对 X/Twitter、Reddit、B站评论、聊天私信等单页无限滚动流）
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
    let isHighPriorityChat = false;
    for (const m of mutations) {
      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i];
        if (node.nodeType === 1) {
          const el = node as HTMLElement;
          if (
            el.classList?.contains('translate-king-wrapper') ||
            el.id === 'translate-king-bubble-host' ||
            el.id === 'translate-king-root' ||
            el.id?.startsWith('translate-king-') ||
            el.getAttribute?.('data-tk-ignore') === 'true'
          ) {
            continue;
          }
          hasAddedNodes = true;

          // 动态注册新产生的 ShadowRoot (如 B站楼层 <bili-comment-thread-renderer> 挂载)
          if (el.shadowRoot && !observedShadowRoots.has(el.shadowRoot)) {
            observedShadowRoots.add(el.shadowRoot);
            try {
              mutationObserver.observe(el.shadowRoot, { childList: true, subtree: true });
            } catch {}
          }
          if (typeof el.querySelectorAll === 'function') {
            const nested = el.querySelectorAll('*');
            for (let j = 0; j < nested.length; j++) {
              const sr = nested[j].shadowRoot;
              if (sr && !observedShadowRoots.has(sr)) {
                observedShadowRoots.add(sr);
                try {
                  mutationObserver.observe(sr, { childList: true, subtree: true });
                } catch {}
              }
            }
          }

          // 社交平台私信/聊天与动态流卡片高优判定 (X / Twitter + LinkedIn)
          if (
            el.getAttribute?.('data-testid') === 'messageEntry' ||
            el.getAttribute?.('data-testid') === 'conversation' ||
            el.getAttribute?.('data-testid') === 'cellInnerDiv' ||
            el.getAttribute?.('data-testid') === 'DMConversation' ||
            el.getAttribute?.('data-testid') === 'DMChatTranscript' ||
            el.classList?.contains('msg-s-event-listitem') ||
            el.classList?.contains('msg-overlay-conversation-bubble') ||
            el.classList?.contains('msg-thread') ||
            el.classList?.contains('feed-shared-update-v2') ||
            el.classList?.contains('occludable-update') ||
            (typeof el.querySelector === 'function' &&
              el.querySelector(
                '[data-testid="messageEntry"], [data-testid="conversation"], [data-testid="cellInnerDiv"], [data-testid="DMConversation"], .msg-s-event-listitem, .msg-thread, .feed-shared-update-v2, .occludable-update'
              ))
          ) {
            isHighPriorityChat = true;
            break;
          }
        }
      }
    }
    if (!hasAddedNodes) return;

    processDynamicMutations(isHighPriorityChat ? 10 : 40);
  });

  if (document.body) {
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // 观察当前文档树中已存在的全部 ShadowRoot (如 B站初始评论组件)
  if (typeof document !== 'undefined') {
    const initialRoots = collectAllRoots(document);
    for (const r of initialRoots) {
      if (r !== document && (r as any).host) {
        const shadow = r as ShadowRoot;
        if (!observedShadowRoots.has(shadow)) {
          observedShadowRoots.add(shadow);
          try {
            mutationObserver.observe(shadow, { childList: true, subtree: true });
          } catch {}
        }
      }
    }
  }

  // 注册全局被动滚动感知，在用户快速滚动列表或内部滚动容器 (如 LinkedIn scaffold-layout) 时增量自愈
  // 使用 capture: true 捕获内部不冒泡的滚动事件
  if (typeof window !== 'undefined') {
    window.addEventListener('scroll', handlePassiveScroll, { passive: true, capture: true });
  }
}

/**
 * 停止动态内容观察器
 */
function stopDynamicObserver(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', handlePassiveScroll, { capture: true } as any);
    window.removeEventListener('scroll', handlePassiveScroll);
  }
  if (scrollThrottleTimer) {
    clearTimeout(scrollThrottleTimer);
    scrollThrottleTimer = null;
  }
  observedShadowRoots.clear();

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
    if (Date.now() - translatingStartTime > 5000) {
      console.warn('[TranslateKing] 发现全页翻译主锁超时挂起，执行自动复位解脱');
      isTranslating = false;
    } else {
      routeChangeQueued = true;
      return;
    }
  }

  const sessionEpoch = ++currentSessionEpoch;
  isTranslating = true;
  translatingStartTime = Date.now();
  routeChangeQueued = false;

  try {
    if (targetLang !== activeTargetLang || mode !== activeTranslationMode) {
      localTranslationCache.clear();
    }
    activeTargetLang = targetLang;
    activeTranslationMode = mode;
    setupYouTubeLifecycle(activeTargetLang);
    setupBilibiliLifecycle(activeTargetLang);

    const blocks = extractTranslatableBlocks(document, activeTargetLang);
    if (blocks.length === 0) {
      console.log('[TranslateKing] 当前页面未检测到有效待翻译文本，已维持翻译就绪状态并挂载动态监听');
      isPageTranslated = true;
      startDynamicObserver();
      isTranslating = false;
      refreshFloatingBallVisual();
      return;
    }

    // 1. 同步探测 L0 缓存：已有的直接秒级静默恢复
    const { uncachedBlocks } = partitionByL0Cache(blocks);

    // 立即为所有待翻译块加盖队列锁，杜绝首屏请求期间 offscreen 块被 MutationObserver 重复提取或拆碎内联子节点
    const nowStr = String(Date.now());
    uncachedBlocks.forEach((b) => b.element.setAttribute('data-tk-loading', nowStr));

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

let lastToggleTimestamp = 0;

/**
 * 切换双语状态
 */
export function togglePageTranslation(
  targetLang: TargetLanguage = 'zh-CN',
  mode: TranslationMode = activeTranslationMode
): void {
  const now = Date.now();
  // 防抖保护：防止 Alt+T 快捷键在 DOM keydown 和 background chrome.commands 双重监听下发生同毫秒冲抵关停
  if (now - lastToggleTimestamp < 400) {
    console.warn('[TranslateKing] 忽略 400ms 内重复收到的切换指令（防止双重快捷键冲抵）');
    return;
  }
  lastToggleTimestamp = now;

  // 关键自愈校验：检查页面上当前是否确实存在生效中的译文节点
  const activeTranslationCount = typeof document !== 'undefined'
    ? document.querySelectorAll('.translate-king-wrapper.translate-king-done, [data-tk-replaced]').length
    : 0;

  // 如果页面当前处于翻译状态（或已有译文），点击则执行还原原文；否则开启全页翻译
  if (isPageTranslated || activeTranslationCount > 0) {
    if (targetLang && targetLang !== activeTargetLang) {
      restoreOriginalPage();
      translateFullPage(targetLang, mode, true);
    } else {
      restoreOriginalPage();
    }
  } else {
    isPageTranslated = false;
    isTranslating = false; // 强制解除任何陈旧挂起锁
    translateFullPage(targetLang, mode, true);
  }
  setTimeout(refreshFloatingBallVisual, 50);
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
  const waves = [30, 80, 160, 320, 600, 1200, 2000, 3500];
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
      'a, [role="link"], [role="tab"], [role="menuitem"], [data-testid="conversation"], [data-testid="messageEntry"], [data-testid="cellInnerDiv"], [data-testid="AppTabBar_DirectMessage_Link"], [data-testid="SideNav_NewTweet_Button"], .global-nav__primary-link, .artdeco-dropdown__item, .artdeco-dropdown__trigger, .msg-overlay-bubble-header, .msg-conversation-listitem, .feed-shared-control-menu__trigger'
    );
    if (navElement) {
      triggerFastSpaCheck();
    }

    // 针对私信聊天界面与导航：若点击了具体的聊天会话项或私信入口，启动聊天消息加载专属波段扫描
    const isChatTrigger = target.closest(
      '[data-testid="conversation"], [data-testid="messageEntry"], [data-testid="cellInnerDiv"], [data-testid="DMConversation"], [data-testid="DMChatTranscript"], [data-testid="AppTabBar_DirectMessage_Link"], a[href*="/messages"], a[href*="/messaging"], .msg-overlay-bubble-header, .msg-conversation-listitem, [aria-label*="私信"], [aria-label*="Messages" i], [aria-label*="消息" i]'
    );
    if (isChatTrigger) {
      const chatWaves = [25, 80, 160, 320, 600, 1200, 2000, 3500];
      chatWaves.forEach((w) => {
        setTimeout(() => {
          if (isPageTranslated && isExtensionValid()) {
            processDynamicMutations(0);
          }
        }, w);
      });
    }

    // 针对内容展开与动态流交互：如 LinkedIn "...see more" / 评论展开 / 展开更多
    const isExpandTrigger = target.closest(
      '.feed-shared-inline-show-more-text__see-more-less-toggle, button.see-more, button[class*="see-more"], button[aria-label*="more" i], button[aria-label*="展开" i], .feed-shared-control-menu'
    );
    if (isExpandTrigger) {
      // 找到对应的帖子容器，重置其翻译标记以便重新提取展开后的完整长文本
      const postCard = target.closest(
        '.feed-shared-update-v2, .occludable-update, [data-view-name*="update"], [data-id*="urn:li:activity"], .feed-shared-inline-show-more-text, .update-components-text'
      );
      if (postCard) {
        postCard.querySelectorAll('[data-tk-translated], [data-tk-replaced], [data-tk-id], .translate-king-wrapper').forEach((n) => {
          n.removeAttribute('data-tk-translated');
          n.removeAttribute('data-tk-replaced');
          n.removeAttribute('data-tk-id');
          if (n.classList.contains('translate-king-wrapper')) n.remove();
        });
      }
      const expandWaves = [30, 100, 250, 600];
      expandWaves.forEach((w) => {
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

export function triggerSelectionLookup(): void {
  if (!enableSelection || !isExtensionValid()) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const rawText = selection.toString().trim();
  if (!rawText) {
    return;
  }

  const word = cleanWord(rawText);
  if (!word) {
    return;
  }

  const hasChinese = /[\u4e00-\u9fa5]/.test(word);
  const wordCount = word.split(/\s+/).length;

  if (hasChinese) {
    // 中文选词：支持单字、成语至 50 字以内的短语短句
    if (word.length > 50) {
      return;
    }
  } else {
    // 字母/外文选词：支持生词、复合词组、聊天短句 (1 ~ 25 词且 <= 150 字符)
    if (wordCount > 25 || word.length > 150 || !/[\p{L}\p{N}]/u.test(word)) {
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

  let range: Range;
  try {
    range = selection.getRangeAt(0);
  } catch (_) {
    return;
  }

  let sentence = word;
  try {
    sentence = extractSentenceFromSelection(selection) || word;
  } catch (_) {
    sentence = word;
  }

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
}

// 监听 mouseup 事件：延时 40ms 确保浏览器选区与双击动作完全稳定
document.addEventListener('mouseup', (e) => {
  const host = document.getElementById('translate-king-bubble-host');
  if (host && host.contains(e.target as Node)) {
    return;
  }
  setTimeout(triggerSelectionLookup, 40);
});

// 监听 keyup 事件：支持 Shift + 方向键键盘划词
document.addEventListener('keyup', (e) => {
  if (e.key === 'Shift' || e.key.startsWith('Arrow')) {
    setTimeout(triggerSelectionLookup, 40);
  }
});

// 监听来自扩展 Popup / Background 的指令
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === 'TOGGLE_PAGE_TRANSLATION') {
    togglePageTranslation(message.targetLang || activeTargetLang, message.mode || activeTranslationMode);
    sendResponse({ success: true, isTranslated: isPageTranslated, mode: activeTranslationMode });
  } else if (message.type === 'GET_PAGE_STATUS') {
    const activeCount = typeof document !== 'undefined'
      ? document.querySelectorAll('.translate-king-wrapper.translate-king-done, [data-tk-replaced]').length
      : 0;
    // 如果 DOM 节点中已经没有译文（如页面放置过久被前端框架重新渲染回英文），校准内部状态
    if (activeCount === 0 && isPageTranslated && !isTranslating) {
      isPageTranslated = false;
    }
    sendResponse({
      isTranslated: isPageTranslated && activeCount > 0,
      isTranslating: isTranslating,
      mode: activeTranslationMode,
      totalBlocks: activeCount
    });
  }
});

// -----------------------------------------------------------------
// 监听浏览器标签页前后台可见性切换 (解决网页开久了/电脑休眠唤醒后无法翻译的问题)
// -----------------------------------------------------------------
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // 1. 如果翻译锁挂起超过 4 秒，强制复位解脱
      if (isTranslating && Date.now() - translatingStartTime > 4000) {
        console.warn('[TranslateKing] 标签页切回前台：发现陈旧未释放翻译锁，自动复位');
        isTranslating = false;
      }
      // 2. 如果页面状态是已翻译，但检测到译文被前端框架刷掉（例如 Twitter/Reddit 闲置后切回），自动触发增量自愈
      if (isPageTranslated) {
        const activeCount = document.querySelectorAll(
          '.translate-king-wrapper.translate-king-done, [data-tk-replaced]'
        ).length;
        if (activeCount === 0) {
          console.log('[TranslateKing] 标签页切回前台：译文节点已失活，自动调度增量翻译自愈');
          processDynamicMutations(30);
        }
      }
    }
  });
}

console.log('[TranslateKing] Content script ready. Progressive Viewport-First + Dynamic SPA support enabled.');
