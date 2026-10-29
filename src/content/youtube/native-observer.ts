/**
 * 翻译王 (TranslateKing) - YouTube 原生字幕实时注入与双语呈现引擎 (Native Caption Dual-Sub Injector)
 *
 * 核心设计原则：
 * 1. 零破坏原生性：100% 保留 YouTube 原生字幕结构与样式，绝不使用 opacity: 0.001 隐藏原生文字！
 * 2. 原位双语排版 (In-situ Dual Subtitles)：
 *    - 紧随 YouTube 原生 .caption-visual-line 之后，原位插入 .translate-king-bilingual-line
 *    - 完美继承 YouTube 播放器自适应字号缩放、窗口避让控制条、全屏响应等全部原生机制
 * 3. 毫秒级流式推进：
 *    - 视频播放时，随着讲话者每一次切换句子，译文秒级实时跟随更换，彻底杜绝“定格卡死”
 * 4. 悬停智能暂停 (Hover-Pause)：
 *    - 鼠标悬停在字幕区域自动暂停，移出自动恢复播放，从容划词查词
 */

import { cleanRawText } from './extractor';
import { TargetLanguage, TranslateBatchResponse } from '../../types';

export class NativeCaptionObserver {
  private observer: MutationObserver | null = null;
  private playerElement: HTMLElement | null = null;
  private targetLang: TargetLanguage = 'zh-CN';
  private translationCache = new Map<string, string>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private lastProcessedText = '';
  private wasAutoPaused = false;
  private hasAutoEnabledCc = false;

  constructor(targetLang: TargetLanguage = 'zh-CN') {
    this.targetLang = targetLang;
  }

  public setTargetLang(lang: TargetLanguage): void {
    this.targetLang = lang;
  }

  public resetVideo(): void {
    this.hasAutoEnabledCc = false;
    this.lastProcessedText = '';
    this.removeInjectedLines();
  }

  /**
   * 启动原生字幕监听与双语注入
   */
  public start(): void {
    if (typeof document === 'undefined') return;
    this.isRunning = true;
    this.ensureObserverAttached();

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        if (!this.isRunning) return;
        this.ensureObserverAttached();
        this.processActiveCaptions();
      }, 80);
    }
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
    this.playerElement = null;
    this.lastProcessedText = '';
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

    this.observer = new MutationObserver(() => {
      this.processActiveCaptions();
    });

    this.observer.observe(player, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  /**
   * 扫描原生字幕并原位注入双语译文
   */
  public processActiveCaptions(): void {
    if (!this.isRunning) return;

    const captionWindow = document.querySelector('.caption-window') as HTMLElement | null;
    if (!captionWindow) {
      this.lastProcessedText = '';
      return;
    }

    // 绑定悬停自动暂停
    this.bindHoverPause(captionWindow);

    // 提取当前所有非译文的原生字幕段文本
    const origSegments = Array.from(
      captionWindow.querySelectorAll('.ytp-caption-segment:not(.translate-king-trans-text)')
    );

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

    // 检查是否已经为当前原文字幕注入过对应译文
    const existingTransEl = captionWindow.querySelector('.translate-king-trans-text');
    if (cleaned === this.lastProcessedText && existingTransEl && existingTransEl.textContent) {
      return;
    }

    this.lastProcessedText = cleaned;

    // 1. 命中内存缓存：0ms 瞬间注入双语
    if (this.translationCache.has(cleaned)) {
      this.injectTranslationLine(captionWindow, this.translationCache.get(cleaned)!);
      return;
    }

    // 2. 未命中缓存：异步拉取译文并回填
    this.translateSingleText(cleaned, this.targetLang).then((trans) => {
      if (trans && trans.trim().length > 0) {
        this.translationCache.set(cleaned, trans);

        if (!this.isRunning) return;

        const currentWindow = document.querySelector('.caption-window') as HTMLElement | null;
        if (!currentWindow) return;

        const currentSegments = Array.from(
          currentWindow.querySelectorAll('.ytp-caption-segment:not(.translate-king-trans-text)')
        );
        const currentJoined = cleanRawText(currentSegments.map((el) => el.textContent || '').join(' '));

        // 流式字幕智能对齐：只要当前字幕包含已翻译片段或二者同属一个语境，立即上屏展现！
        const isStillRelevant =
          currentJoined === cleaned ||
          currentJoined.includes(cleaned) ||
          cleaned.includes(currentJoined);

        if (isStillRelevant) {
          this.injectTranslationLine(currentWindow, trans);
        }
      }
    });
  }

  /**
   * 原位挂载双语翻译行
   */
  private injectTranslationLine(captionWindow: HTMLElement, translatedText: string): void {
    if (!translatedText || !translatedText.trim()) return;

    let line = captionWindow.querySelector('.translate-king-bilingual-line') as HTMLElement | null;
    let textSpan = line?.querySelector('.translate-king-trans-text') as HTMLElement | null;

    if (!line) {
      line = document.createElement('span');
      line.className = 'caption-visual-line translate-king-bilingual-line';
      line.setAttribute('translate', 'no');
      line.style.cssText = `
        display: block !important;
        margin-top: 4px !important;
        line-height: 1.35 !important;
        user-select: text !important;
        -webkit-user-select: text !important;
      `;

      textSpan = document.createElement('span');
      textSpan.className = 'ytp-caption-segment translate-king-trans-text';
      textSpan.style.cssText = `
        color: #FEF08A !important;
        background: rgba(8, 8, 8, 0.75) !important;
        font-weight: 600 !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 3px #000 !important;
        display: inline-block !important;
        padding: 2px 6px !important;
        border-radius: 2px !important;
      `;

      line.appendChild(textSpan);
      captionWindow.appendChild(line);
    }

    if (textSpan) {
      textSpan.textContent = translatedText;
    }
  }

  /**
   * 清除当前注入的双语译文行
   */
  private removeInjectedLines(scope: Document | HTMLElement = document): void {
    const lines = scope.querySelectorAll('.translate-king-bilingual-line');
    lines.forEach((el) => el.remove());
  }

  /**
   * 绑定悬停自动暂停
   */
  private bindHoverPause(captionWindow: HTMLElement): void {
    if ((captionWindow as any).__tk_hover_bound) return;
    (captionWindow as any).__tk_hover_bound = true;

    captionWindow.addEventListener('mouseenter', () => {
      const video = document.querySelector('#movie_player video') as HTMLVideoElement | null;
      if (video && !video.paused) {
        this.wasAutoPaused = true;
        video.pause();
      }
    });

    captionWindow.addEventListener('mouseleave', () => {
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
   * 安全单次唤醒 YouTube 原生 CC 按钮 (未开启时开启一次，绝不循环重复点击)
   */
  public ensureNativeCcEnabled(): void {
    if (typeof document === 'undefined') return;

    const ccBtn = document.querySelector('.ytp-subtitles-button') as HTMLElement | null;
    if (!ccBtn) return;

    const isPressed = ccBtn.getAttribute('aria-pressed') === 'true';
    if (isPressed) {
      this.hasAutoEnabledCc = true;
      return;
    }

    if (!this.hasAutoEnabledCc) {
      this.hasAutoEnabledCc = true;
      console.log('[TranslateKing YouTube] 触发原生字幕单次安全唤醒');
      ccBtn.click();
    }
  }
}
