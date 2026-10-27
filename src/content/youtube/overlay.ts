/**
 * 翻译王 (TranslateKing) - YouTube 自适应双语字幕渲染器 (Subtitle Overlay)
 *
 * 核心设计：
 * 1. 挂载于 #movie_player 内部：剧院模式、小窗模式、全屏模式 100% 自适应居中，绝不位移遮挡
 * 2. 电影级防眩光排版：CSS text-shadow 黑色描边 + 毛玻璃微弱暗衬，极亮极暗背景均字字清晰
 * 3. 悬停自动暂停 (Hover-Pause)：
 *    - 鼠标移入字幕文字区域自动暂停视频，防止字幕溜走，从容查词
 *    - 鼠标移出且查词卡片关闭后自动恢复播放
 * 4. 原生事件穿透保护：外层容器 pointer-events: none 穿透到底层原生播放器，内层文字块支持高精度划词
 * 5. 双重保险：支持 SubtitleScheduler 调度器驱动与实时 NativeCaptionObserver 驱动
 */

import { SubtitleCue } from './types';

export class SubtitleOverlay {
  private playerElement: HTMLElement | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private overlayContainer: HTMLElement | null = null;
  private textContainer: HTMLElement | null = null;
  private origTextEl: HTMLElement | null = null;
  private transTextEl: HTMLElement | null = null;
  private wasAutoPaused = false;
  private isDestroyed = false;

  constructor() {
    this.init();
  }

  /**
   * 初始化挂载容器 (幂等安全，可安全多次调用)
   */
  public init(): boolean {
    if (typeof document === 'undefined') return false;

    this.playerElement = document.getElementById('movie_player') as HTMLElement | null;
    this.videoElement = document.querySelector('#movie_player video') as HTMLVideoElement | null;

    if (!this.playerElement) {
      return false;
    }

    // 若已经挂载且仍在 playerElement 中，更新 videoElement 即可
    const existing = document.getElementById('translate-king-yt-overlay');
    if (existing && this.playerElement.contains(existing) && this.textContainer) {
      this.overlayContainer = existing;
      this.injectStyles();
      return true;
    }

    if (existing) {
      existing.remove();
    }

    // 1. 创建外层穿透容器
    const overlay = document.createElement('div');
    overlay.id = 'translate-king-yt-overlay';
    overlay.className = 'translate-king-yt-overlay';
    overlay.setAttribute('translate', 'no');

    // 2. 创建内层文字排版块
    const box = document.createElement('div');
    box.className = 'translate-king-yt-box';

    const origText = document.createElement('div');
    origText.className = 'translate-king-yt-orig';

    const transText = document.createElement('div');
    transText.className = 'translate-king-yt-trans';

    box.appendChild(origText);
    box.appendChild(transText);
    overlay.appendChild(box);

    // 3. 绑定悬停自动暂停机制 (动态实时获取 video 元素)
    box.addEventListener('mouseenter', () => {
      const video = this.videoElement || (document.querySelector('#movie_player video') as HTMLVideoElement | null);
      if (video && !video.paused) {
        this.wasAutoPaused = true;
        video.pause();
      }
    });

    box.addEventListener('mouseleave', () => {
      const host = document.getElementById('translate-king-bubble-host');
      const isCardActive = host?.shadowRoot?.querySelector('.translate-king-card');
      const video = this.videoElement || (document.querySelector('#movie_player video') as HTMLVideoElement | null);

      if (!isCardActive && this.wasAutoPaused && video) {
        this.wasAutoPaused = false;
        video.play().catch(() => {});
      }
    });

    this.playerElement.appendChild(overlay);

    this.overlayContainer = overlay;
    this.textContainer = box;
    this.origTextEl = origText;
    this.transTextEl = transText;

    // 注入全局防叠字幕样式
    this.injectStyles();

    return true;
  }

  /**
   * 基于 SubtitleCue 渲染或隐藏字幕
   */
  public renderCue(cue: SubtitleCue | null): void {
    if (this.isDestroyed || !this.textContainer || !this.origTextEl || !this.transTextEl) return;

    if (!cue || !cue.originalText || cue.originalText.trim() === '') {
      this.textContainer.style.display = 'none';
      return;
    }

    this.origTextEl.textContent = cue.originalText;
    this.transTextEl.textContent = cue.translatedText || '';

    // 若译文尚未返回，仅展示原文；一旦译文就绪瞬间双行展现
    this.transTextEl.style.display = cue.translatedText ? 'block' : 'none';
    this.textContainer.style.display = 'inline-flex';
  }

  /**
   * 基于实时文本直出渲染 (供 NativeCaptionObserver 使用)
   */
  public renderDirectText(originalText: string, translatedText: string): void {
    if (this.isDestroyed || !this.textContainer || !this.origTextEl || !this.transTextEl) return;

    const trimmed = originalText ? originalText.trim() : '';
    if (!trimmed) {
      this.textContainer.style.display = 'none';
      return;
    }

    this.origTextEl.textContent = trimmed;
    this.transTextEl.textContent = translatedText || '';
    this.transTextEl.style.display = translatedText ? 'block' : 'none';
    this.textContainer.style.display = 'inline-flex';
  }

  /**
   * 注入字幕渲染 CSS 规则 (电影级黑边描边 + 响应式居中 + 隐藏原生重叠字幕)
   */
  private injectStyles(): void {
    const styleId = 'translate-king-yt-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #translate-king-yt-overlay {
        position: absolute !important;
        bottom: 56px !important;
        left: 0 !important;
        right: 0 !important;
        z-index: 60 !important;
        pointer-events: none !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        transition: bottom 0.2s ease !important;
      }

      /* 播放器控制栏激活与隐藏时智能浮动，绝不遮挡进度条 */
      .ytp-autohide #translate-king-yt-overlay {
        bottom: 32px !important;
      }
      .ytp-fullscreen #translate-king-yt-overlay {
        bottom: 80px !important;
      }
      .ytp-fullscreen.ytp-autohide #translate-king-yt-overlay {
        bottom: 44px !important;
      }

      .translate-king-yt-box {
        pointer-events: auto !important;
        user-select: text !important;
        -webkit-user-select: text !important;
        display: none;
        flex-direction: column !important;
        align-items: center !important;
        background: rgba(15, 23, 42, 0.78) !important;
        backdrop-filter: blur(6px) !important;
        -webkit-backdrop-filter: blur(6px) !important;
        padding: 6px 18px !important;
        border-radius: 8px !important;
        max-width: 84% !important;
        text-align: center !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
      }

      .translate-king-yt-orig {
        color: #E2E8F0 !important;
        font-size: clamp(14px, 1.8vw, 22px) !important;
        line-height: 1.35 !important;
        opacity: 0.9 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 2px #000 !important;
      }

      .translate-king-yt-trans {
        color: #FEF08A !important; /* 温润高对比度亮黄色，大片感极佳 */
        font-size: clamp(16px, 2.1vw, 26px) !important;
        font-weight: 600 !important;
        line-height: 1.4 !important;
        margin-top: 2px !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important;
        text-shadow: 0 2px 4px rgba(0, 0, 0, 0.95), 0 0 2px #000 !important;
      }

      /* 隐藏 YouTube 原生遮挡重叠字幕，但保留 DOM 渲染让 MutationObserver 持续捕获 */
      .ytp-caption-window-bottom,
      .caption-window {
        opacity: 0.001 !important;
        pointer-events: none !important;
      }
      .ytp-caption-segment {
        opacity: 0 !important;
        color: transparent !important;
        text-shadow: none !important;
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * 销毁渲染层
   */
  public destroy(): void {
    this.isDestroyed = true;
    if (this.overlayContainer) {
      this.overlayContainer.remove();
      this.overlayContainer = null;
    }
    const style = document.getElementById('translate-king-yt-styles');
    if (style) {
      style.remove();
    }
  }
}
