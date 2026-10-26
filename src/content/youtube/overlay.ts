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
 * 5. 自动隐藏 YouTube 原生遮挡字幕，避免双重叠字
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
   * 初始化挂载容器
   */
  public init(): boolean {
    if (typeof document === 'undefined') return false;

    this.playerElement = document.getElementById('movie_player') as HTMLElement | null;
    this.videoElement = document.querySelector('#movie_player video') as HTMLVideoElement | null;

    if (!this.playerElement) {
      return false;
    }

    // 避免重复挂载
    const existing = document.getElementById('translate-king-yt-overlay');
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

    // 3. 绑定悬停自动暂停机制
    box.addEventListener('mouseenter', () => {
      if (this.videoElement && !this.videoElement.paused) {
        this.wasAutoPaused = true;
        this.videoElement.pause();
      }
    });

    box.addEventListener('mouseleave', () => {
      // 若当前划词词典浮窗正在展示，保持暂停供用户阅读；否则恢复播放
      const host = document.getElementById('translate-king-bubble-host');
      const isCardActive = host?.shadowRoot?.querySelector('.translate-king-card');

      if (!isCardActive && this.wasAutoPaused && this.videoElement) {
        this.wasAutoPaused = false;
        this.videoElement.play().catch(() => {});
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
   * 渲染或隐藏指定字幕
   */
  public renderCue(cue: SubtitleCue | null): void {
    if (this.isDestroyed || !this.textContainer || !this.origTextEl || !this.transTextEl) return;

    if (!cue) {
      this.textContainer.style.display = 'none';
      return;
    }

    this.origTextEl.textContent = cue.originalText;
    this.transTextEl.textContent = cue.translatedText || '';

    // 若译文尚未返回，隐藏译文行仅展示原文；一旦译文就绪瞬间双行展现
    this.transTextEl.style.display = cue.translatedText ? 'block' : 'none';
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
        bottom: 8% !important;
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

      /* 播放器控制栏激活时字幕稍微上浮，避免遮挡进度条 */
      .ytp-autohide:not(.ytp-fullscreen) #translate-king-yt-overlay,
      .ytp-hide-controls #translate-king-yt-overlay {
        bottom: 6% !important;
      }
      .ytp-fullscreen #translate-king-yt-overlay {
        bottom: 10% !important;
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
        max-width: 82% !important;
        text-align: center !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
        border: 1px solid rgba(255, 255, 255, 0.08) !important;
      }

      .translate-king-yt-orig {
        color: #E2E8F0 !important;
        font-size: clamp(14px, 1.8vw, 22px) !important;
        line-height: 1.35 !important;
        opacity: 0.88 !important;
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

      /* 隐藏 YouTube 原生遮挡重叠字幕 */
      .ytp-caption-window-bottom,
      .caption-window {
        opacity: 0 !important;
        pointer-events: none !important;
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
