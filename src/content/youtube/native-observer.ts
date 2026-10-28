/**
 * 翻译王 (TranslateKing) - YouTube 原生字幕 DOM 监听与实时捕获器 (Native Caption Observer)
 *
 * 核心机制：
 * 1. 100% 免疫 Proof of Origin (pot) 防爬校验：
 *    - YouTube 官方播放器自身具备完备的签名与凭证，原生 CC 渲染出的 .ytp-caption-segment 绝对合法且真实
 * 2. 高频 DOM + 定时器双驱动 (80ms 极速响应)：
 *    - 实时监听 .caption-window 与 .ytp-caption-segment 变化，捕获当下朗读的原始字幕，随视频播放瞬态流转
 * 3. 0ms 闪电上屏与极速译文回填：
 *    - 原文 0ms 直出，命中本地缓存即刻双语上屏，未命中时异步拉取译文回填
 * 4. 零侵入保护机制：
 *    - 仅在字幕未开启时单次安全唤醒原生字幕，绝不循环调用或破坏播放器内部状态机
 */

import { cleanRawText } from './extractor';
import { TargetLanguage, TranslateBatchResponse } from '../../types';

export type NativeCaptionCallback = (originalText: string, translatedText: string) => void;

export class NativeCaptionObserver {
  private observer: MutationObserver | null = null;
  private playerElement: HTMLElement | null = null;
  private lastText = '';
  private targetLang: TargetLanguage = 'zh-CN';
  private onUpdate: NativeCaptionCallback;
  private isSchedulerActive: () => boolean;
  private translationCache = new Map<string, string>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private hasAutoEnabledCc = false;

  constructor(
    targetLang: TargetLanguage,
    onUpdate: NativeCaptionCallback,
    isSchedulerActive: () => boolean
  ) {
    this.targetLang = targetLang;
    this.onUpdate = onUpdate;
    this.isSchedulerActive = isSchedulerActive;
  }

  public setTargetLang(lang: TargetLanguage): void {
    this.targetLang = lang;
  }

  /**
   * 重置当前视频状态 (切视频时调用)
   */
  public resetVideo(): void {
    this.hasAutoEnabledCc = false;
    this.lastText = '';
  }

  /**
   * 启动原生字幕 DOM 监听
   */
  public start(): void {
    if (typeof document === 'undefined') return;
    this.isRunning = true;
    this.ensureObserverAttached();

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        if (!this.isRunning) return;
        this.ensureObserverAttached();
        this.inspectActiveCaptions();
      }, 80);
    }
  }

  /**
   * 停止监听
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
    this.lastText = '';
  }

  /**
   * 确保 MutationObserver 正确挂载到 #movie_player
   */
  private ensureObserverAttached(): void {
    const player = document.getElementById('movie_player');
    if (!player) return;

    if (this.playerElement === player && this.observer) {
      return;
    }

    this.playerElement = player;
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver(() => {
      this.inspectActiveCaptions();
    });

    this.observer.observe(player, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  /**
   * 嗅探当前页面上正在渲染的原生字幕文本并实时推进
   */
  public inspectActiveCaptions(): void {
    if (!this.isRunning) return;

    // 若 Sliding Window 调度器已成功接管全片高精度时间轴，本通道静默退让
    if (this.isSchedulerActive()) {
      return;
    }

    let segments = document.querySelectorAll('#movie_player .ytp-caption-segment');
    if (!segments || segments.length === 0) {
      segments = document.querySelectorAll('.caption-window .captions-text, .caption-window');
    }

    if (!segments || segments.length === 0) {
      if (this.lastText !== '') {
        this.lastText = '';
        this.onUpdate('', '');
      }
      return;
    }

    const rawJoined = Array.from(segments)
      .map((el) => el.textContent || '')
      .join(' ');
    const cleaned = cleanRawText(rawJoined);

    if (!cleaned) {
      if (this.lastText !== '') {
        this.lastText = '';
        this.onUpdate('', '');
      }
      return;
    }

    if (cleaned === this.lastText) {
      return;
    }

    this.lastText = cleaned;

    // 1. 命中缓存秒级双语上屏
    if (this.translationCache.has(cleaned)) {
      this.onUpdate(cleaned, this.translationCache.get(cleaned)!);
      return;
    }

    // 2. 原文瞬间直出，绝不让用户等待网络延迟
    this.onUpdate(cleaned, '');

    // 3. 异步拉取译文回填
    this.translateSingleText(cleaned, this.targetLang).then((trans) => {
      if (trans && trans.trim().length > 0) {
        this.translationCache.set(cleaned, trans);
        if (this.lastText === cleaned && !this.isSchedulerActive()) {
          this.onUpdate(cleaned, trans);
        }
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
   * 安全单次唤醒 YouTube 原生 CC 按钮 (绝不循环重复点击，绝不调用破坏性私有方法)
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

    // 仅在首次未开启时触发一次唤醒
    if (!this.hasAutoEnabledCc) {
      this.hasAutoEnabledCc = true;
      console.log('[TranslateKing YouTube] 触发原生字幕单次安全唤醒');
      ccBtn.click();
    }
  }
}
