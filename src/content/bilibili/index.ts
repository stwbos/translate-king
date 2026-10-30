/**
 * 翻译王 (TranslateKing) - 哔哩哔哩 (Bilibili) 原生双语字幕与播放器总控入口
 *
 * 核心设计架构：
 * 1. 100% 兼容 Bilibili BpxPlayer 播放器架构
 * 2. 实时观察 .bpx-player-subtitle-panel-text 字幕文本变动，极速异步翻译并原位双语呈现
 * 3. 播放器右下角控制条 (.bpx-player-control-bottom-right) 深度融合双语切换按钮 [双语 ON/OFF] 与 [⚙ 设置]
 * 4. 共享沉浸式多维字幕设置（双语/仅看译文、位置、字号缩放、高对比度颜色、遮罩）
 * 5. 支持单页无刷新切集 (P1/P2/分P) 状态自愈与字幕重置
 */

import { TargetLanguage } from '../../types';
import {
  getSubtitleConfig,
  updateSubtitleConfig,
  onSubtitleConfigChange,
  toggleSubtitleSettingsMenu
} from '../youtube/subtitle-menu';

function isBilibili(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname || '';
  return host.includes('bilibili.com');
}

/**
 * 在 Bilibili 播放器内显示状态提示气泡
 */
function showBiliPlayerStatusToast(text: string): void {
  if (typeof document === 'undefined') return;
  const player =
    document.querySelector('.bpx-player-container') ||
    document.getElementById('bilibili-player') ||
    document.querySelector('.bilibili-player-video');
  if (!player) return;

  let toast = document.getElementById('translate-king-bili-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'translate-king-bili-toast';
    toast.setAttribute('translate', 'no');
    toast.style.cssText = `
      position: absolute !important;
      top: 60px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      background: rgba(15, 23, 42, 0.92) !important;
      border: 1px solid rgba(59, 130, 246, 0.5) !important;
      color: #93C5FD !important;
      font-size: 13.5px !important;
      font-weight: 600 !important;
      padding: 8px 18px !important;
      border-radius: 20px !important;
      z-index: 3000 !important;
      pointer-events: none !important;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5) !important;
      opacity: 0 !important;
      transition: opacity 0.2s ease !important;
    `;
    player.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.opacity = '1';

  if ((window as any).__tk_bili_toast_timer) {
    clearTimeout((window as any).__tk_bili_toast_timer);
  }
  (window as any).__tk_bili_toast_timer = setTimeout(() => {
    if (toast) toast.style.opacity = '0';
  }, 1800);
}

/**
 * 挂载 Bilibili 控制栏双语字幕切换按钮
 */
function mountBiliControlButton(targetLang: TargetLanguage): void {
  if (typeof document === 'undefined') return;
  const controlsRight =
    document.querySelector('.bpx-player-control-bottom-right') ||
    document.querySelector('.bpx-player-control-entity') ||
    document.querySelector('.bilibili-player-video-control-bottom-right');
  if (!controlsRight) return;

  const btnId = 'translate-king-bili-control-btn';
  let btn = document.getElementById(btnId);
  const cfg = getSubtitleConfig();

  if (!btn) {
    btn = document.createElement('div');
    btn.id = btnId;
    btn.className = 'translate-king-bili-control-btn';
    btn.setAttribute('translate', 'no');
    btn.setAttribute('role', 'button');
    btn.setAttribute('title', '翻译王 - 实时双语字幕与设置');

    // SVG 图标
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.style.cssText = 'margin-right: 4px; pointer-events: none;';
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute(
      'd',
      'M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z'
    );
    svg.appendChild(path);
    btn.appendChild(svg);

    // 标签文本
    const labelSpan = document.createElement('span');
    labelSpan.className = 'tk-bili-btn-label';
    labelSpan.style.cssText = 'cursor: pointer; margin-right: 4px;';
    btn.appendChild(labelSpan);

    // 设置图标
    const gearSpan = document.createElement('span');
    gearSpan.className = 'tk-bili-btn-gear';
    gearSpan.textContent = '⚙';
    gearSpan.style.cssText = 'cursor: pointer; font-size: 13px; opacity: 0.85; padding: 0 2px;';
    gearSpan.setAttribute('title', '打开字幕设置菜单');
    btn.appendChild(gearSpan);

    // 点击主体切换开关
    labelSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = getSubtitleConfig();
      const nextEnabled = !current.enabled;
      updateSubtitleConfig({ enabled: nextEnabled });
      showBiliPlayerStatusToast(nextEnabled ? '双语字幕 已开启' : '双语字幕 已关闭');

      // 检查当前是否有 CC 字幕在播放
      const activeSubtitle = document.querySelector('.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle');
      if (nextEnabled && !activeSubtitle) {
        showBiliPlayerStatusToast('若画面未显示字幕，请在右下角开启播放器 CC 字幕');
      }
    });

    // 点击齿轮打开设置控制台
    gearSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSubtitleSettingsMenu({
        onToggleEnabled: (en) => updateSubtitleConfig({ enabled: en }),
        onOpenSummary: () => {},
        onDownloadSrt: () => {}
      });
    });

    // 挂载到控制条（尽量靠前或在 CC 字幕按钮左侧）
    const subtitleCtrl = controlsRight.querySelector('.bpx-player-ctrl-subtitle');
    if (subtitleCtrl && subtitleCtrl.parentNode === controlsRight) {
      controlsRight.insertBefore(btn, subtitleCtrl);
    } else {
      controlsRight.insertBefore(btn, controlsRight.firstChild);
    }
  }

  // 刷新按钮状态高亮
  const label = btn.querySelector('.tk-bili-btn-label');
  if (label) {
    label.textContent = cfg.enabled ? '双语 ON' : '双语 OFF';
  }
  btn.classList.toggle('tk-active', cfg.enabled);
}

export class BiliCaptionObserver {
  private observer: MutationObserver | null = null;
  private targetLang: TargetLanguage = 'zh-CN';
  private translationCache = new Map<string, string>();
  private lastProcessedText = '';
  private isRunning = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeConfig: (() => void) | null = null;

  constructor(targetLang: TargetLanguage = 'zh-CN') {
    this.targetLang = targetLang;
    this.unsubscribeConfig = onSubtitleConfigChange(() => {
      this.applyLiveStyleUpdate();
    });
  }

  public getTranslationCache(): Map<string, string> {
    return this.translationCache;
  }

  public setTargetLang(lang: TargetLanguage): void {
    this.targetLang = lang;
    this.translationCache.clear();
    this.lastProcessedText = '';
    this.processActiveCaptions();
  }

  public resetVideo(): void {
    this.lastProcessedText = '';
    this.removeInjectedLine();
  }

  public start(): void {
    if (typeof document === 'undefined') return;
    this.isRunning = true;
    this.ensureCaptionFixStyles();
    this.ensureObserverAttached();

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        if (!this.isRunning) return;
        this.ensureObserverAttached();
        this.processActiveCaptions();
        mountBiliControlButton(this.targetLang);
      }, 100);
    }
    this.processActiveCaptions();
  }

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
    this.lastProcessedText = '';
    this.removeInjectedLine();
  }

  private ensureCaptionFixStyles(): void {
    if (typeof document === 'undefined' || !document.head) return;
    const styleId = 'translate-king-bili-caption-fix-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .translate-king-bili-bilingual-line {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        width: 100% !important;
        max-width: 92% !important;
        margin: 4px auto 0 auto !important;
        text-align: center !important;
        pointer-events: none !important;
        z-index: 100 !important;
        box-sizing: border-box !important;
      }

      .translate-king-bili-trans-text {
        display: inline-block !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
        font-weight: 600 !important;
        line-height: 1.35 !important;
        letter-spacing: 0.02em !important;
        padding: 3px 12px !important;
        border-radius: 6px !important;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.9) !important;
        box-sizing: border-box !important;
        word-break: break-word !important;
        white-space: pre-wrap !important;
        transition: opacity 0.15s ease !important;
      }

      .bpx-player-container .translate-king-bili-control-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        height: 28px !important;
        padding: 0 8px !important;
        margin-right: 6px !important;
        background: rgba(255, 255, 255, 0.12) !important;
        border: 1px solid rgba(255, 255, 255, 0.22) !important;
        border-radius: 6px !important;
        color: #ffffff !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        user-select: none !important;
        transition: background 0.15s ease, border-color 0.15s ease !important;
        line-height: 1 !important;
      }

      .bpx-player-container .translate-king-bili-control-btn:hover {
        background: rgba(255, 255, 255, 0.22) !important;
        border-color: rgba(59, 130, 246, 0.6) !important;
      }

      .bpx-player-container .translate-king-bili-control-btn.tk-active {
        background: rgba(37, 99, 235, 0.85) !important;
        border-color: #60a5fa !important;
        color: #ffffff !important;
      }
    `;
    document.head.appendChild(style);
  }

  private ensureObserverAttached(): void {
    if (typeof document === 'undefined') return;
    const subtitleTarget =
      document.querySelector('.bpx-player-subtitle-panel-text') ||
      document.querySelector('.bpx-player-subtitle-panel') ||
      document.querySelector('.bpx-player-subtitle-wrap') ||
      document.querySelector('.bilibili-player-video-subtitle');

    if (!subtitleTarget) return;

    const ObserverClass =
      typeof MutationObserver !== 'undefined'
        ? MutationObserver
        : typeof window !== 'undefined'
          ? (window as any).MutationObserver
          : null;
    if (!ObserverClass) return;

    if (!this.observer) {
      this.observer = new ObserverClass(() => {
        if (this.isRunning) {
          this.processActiveCaptions();
        }
      });
      this.observer.observe(subtitleTarget, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
  }

  public processActiveCaptions(): void {
    if (!this.isRunning) return;
    const cfg = getSubtitleConfig();
    if (!cfg.enabled) {
      this.removeInjectedLine();
      return;
    }

    const textEl =
      document.querySelector<HTMLElement>('.bpx-player-subtitle-panel-text') ||
      document.querySelector<HTMLElement>('.bpx-player-subtitle-item') ||
      document.querySelector<HTMLElement>('.bilibili-player-video-subtitle');

    if (!textEl) {
      this.lastProcessedText = '';
      this.removeInjectedLine();
      return;
    }

    // 排除已挂载的译文节点
    const clone = textEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.translate-king-bilingual-line, .translate-king-bili-bilingual-line').forEach((n) => n.remove());
    const rawText = (clone.textContent || '').trim();

    if (!rawText) {
      this.lastProcessedText = '';
      this.removeInjectedLine();
      return;
    }

    if (rawText === this.lastProcessedText) {
      return;
    }

    this.lastProcessedText = rawText;

    // 检查缓存
    const cached = this.translationCache.get(rawText);
    if (cached) {
      this.renderBilingualLine(rawText, cached);
    } else {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage(
            {
              type: 'TRANSLATE_TEXT',
              text: rawText,
              toLang: this.targetLang
            },
            (res) => {
              if (chrome.runtime.lastError) return;
              if (res && res.translation && typeof res.translation === 'string') {
                this.translationCache.set(rawText, res.translation);
                if (this.isRunning && this.lastProcessedText === rawText) {
                  this.renderBilingualLine(rawText, res.translation);
                }
              }
            }
          );
        } catch (_) {}
      }
    }
  }

  private renderBilingualLine(origText: string, transText: string): void {
    const cfg = getSubtitleConfig();
    if (!this.isRunning || !cfg.enabled) {
      this.removeInjectedLine();
      return;
    }

    const parentPanel =
      document.querySelector('.bpx-player-subtitle-panel-position') ||
      document.querySelector('.bpx-player-subtitle-panel') ||
      document.querySelector('.bpx-player-subtitle-wrap') ||
      document.querySelector('.bpx-player-video-area') ||
      document.querySelector('.bpx-player-container');

    if (!parentPanel) return;

    let bilingualLine = document.getElementById('translate-king-bili-subtitle-line');
    if (!bilingualLine) {
      bilingualLine = document.createElement('div');
      bilingualLine.id = 'translate-king-bili-subtitle-line';
      bilingualLine.className = 'translate-king-bilingual-line translate-king-bili-bilingual-line';
      bilingualLine.setAttribute('translate', 'no');
      parentPanel.appendChild(bilingualLine);
    }

    // 根据模式控制原生字幕显示隐藏
    const nativeEl = document.querySelector<HTMLElement>('.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle');
    if (nativeEl) {
      if (cfg.displayMode === 'translation-only') {
        nativeEl.style.setProperty('opacity', '0', 'important');
        nativeEl.style.setProperty('visibility', 'hidden', 'important');
      } else {
        nativeEl.style.removeProperty('opacity');
        nativeEl.style.removeProperty('visibility');
      }
    }

    let textSpan = bilingualLine.querySelector<HTMLElement>('.translate-king-bili-trans-text');
    if (!textSpan) {
      textSpan = document.createElement('span');
      textSpan.className = 'translate-king-trans-text translate-king-bili-trans-text';
      bilingualLine.appendChild(textSpan);
    }

    textSpan.textContent = transText;

    // 动态应用样式
    const baseFontSize = Math.round(20 * (cfg.fontScale || 1.0));
    textSpan.style.setProperty('font-size', `${baseFontSize}px`, 'important');
    textSpan.style.setProperty('color', cfg.textColor || '#FEF08A', 'important');
    const bgAlpha = typeof cfg.bgOpacity === 'number' ? cfg.bgOpacity : 0.78;
    textSpan.style.setProperty('background', `rgba(0, 0, 0, ${bgAlpha})`, 'important');
  }

  private applyLiveStyleUpdate(): void {
    const cfg = getSubtitleConfig();
    const line = document.getElementById('translate-king-bili-subtitle-line');
    if (!line) return;

    if (!cfg.enabled) {
      this.removeInjectedLine();
      return;
    }

    const textSpan = line.querySelector<HTMLElement>('.translate-king-bili-trans-text');
    if (textSpan) {
      const baseFontSize = Math.round(20 * (cfg.fontScale || 1.0));
      textSpan.style.setProperty('font-size', `${baseFontSize}px`, 'important');
      textSpan.style.setProperty('color', cfg.textColor || '#FEF08A', 'important');
      const bgAlpha = typeof cfg.bgOpacity === 'number' ? cfg.bgOpacity : 0.78;
      textSpan.style.setProperty('background', `rgba(0, 0, 0, ${bgAlpha})`, 'important');
    }

    const nativeEl = document.querySelector<HTMLElement>('.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle');
    if (nativeEl) {
      if (cfg.displayMode === 'translation-only') {
        nativeEl.style.setProperty('opacity', '0', 'important');
        nativeEl.style.setProperty('visibility', 'hidden', 'important');
      } else {
        nativeEl.style.removeProperty('opacity');
        nativeEl.style.removeProperty('visibility');
      }
    }
  }

  private removeInjectedLine(): void {
    if (typeof document === 'undefined') return;
    const line = document.getElementById('translate-king-bili-subtitle-line');
    if (line) line.remove();

    const nativeEl = document.querySelector<HTMLElement>('.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle');
    if (nativeEl) {
      nativeEl.style.removeProperty('opacity');
      nativeEl.style.removeProperty('visibility');
    }
  }
}

let biliObserver: BiliCaptionObserver | null = null;
let currentBvid: string | null = null;
let domPollTimer: ReturnType<typeof setInterval> | null = null;

export function setupBilibiliLifecycle(targetLang: TargetLanguage): void {
  if (typeof window === 'undefined') return;
  if (!isBilibili()) return;

  if (!biliObserver) {
    biliObserver = new BiliCaptionObserver(targetLang);
    biliObserver.start();
  } else {
    biliObserver.setTargetLang(targetLang);
  }

  // 监听单页切集或切视频
  if (!domPollTimer) {
    domPollTimer = setInterval(() => {
      const match = window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
      const bvid = match ? match[1] : null;
      if (bvid && bvid !== currentBvid) {
        currentBvid = bvid;
        biliObserver?.resetVideo();
      }
    }, 500);
  }
}
