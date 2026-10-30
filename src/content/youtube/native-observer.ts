/**
 * 翻译王 (TranslateKing) - YouTube 原生字幕实时注入与双语呈现引擎 (Native Caption Dual-Sub Injector)
 *
 * 核心设计原则：
 * 1. 零破坏原生性：100% 保留 YouTube 原生字幕状态机与定位样式，刷新页面时绝不乱点 CC 按钮导致字幕被关掉！
 * 2. 原位双语自适应字号与多维样式定制：
 *    - 在原生 .caption-window 内部追加或前置 .translate-king-bilingual-line
 *    - 支持「双语对照 / 仅看译文」、「原文下方 / 原文上方」、字号缩放 (80%~145%)、多色切换、背景透明度、听力模糊遮罩
 * 3. 被动共享时间轴缓存：
 *    - 被动复用 yt-bridge 已拦截的完整字幕流，0 额外请求，杜绝触发 429 限流
 */

import { cleanRawText } from './extractor';
import { clearSharedCueTranslations, getSharedVideoCues, preloadSharedVideoCues } from './summary-panel';
import { getSubtitleConfig, onSubtitleConfigChange } from './subtitle-menu';
import { SubtitleScheduler } from './scheduler';
import { SubtitleCue } from './types';
import { TargetLanguage, TranslateBatchResponse } from '../../types';

export class NativeCaptionObserver {
  private observer: MutationObserver | null = null;
  private playerElement: HTMLElement | null = null;
  private targetLang: TargetLanguage = 'zh-CN';
  private translationCache = new Map<string, string>();
  private scheduler: SubtitleScheduler;
  private loadedSharedCuesRef: SubtitleCue[] | null = null;
  private lastMatchedRollupCue: SubtitleCue | null = null;
  private hasRequestedPreload = false;
  private rollupDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastProcessedText = '';
  private lastTranslatedText = '';
  private wasAutoPaused = false;
  private hasAutoEnabledCc = false;
  private videoResetTime = 0;
  private lastCcClickAttemptTime = 0;
  private ccClickAttempts = 0;
  private isHovered = false;
  private unsubscribeConfig: (() => void) | null = null;

  constructor(targetLang: TargetLanguage = 'zh-CN') {
    this.targetLang = targetLang;
    this.scheduler = new SubtitleScheduler(targetLang);
    this.scheduler.subscribe((cue) => {
      if (cue?.translatedText) {
        this.translationCache.set(cue.originalText, cue.translatedText);
      }
      if (this.isRunning) {
        this.processActiveCaptions();
      }
    });
    this.unsubscribeConfig = onSubtitleConfigChange(() => {
      this.applyLiveStyleUpdate();
    });
  }

  public getTranslationCache(): Map<string, string> {
    return this.translationCache;
  }

  public setTargetLang(lang: TargetLanguage): void {
    if (this.targetLang !== lang) {
      this.targetLang = lang;
      this.translationCache.clear();
      this.lastProcessedText = '';
      this.lastTranslatedText = '';
      this.lastMatchedRollupCue = null;
      clearSharedCueTranslations();
      this.scheduler.loadCues(this.scheduler.getCues(), lang);
      this.removeInjectedLines();
      this.processActiveCaptions();
    }
  }

  public resetVideo(): void {
    this.hasAutoEnabledCc = false;
    this.hasRequestedPreload = false;
    this.loadedSharedCuesRef = null;
    this.lastMatchedRollupCue = null;
    this.scheduler.loadCues([], this.targetLang);
    if (this.rollupDebounceTimer) {
      clearTimeout(this.rollupDebounceTimer);
      this.rollupDebounceTimer = null;
    }
    this.videoResetTime = Date.now();
    this.lastCcClickAttemptTime = 0;
    this.ccClickAttempts = 0;
    this.lastProcessedText = '';
    this.lastTranslatedText = '';
    this.removeInjectedLines();
  }

  /**
   * 注入全局防溢出与防闪烁样式表：
   * 1. 通过 CSS !important 强制锁定受管 .caption-window 居中且最大宽度不超过视频区域的 86%，彻底根除字幕跑出视频外的问题
   * 2. 通过父级类名直接隐藏 .captions-text，使 YouTube 每 150ms 新塞入的蹦字节点自诞生起即处于 display:none，实现 0 帧闪烁
   */
  private ensureCaptionFixStyles(): void {
    if (typeof document === 'undefined' || !document.head) return;
    const styleId = 'translate-king-yt-caption-fix-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #movie_player .caption-window.translate-king-window-managed,
      .html5-video-player .caption-window.translate-king-window-managed,
      .caption-window.translate-king-window-managed {
        left: 7% !important;
        right: 7% !important;
        transform: none !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        width: 86% !important;
        max-width: 86% !important;
        min-width: 0 !important;
        height: auto !important;
        max-height: none !important;
        bottom: 56px !important;
        top: auto !important;
        overflow: visible !important;
        text-align: center !important;
        box-sizing: border-box !important;
        transition: none !important;
        background: transparent !important;
      }

      .ytp-autohide .caption-window.translate-king-window-managed {
        bottom: 28px !important;
      }

      .caption-window.translate-king-rollup-takeover .captions-text,
      .caption-window.translate-king-hide-native .captions-text {
        display: none !important;
      }

      .caption-window.translate-king-window-managed .captions-text,
      .caption-window.translate-king-window-managed .caption-visual-line,
      .caption-window.translate-king-window-managed .ytp-caption-segment {
        white-space: pre-wrap !important;
        word-break: break-word !important;
        overflow-wrap: break-word !important;
        max-width: 100% !important;
      }

      .translate-king-bilingual-line {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        width: 100% !important;
        max-width: 100% !important;
        white-space: normal !important;
        box-sizing: border-box !important;
      }

      .translate-king-orig-text,
      .translate-king-trans-text {
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        word-break: break-word !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
        text-align: center !important;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * 提取纯净的 YouTube 原生字幕段（严格排除本插件注入的 .translate-king-bilingual-line 及其子节点）
   */
  private getNativeSegments(scope: HTMLElement | Document): HTMLElement[] {
    const raw = Array.from(
      scope.querySelectorAll('.ytp-caption-segment:not(.translate-king-trans-text):not(.translate-king-orig-text)')
    ) as HTMLElement[];
    return raw.filter((el) => !el.closest('.translate-king-bilingual-line'));
  }

  /**
   * 精准定位当前主播放器内正在显示的有效 .caption-window，
   * 严防 YouTube 首页/侧边栏缩略图内联预览播放器 (#inline-preview-player) 或残留空窗口抢占导致无字幕！
   */
  private findActiveCaptionWindow(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    const mainPlayer =
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player:not(#inline-preview-player)') ||
      document;
    const windows = Array.from(mainPlayer.querySelectorAll('.caption-window')) as HTMLElement[];
    if (windows.length === 0) {
      return document.querySelector('.caption-window') as HTMLElement | null;
    }

    for (const win of windows) {
      if (win.style.display === 'none') continue;
      const segs = this.getNativeSegments(win);
      if (segs.length > 0 && segs.some((s) => (s.textContent || '').trim().length > 0)) {
        return win;
      }
    }

    return windows.find((w) => w.style.display !== 'none') || windows[0];
  }

  /**
   * 启动原生字幕监听与双语注入
   */
  public start(): void {
    if (typeof document === 'undefined') return;
    this.isRunning = true;
    this.ensureCaptionFixStyles();
    this.ensureObserverAttached();

    if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
      try {
        window.postMessage({ type: 'TK_REQUEST_YT_TRACKS' }, '*');
      } catch (_) {}
    }

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        if (!this.isRunning) return;
        this.ensureObserverAttached();
        if (!this.hasAutoEnabledCc) {
          this.ensureNativeCcEnabled();
        }
        this.processActiveCaptions();
      }, 80);
    }
    this.processActiveCaptions();
  }

  /**
   * 停止监听并清理注入的译文行，100% 还原原生字幕
   */
  public stop(): void {
    this.isRunning = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.rollupDebounceTimer) {
      clearTimeout(this.rollupDebounceTimer);
      this.rollupDebounceTimer = null;
    }
    this.playerElement = null;
    this.lastProcessedText = '';
    this.lastTranslatedText = '';
    this.removeInjectedLines();
  }

  /**
   * 确保 MutationObserver 挂载
   */
  private ensureObserverAttached(): void {
    const player = (document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.querySelector('ytd-player')) as HTMLElement | null;
    if (!player) return;

    if (this.playerElement === player && this.observer) {
      return;
    }

    this.playerElement = player;
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((mutations) => {
      // 严格过滤插件自身在 .translate-king-bilingual-line 内部的 DOM 更新，彻底切断自激重绘闪烁循环！
      const hasExternalChange = mutations.some((m) => {
        const target = m.target as Node | null;
        if (!target) return false;
        const el = (target.nodeType === 1 ? target : target.parentElement) as HTMLElement | null;
        if (!el) return false;
        if (el.closest('.translate-king-bilingual-line')) return false;
        return true;
      });
      if (hasExternalChange) {
        this.processActiveCaptions();
      }
    });

    this.observer.observe(player, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  /**
   * 当用户在播放器控制面板修改字幕样式时，立即刷新当前屏幕上的字幕外观
   */
  public applyLiveStyleUpdate(): void {
    if (typeof document === 'undefined') return;
    const captionWindow = this.findActiveCaptionWindow();
    if (!captionWindow) return;

    const origSegments = this.getNativeSegments(captionWindow);
    const line = captionWindow.querySelector('.translate-king-bilingual-line') as HTMLElement | null;
    const hasOverrideOrig = Boolean(line?.querySelector('.translate-king-orig-text')?.textContent);

    this.syncNativeSegmentVisibility(captionWindow, origSegments, hasOverrideOrig);

    const textSpan = line?.querySelector('.translate-king-trans-text') as HTMLElement | null;
    if (line && textSpan) {
      this.applyConfigStylesToElements(captionWindow, line, textSpan, origSegments[0]);
    }
  }

  /**
   * 根据「双语对照 / 仅看译文」或「ASR 整句接管模式」控制原生逐词英文字幕的显隐
   * 核心防闪烁/零空白保证：译文未就绪前 (hasActiveTrans === false)，绝不提前隐藏原生字幕！
   */
  private syncNativeSegmentVisibility(
    captionWindow: HTMLElement,
    origSegments: HTMLElement[],
    forceHideNative = false
  ): void {
    const cfg = getSubtitleConfig();
    const hasActiveTrans = Boolean(captionWindow.querySelector('.translate-king-trans-text')?.textContent?.trim());
    const hideByMode = this.isRunning && cfg.displayMode === 'translation-only' && hasActiveTrans;
    const hideNative = this.isRunning && ((forceHideNative && hasActiveTrans) || hideByMode);

    captionWindow.classList.toggle(
      'translate-king-rollup-takeover',
      Boolean(this.isRunning && forceHideNative && hasActiveTrans)
    );
    captionWindow.classList.toggle('translate-king-hide-native', Boolean(hideByMode));

    for (const seg of origSegments) {
      if (hideNative) {
        if (seg.style.display !== 'none') {
          seg.style.setProperty('display', 'none', 'important');
        }
      } else if (seg.style.display === 'none') {
        seg.style.removeProperty('display');
      }
    }
  }

  /**
   * 同步已拦截/预取的完整句子字幕轨道至滑动窗口调度器 (SubtitleScheduler)
   */
  private syncTimelineScheduler(): number {
    const video =
      (document.querySelector('#movie_player video') as HTMLVideoElement | null) ||
      (document.querySelector('video') as HTMLVideoElement | null);
    const currentTimeMs = video && typeof video.currentTime === 'number' ? Math.round(video.currentTime * 1000) : 0;

    const shared = getSharedVideoCues();
    if (shared.length > 0 && shared !== this.loadedSharedCuesRef) {
      this.loadedSharedCuesRef = shared;
      this.scheduler.loadCues(shared, this.targetLang);
    } else if (shared.length === 0 && !this.hasRequestedPreload) {
      this.hasRequestedPreload = true;
      preloadSharedVideoCues(null)
        .then((cues) => {
          if (cues.length > 0 && this.isRunning && cues !== this.loadedSharedCuesRef) {
            this.loadedSharedCuesRef = cues;
            this.scheduler.loadCues(cues, this.targetLang);
            this.processActiveCaptions();
          }
        })
        .catch(() => {});
    }

    if (this.scheduler.hasCues()) {
      this.scheduler.onTimeUpdate(currentTimeMs);
    }
    return currentTimeMs;
  }

  /**
   * 在滑动窗口字幕库中检索与当前播放时间或 ASR 滚动碎片最匹配的完整句子 Cue
   */
  private findBestTimelineCue(currentTimeMs: number, cleanedDomText: string): SubtitleCue | null {
    if (!this.scheduler.hasCues()) return null;

    const direct = this.scheduler.findCueAt(currentTimeMs);
    if (direct) return direct;

    const allCues = this.scheduler.getCues();
    // 1. 允许 ±1200ms 时间容差匹配
    for (const c of allCues) {
      if (currentTimeMs >= c.startMs - 800 && currentTimeMs <= c.endMs + 1200) {
        return c;
      }
    }

    // 2. 若测试环境或 video.currentTime 为 0，按文本包含关系匹配完整长句
    if (cleanedDomText.length >= 4) {
      const normalizedDom = cleanedDomText.toLowerCase();
      for (const c of allCues) {
        const normCue = c.originalText.toLowerCase();
        if (normCue.includes(normalizedDom) || normalizedDom.includes(normCue)) {
          return c;
        }
      }
    }
    return null;
  }

  /**
   * 扫描原生字幕并原位注入双语译文（自动识别 ASR 逐词滚动窗口并切换为沉浸式整句双语渲染）
   */
  public processActiveCaptions(): void {
    if (!this.isRunning) return;

    const currentTimeMs = this.syncTimelineScheduler();

    const captionWindow = this.findActiveCaptionWindow();
    if (!captionWindow) {
      this.lastProcessedText = '';
      return;
    }

    // 绑定悬停自动暂停与遮罩显隐
    this.bindHoverPause(captionWindow);

    // 提取当前所有非本插件注入的原生字幕段文本
    const origSegments = this.getNativeSegments(captionWindow);

    if (origSegments.length === 0) {
      this.lastProcessedText = '';
      this.removeInjectedLines(captionWindow);
      return;
    }

    const rawJoined = origSegments.map((el) => el.textContent || '').join(' ');
    const cleaned = cleanRawText(rawJoined);

    if (!cleaned) {
      this.lastProcessedText = '';
      this.removeInjectedLines(captionWindow);
      return;
    }

    const isRollup = captionWindow.classList.contains('ytp-caption-window-rollup');
    let matchedCue = this.findBestTimelineCue(currentTimeMs, cleaned);
    if (isRollup && this.scheduler.hasCues() && !matchedCue && this.lastMatchedRollupCue) {
      // 在两句之间的极短停顿间隙保持上一句稳定显示，严防 Mode A <-> Mode B 切换闪烁！
      matchedCue = this.lastMatchedRollupCue;
    }

    // 模式 A：当视频为 ASR 逐词滚动字幕 (.ytp-caption-window-rollup) 且已获取合并后的整句时间轴时，
    // 隐藏逐词蹦出的原生碎片，直接渲染完整英文长句 + 完整中文译文（与沉浸式翻译体验一致）！
    if (isRollup && matchedCue) {
      this.lastMatchedRollupCue = matchedCue;
      const fullSentence = matchedCue.originalText;
      const cachedTrans =
        matchedCue.translatedText || this.translationCache.get(fullSentence) || '';

      if (cachedTrans) {
        matchedCue.translatedText = cachedTrans;
        this.translationCache.set(fullSentence, cachedTrans);
        this.lastProcessedText = fullSentence;
        this.lastTranslatedText = cachedTrans;
        this.injectTranslationLine(captionWindow, cachedTrans, origSegments[0], fullSentence);
        this.syncNativeSegmentVisibility(captionWindow, origSegments, true);
        return;
      }

      // 译文尚未就绪：绝不提前隐藏原生字幕！确保用户从第 0 毫秒即可看到原本字幕！
      this.syncNativeSegmentVisibility(captionWindow, origSegments, false);

      if (fullSentence === this.lastProcessedText) {
        return;
      }
      this.lastProcessedText = fullSentence;

      this.translateSingleText(fullSentence, this.targetLang).then((trans) => {
        if (trans && trans.trim().length > 0) {
          matchedCue.translatedText = trans;
          this.translationCache.set(fullSentence, trans);
          this.lastTranslatedText = trans;
          if (!this.isRunning) return;
          const currentWindow = this.findActiveCaptionWindow();
          if (currentWindow) {
            const currentSegs = this.getNativeSegments(currentWindow);
            this.injectTranslationLine(currentWindow, trans, currentSegs[0], fullSentence);
            this.syncNativeSegmentVisibility(currentWindow, currentSegs, true);
          }
        }
      });
      return;
    }

    // 模式 B：人工精校 CC 字幕（或尚未拿到整句时间轴时的保底渲染）
    this.syncNativeSegmentVisibility(captionWindow, origSegments, false);

    // 若滑动窗口预翻译已命中当前句，0ms 直接写入缓存
    if (matchedCue?.translatedText && matchedCue.originalText === cleaned) {
      this.translationCache.set(cleaned, matchedCue.translatedText);
    }

    // 检查是否已经为当前原文字幕注入过对应译文
    const existingLine = captionWindow.querySelector('.translate-king-bilingual-line') as HTMLElement | null;
    const existingTransEl = existingLine?.querySelector('.translate-king-trans-text') as HTMLElement | null;
    if (cleaned === this.lastProcessedText && existingLine && existingTransEl && existingTransEl.textContent) {
      this.applyConfigStylesToElements(captionWindow, existingLine, existingTransEl, origSegments[0]);
      return;
    }

    // 1. 命中内存缓存：0ms 瞬间注入双语
    if (this.translationCache.has(cleaned)) {
      const cached = this.translationCache.get(cleaned)!;
      this.lastProcessedText = cleaned;
      this.lastTranslatedText = cached;
      this.injectTranslationLine(captionWindow, cached, origSegments[0]);
      return;
    }

    // 2. 若 YouTube 刚重绘了 .caption-window 清空了译文行，先维持上一条有效译文防止词间闪烁空白
    if (!existingTransEl && this.lastTranslatedText) {
      this.injectTranslationLine(captionWindow, this.lastTranslatedText, origSegments[0]);
    }

    if (cleaned === this.lastProcessedText) {
      return;
    }
    this.lastProcessedText = cleaned;

    const triggerTranslation = (targetText: string) => {
      this.translateSingleText(targetText, this.targetLang).then((trans) => {
        if (trans && trans.trim().length > 0) {
          this.translationCache.set(targetText, trans);
          this.lastTranslatedText = trans;

          if (!this.isRunning) return;

          const currentWindow = this.findActiveCaptionWindow();
          if (!currentWindow) return;

          const currentSegments = this.getNativeSegments(currentWindow);
          const currentJoined = cleanRawText(currentSegments.map((el) => el.textContent || '').join(' '));

          const isStillRelevant =
            currentJoined === targetText ||
            currentJoined.includes(targetText) ||
            targetText.includes(currentJoined);

          if (isStillRelevant) {
            this.injectTranslationLine(currentWindow, trans, currentSegments[0]);
          }
        }
      });
    };

    // 3. 在 ASR 逐词滚动窗口 (.ytp-caption-window-rollup) 且已有屏幕译文时，
    // 对高频蹦字防抖 240ms，杜绝每蹦一个单词发起一次网络请求导致限流无译文！
    if (isRollup && this.lastTranslatedText) {
      if (this.rollupDebounceTimer) {
        clearTimeout(this.rollupDebounceTimer);
      }
      this.rollupDebounceTimer = setTimeout(() => {
        this.rollupDebounceTimer = null;
        if (this.isRunning) {
          triggerTranslation(cleaned);
        }
      }, 240);
    } else {
      triggerTranslation(cleaned);
    }
  }

  /**
   * 应用用户自定义样式（字号比例、颜色、背景透明度、学习模糊遮罩、上下位置）
   */
  private applyConfigStylesToElements(
    captionWindow: HTMLElement,
    line: HTMLElement,
    transSpan: HTMLElement,
    nativeSeg?: HTMLElement
  ): void {
    const cfg = getSubtitleConfig();
    const origSpan = line.querySelector('.translate-king-orig-text') as HTMLElement | null;

    // 1. 调整上下位置 (原文下方 vs 原文上方)
    if (cfg.position === 'top') {
      if (captionWindow.firstElementChild !== line) {
        captionWindow.insertBefore(line, captionWindow.firstChild);
      }
      line.style.setProperty('margin-top', '0px', 'important');
      line.style.setProperty('margin-bottom', '4px', 'important');
      if (origSpan && origSpan.parentElement === line && line.lastElementChild !== origSpan) {
        line.appendChild(origSpan);
      }
    } else {
      if (captionWindow.lastElementChild !== line) {
        captionWindow.appendChild(line);
      }
      line.style.setProperty('margin-top', '4px', 'important');
      line.style.setProperty('margin-bottom', '0px', 'important');
      if (origSpan && origSpan.parentElement === line && line.firstElementChild !== origSpan) {
        line.insertBefore(origSpan, line.firstChild);
      }
    }

    // 2. 计算自适应字号 × 用户设定缩放比（严格限制基准字号在 [16px, 26px] 之间，防止隐藏态或全屏百分比计算异常导致超大溢出）
    let basePx = 20;
    if (nativeSeg) {
      const inlineSize = nativeSeg.style?.fontSize;
      if (inlineSize && inlineSize.endsWith('px')) {
        basePx = parseFloat(inlineSize);
      } else if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const computed = window.getComputedStyle(nativeSeg).fontSize;
          if (computed && computed.endsWith('px')) {
            basePx = parseFloat(computed);
          }
        } catch (_) {}
      }
    }
    if (!Number.isFinite(basePx) || basePx < 15) basePx = 20;
    if (basePx > 26) basePx = 26;
    const targetPx = Math.max(14, Math.round(Math.max(18, basePx * 0.88) * (cfg.fontScale || 1.0)));
    transSpan.style.setProperty('font-size', `${targetPx}px`, 'important');

    if (origSpan) {
      const origPx = Math.max(14, Math.round(basePx * (cfg.fontScale || 1.0)));
      origSpan.style.setProperty('font-size', `${origPx}px`, 'important');
      origSpan.style.setProperty('background', `rgba(8, 8, 8, ${cfg.bgOpacity ?? 0.78})`, 'important');
      if (cfg.displayMode === 'translation-only' || !origSpan.textContent) {
        origSpan.style.setProperty('display', 'none', 'important');
      } else {
        origSpan.style.setProperty('display', 'block', 'important');
      }
    }

    // 3. 译文颜色与背景不透明度
    transSpan.style.setProperty('color', cfg.textColor || '#FEF08A', 'important');
    transSpan.style.setProperty('background', `rgba(8, 8, 8, ${cfg.bgOpacity ?? 0.78})`, 'important');

    // 4. 听力学习遮罩模式（平时模糊，鼠标悬停时清晰显示）
    if (cfg.learningMask && !this.isHovered) {
      transSpan.style.setProperty('filter', 'blur(5px)', 'important');
      transSpan.style.setProperty('transition', 'filter 0.18s ease', 'important');
    } else {
      transSpan.style.setProperty('filter', 'none', 'important');
    }
  }

  /**
   * 原位挂载双语翻译行
   * 关键修复：绝不在 line 上添加 YouTube 原生类名 'caption-visual-line'！
   * 否则 YouTube 的 ASR 逐词滚动引擎 (.ytp-caption-window-rollup) 会将我们的译文行误判为原生最后一行，
   * 把新蹦出的英文单词一个接一个直接 append 到译文后面！
   */
  private injectTranslationLine(
    captionWindow: HTMLElement,
    translatedText: string,
    referenceNativeSeg?: HTMLElement,
    overrideOrigText?: string
  ): void {
    if (!translatedText || !translatedText.trim()) return;

    this.ensureCaptionFixStyles();
    captionWindow.classList.add('translate-king-window-managed');

    let line = captionWindow.querySelector('.translate-king-bilingual-line') as HTMLElement | null;
    let origSpan = line?.querySelector('.translate-king-orig-text') as HTMLElement | null;
    let textSpan = line?.querySelector('.translate-king-trans-text') as HTMLElement | null;

    let isChanged = false;
    if (!line) {
      isChanged = true;
      line = document.createElement('div');
      line.className = 'translate-king-bilingual-line';
      line.setAttribute('translate', 'no');
      line.style.cssText = `
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        width: 100% !important;
        max-width: 100% !important;
        margin-top: 4px !important;
        line-height: 1.35 !important;
        text-align: center !important;
        white-space: normal !important;
        user-select: text !important;
        -webkit-user-select: text !important;
      `;

      // 严禁添加 ytp-caption-segment 类名！
      // YouTube 原生样式对 .ytp-caption-segment 强制设置了 white-space: nowrap 且播放器内核会覆写其内联样式导致字幕冲出视频画面！
      origSpan = document.createElement('span');
      origSpan.className = 'translate-king-orig-text';
      origSpan.style.cssText = `
        color: #FFFFFF !important;
        background: rgba(8, 8, 8, 0.78) !important;
        font-weight: 500 !important;
        font-size: 18px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 3px #000 !important;
        display: none !important;
        width: fit-content !important;
        max-width: 100% !important;
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        word-break: break-word !important;
        margin: 0 auto 3px auto !important;
        padding: 2px 8px !important;
        border-radius: 3px !important;
        box-sizing: border-box !important;
      `;

      textSpan = document.createElement('span');
      textSpan.className = 'translate-king-trans-text';
      textSpan.style.cssText = `
        color: #FEF08A !important;
        background: rgba(8, 8, 8, 0.78) !important;
        font-weight: 600 !important;
        font-size: 18px !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 3px #000 !important;
        display: inline-block !important;
        width: fit-content !important;
        max-width: 100% !important;
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        word-break: break-word !important;
        padding: 2px 8px !important;
        border-radius: 3px !important;
        box-sizing: border-box !important;
      `;

      line.appendChild(origSpan);
      line.appendChild(textSpan);
      captionWindow.appendChild(line);
    } else {
      // 清理任何可能被外部意外塞入 .translate-king-bilingual-line 的非插件节点
      Array.from(line.childNodes).forEach((child) => {
        if (child !== origSpan && child !== textSpan) {
          child.remove();
        }
      });
    }

    if (origSpan) {
      const targetOrig = overrideOrigText ? overrideOrigText.trim() : '';
      if (origSpan.textContent !== targetOrig) {
        origSpan.textContent = targetOrig;
        isChanged = true;
      }
    }

    if (textSpan) {
      if (textSpan.textContent !== translatedText) {
        textSpan.textContent = translatedText;
        isChanged = true;
      }
      if (isChanged) {
        this.applyConfigStylesToElements(captionWindow, line, textSpan, referenceNativeSeg);
      }
    }
  }

  /**
   * 清除当前注入的双语译文行并恢复原生英文字幕显示
   */
  private removeInjectedLines(scope: Document | HTMLElement = document): void {
    const lines = scope.querySelectorAll('.translate-king-bilingual-line');
    lines.forEach((el) => el.remove());

    const windows = scope.querySelectorAll('.caption-window');
    windows.forEach((win) => {
      win.classList.remove(
        'translate-king-window-managed',
        'translate-king-rollup-takeover',
        'translate-king-hide-native'
      );
    });
    if (scope instanceof HTMLElement && scope.classList.contains('caption-window')) {
      scope.classList.remove(
        'translate-king-window-managed',
        'translate-king-rollup-takeover',
        'translate-king-hide-native'
      );
    }

    const origSegments = this.getNativeSegments(scope);
    origSegments.forEach((seg) => {
      seg.style.removeProperty('display');
    });
  }

  /**
   * 绑定悬停自动暂停与听力遮罩自动解封
   */
  private bindHoverPause(captionWindow: HTMLElement): void {
    if ((captionWindow as any).__tk_hover_bound) return;
    (captionWindow as any).__tk_hover_bound = true;

    captionWindow.addEventListener('mouseenter', () => {
      this.isHovered = true;
      this.applyLiveStyleUpdate();

      const cfg = getSubtitleConfig();
      if (!cfg.hoverPause) return;

      const video = document.querySelector('#movie_player video') as HTMLVideoElement | null;
      if (video && !video.paused) {
        this.wasAutoPaused = true;
        video.pause();
      }
    });

    captionWindow.addEventListener('mouseleave', () => {
      this.isHovered = false;
      this.applyLiveStyleUpdate();

      const host = document.getElementById('translate-king-bubble-host');
      const isCardActive = host?.shadowRoot?.querySelector('.translate-king-card');
      const video = document.querySelector('#movie_player video') as HTMLVideoElement | null;

      if (!isCardActive && this.wasAutoPaused && video) {
        this.wasAutoPaused = false;
        video.play().catch(() => {});
      }
    });
  }

  /**
   * 单句极速翻译
   */
  private translateSingleText(text: string, toLang: TargetLanguage): Promise<string> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        return resolve('');
      }

      const shared = getSharedVideoCues();
      if (shared.length > 0) {
        const matched = shared.find((c) => c.originalText === text && c.translatedText);
        if (matched?.translatedText) {
          return resolve(matched.translatedText);
        }
      }

      chrome.runtime.sendMessage(
        {
          type: 'TRANSLATE_BATCH',
          texts: [text],
          toLang
        },
        (res: TranslateBatchResponse) => {
          if (chrome.runtime.lastError || !res?.translations?.[0]) {
            resolve('');
          } else {
            resolve(res.translations[0]);
          }
        }
      );
    });
  }

  /**
   * 仅当原生字幕明确处于未激活状态 (aria-pressed="false") 且播放器未处于广告或切视频过渡态时，安全点亮 CC
   */
  public ensureNativeCcEnabled(): void {
    if (typeof document === 'undefined' || this.hasAutoEnabledCc) return;

    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (player && player.classList.contains('ad-showing')) {
      return;
    }

    const ccBtn = (
      player?.querySelector('.ytp-subtitles-button') ||
      document.querySelector('.ytp-subtitles-button')
    ) as HTMLElement | null;
    if (!ccBtn) return;

    if (ccBtn.style.display === 'none' || ccBtn.getAttribute('aria-disabled') === 'true') {
      return;
    }

    const ariaPressed = ccBtn.getAttribute('aria-pressed');
    if (ariaPressed === 'true') {
      // 若刚切完视频 (< 900ms) 且尚未出现新字幕窗，暂不锁死 hasAutoEnabledCc，防止上一个视频残留的 aria-pressed="true" 随后被新视频重置为 false
      if (this.videoResetTime > 0 && Date.now() - this.videoResetTime < 900 && !this.findActiveCaptionWindow()) {
        return;
      }
      this.hasAutoEnabledCc = true;
      return;
    }

    if (ariaPressed === 'false' && this.ccClickAttempts < 6) {
      const now = Date.now();
      if (this.lastCcClickAttemptTime > 0 && now - this.lastCcClickAttemptTime < 550) {
        return;
      }
      this.lastCcClickAttemptTime = now;
      this.ccClickAttempts++;
      ccBtn.click();
      if (ccBtn.getAttribute('aria-pressed') === 'true') {
        this.hasAutoEnabledCc = true;
      }
    }
  }
}
