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

import { TargetLanguage, TranslateBatchResponse } from '../../types';
import {
  getSubtitleConfig,
  updateSubtitleConfig,
  onSubtitleConfigChange,
  initSubtitleConfig,
  toggleSubtitleSettingsMenu,
  formatSrtTime
} from '../youtube/subtitle-menu';
import {
  YouTubeSummaryPanel,
  getSharedVideoCues,
  recordObservedVideoCue
} from '../youtube/summary-panel';
import { createTranslateKingLogoElement } from '../logo';

let biliSummaryPanel: YouTubeSummaryPanel | null = null;

export function openBiliVideoSummaryPanel(): void {
  if (biliObserver) {
    biliObserver.ensureNativeCcEnabled();
  }
  if (!biliSummaryPanel) {
    biliSummaryPanel = new YouTubeSummaryPanel(currentTargetLang);
  }
  biliSummaryPanel.togglePanel();
}

function downloadBiliVideoSrt(): void {
  const cues = getSharedVideoCues();
  if (!cues || cues.length === 0) {
    showBiliPlayerStatusToast('请先打开视频总结或播放片段以加载字幕数据');
    return;
  }

  const lines: string[] = [];
  cues.forEach((cue, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}`);
    lines.push(cue.originalText);
    if (cue.translatedText && cue.translatedText.trim() !== cue.originalText.trim()) {
      lines.push(cue.translatedText);
    }
    lines.push('');
  });

  const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const bvidMatch = window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
  const vid = bvidMatch ? bvidMatch[1] : 'bilibili';
  a.download = `TranslateKing_${vid}_bilingual.srt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 500);
}

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
 * 更新 Bilibili 底栏翻译王 Logo 按钮的视觉状态（幂等守卫，绝不重复销毁重建子节点）
 */
function updateBiliButtonVisual(btn: HTMLElement, force = false): void {
  const cfg = getSubtitleConfig();
  const targetState = cfg.enabled ? 'true' : 'false';
  if (!force && btn.getAttribute('data-tk-enabled') === targetState && btn.firstChild) {
    return;
  }
  btn.setAttribute('data-tk-enabled', targetState);

  while (btn.firstChild) {
    btn.removeChild(btn.firstChild);
  }

  const logoWrap = createTranslateKingLogoElement(22, 'bili');
  if (cfg.enabled) {
    btn.setAttribute('title', '翻译王双语字幕设置 (当前已开启)');
    btn.classList.add('tk-active');
    logoWrap.style.filter = 'drop-shadow(0 1px 3px rgba(37, 99, 235, 0.45))';
  } else {
    btn.setAttribute('title', '翻译王双语字幕设置 (当前已关闭)');
    btn.classList.remove('tk-active');
    logoWrap.style.filter = 'grayscale(1) opacity(0.45)';
  }

  btn.appendChild(logoWrap);
}

/**
 * 挂载 Bilibili 控制栏官方统一品牌 Logo 按钮（点击直接打开字幕设置菜单）
 */
export function mountBiliControlButton(targetLang: TargetLanguage): void {
  if (typeof document === 'undefined') return;
  const controlsRight =
    document.querySelector('.bpx-player-control-bottom-right') ||
    document.querySelector('.bpx-player-control-entity') ||
    document.querySelector('.bilibili-player-video-control-bottom-right');
  if (!controlsRight) return;

  const btnId = 'translate-king-bili-control-btn';
  let btn = document.getElementById(btnId) as HTMLElement | null;

  if (!btn || !controlsRight.contains(btn)) {
    if (!btn) {
      btn = document.createElement('div');
      btn.id = btnId;
      btn.className = 'bpx-player-ctrl-btn translate-king-bili-control-btn';
      btn.setAttribute('translate', 'no');
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-label', '翻译王双语字幕设置');

      const openSettings = () => {
        toggleSubtitleSettingsMenu({
          onToggleEnabled: (en) => {
            updateSubtitleConfig({ enabled: en });
            if (btn) updateBiliButtonVisual(btn, true);
            showBiliPlayerStatusToast(en ? '双语字幕 已开启' : '双语字幕 已关闭');
            const activeSubtitle = document.querySelector(
              '.bili-subtitle-x-subtitle-panel-text, .bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle'
            );
            if (en && !activeSubtitle) {
              showBiliPlayerStatusToast('若画面未显示字幕，请在右下角开启播放器 CC 字幕');
            }
          },
          onChangeTargetLang: (lang) => {
            currentTargetLang = lang;
            updateSubtitleConfig({ targetLang: lang });
            if (biliObserver) {
              biliObserver.setTargetLang(lang);
            }
            if (biliSummaryPanel) {
              biliSummaryPanel.setTargetLang(lang);
            }
            if (btn) updateBiliButtonVisual(btn, true);
          },
          onOpenSummary: () => openBiliVideoSummaryPanel(),
          onDownloadSrt: () => downloadBiliVideoSrt()
        });
      };

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openSettings();
      });

      btn.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openSettings();
      });
    }

    updateBiliButtonVisual(btn, true);

    // 挂载到控制条（紧邻 CC 字幕按钮左侧或控制区最左侧）
    const subtitleCtrl =
      controlsRight.querySelector('.bpx-player-ctrl-subtitle') ||
      controlsRight.querySelector('.bpx-player-ctrl-setting') ||
      controlsRight.firstChild;
    if (subtitleCtrl && subtitleCtrl.parentNode === controlsRight) {
      controlsRight.insertBefore(btn, subtitleCtrl);
    } else {
      controlsRight.appendChild(btn);
    }
  } else {
    updateBiliButtonVisual(btn, false);
  }
}

/**
 * 在 Bilibili 视频下方工具栏 (点赞/投币/收藏/分享栏) 注入 [✨ 视频总结] 按钮
 */
export function injectBiliSummaryActionButton(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    const toolbarContainer = (
      document.querySelector('.video-toolbar-left') ||
      document.querySelector('.video-toolbar-v1') ||
      document.querySelector('#arc_toolbar_report .toolbar-left') ||
      document.querySelector('#arc_toolbar_report') ||
      document.querySelector('.video-toolbar-container')
    ) as HTMLElement | null;

    if (!toolbarContainer) return false;

    const existingBtn = document.getElementById('translate-king-bili-summary-btn') as HTMLElement | null;
    if (existingBtn) {
      if (toolbarContainer.contains(existingBtn)) {
        return true;
      } else {
        existingBtn.remove();
      }
    }

    const summaryBtn = document.createElement('button');
    summaryBtn.id = 'translate-king-bili-summary-btn';
    summaryBtn.className = 'translate-king-bili-action-btn';
    summaryBtn.setAttribute('translate', 'no');
    summaryBtn.setAttribute('title', '翻译王：提取视频全程时间轴与字幕生成中文总结');
    summaryBtn.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      height: 32px !important;
      padding: 0 14px !important;
      margin: 0 12px 0 8px !important;
      border-radius: 16px !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important;
      cursor: pointer !important;
      border: 1px solid rgba(59, 130, 246, 0.5) !important;
      background: linear-gradient(135deg, rgba(30, 64, 175, 0.9), rgba(37, 99, 235, 0.9)) !important;
      color: #FFFFFF !important;
      outline: none !important;
      box-sizing: border-box !important;
      vertical-align: middle !important;
      user-select: none !important;
      flex-shrink: 0 !important;
      transition: transform 0.15s ease, box-shadow 0.15s ease !important;
      z-index: 10 !important;
    `;
    const btnLogo = createTranslateKingLogoElement(16, 'bili-summary');
    const btnLabel = document.createElement('span');
    btnLabel.textContent = '视频总结';
    summaryBtn.appendChild(btnLogo);
    summaryBtn.appendChild(btnLabel);
    summaryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openBiliVideoSummaryPanel();
    });

    toolbarContainer.appendChild(summaryBtn);
    return true;
  } catch (err) {
    console.warn('[TranslateKing Bilibili] 挂载视频总结按钮异常:', err);
    return false;
  }
}

export class BiliCaptionObserver {
  private observer: MutationObserver | null = null;
  private targetLang: TargetLanguage = 'zh-CN';
  private translationCache = new Map<string, string>();
  private lastProcessedText = '';
  private isRunning = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeConfig: (() => void) | null = null;

  private hasAutoEnabledCc = false;
  private lastAutoEnableAttempt = 0;

  constructor(targetLang: TargetLanguage = 'zh-CN') {
    this.targetLang = targetLang;
    const cfg = getSubtitleConfig();
    if (cfg.targetLang) {
      this.targetLang = cfg.targetLang;
    }
    this.unsubscribeConfig = onSubtitleConfigChange((newCfg) => {
      if (newCfg.targetLang && newCfg.targetLang !== this.targetLang) {
        this.setTargetLang(newCfg.targetLang);
      }
      this.applyLiveStyleUpdate();
    });
  }

  public getTranslationCache(): Map<string, string> {
    return this.translationCache;
  }

  public setTargetLang(lang: TargetLanguage): void {
    if (this.targetLang === lang) return;
    this.targetLang = lang;
    this.translationCache.clear();
    this.lastProcessedText = '';
    this.removeInjectedLine();
    this.processActiveCaptions();
  }

  public resetVideo(): void {
    this.hasAutoEnabledCc = false;
    this.lastAutoEnableAttempt = 0;
    this.lastProcessedText = '';
    this.removeInjectedLine();
  }

  /**
   * 自动探测并开启 B站播放器中的 AI 中文字幕或第一个可用字幕
   */
  public ensureNativeCcEnabled(): boolean {
    if (this.hasAutoEnabledCc) return true;
    const now = Date.now();
    if (now - this.lastAutoEnableAttempt < 1500) return false;
    this.lastAutoEnableAttempt = now;

    // 1. 若已有活动的字幕节点，说明已经开启，无需重复操作
    const activeText = document.querySelector(
      '.bili-subtitle-x-subtitle-panel-text, .bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle'
    );
    if (activeText && (activeText.textContent || '').trim().length > 0) {
      this.hasAutoEnabledCc = true;
      return true;
    }

    // 2. 检查当前菜单中是否存在激活的非关闭选项
    const activeItem = document.querySelector(
      '.bpx-player-ctrl-subtitle-language-item.bpx-state-active:not([data-lan="close"]), .bpx-player-ctrl-subtitle-item.bpx-state-active:not([data-lan="close"])'
    );
    if (activeItem) {
      this.hasAutoEnabledCc = true;
      return true;
    }

    // 3. 优先寻找中文 AI 字幕（如截图中的 中文 AI）或第一个有效语言项
    const langItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.bpx-player-ctrl-subtitle-language-item, .bpx-player-ctrl-subtitle-item'
      )
    );

    const nonCloseItem = langItems.find((el) => {
      const text = el.textContent || '';
      const lan = el.getAttribute('data-lan') || '';
      return !text.includes('关闭') && lan !== 'close';
    });

    if (nonCloseItem) {
      // 优先选中文 AI 或中文项
      const zhItem =
        langItems.find((el) => {
          const text = el.textContent || '';
          const lan = el.getAttribute('data-lan') || '';
          return (text.includes('中文') || lan.includes('zh')) && !text.includes('关闭');
        }) || nonCloseItem;

      zhItem.click();
      this.hasAutoEnabledCc = true;
      showBiliPlayerStatusToast('已自动开启 B站 AI字幕并转为双语翻译');
      return true;
    }

    // 4. 若菜单尚未在 DOM 中渲染（B站默认按需生成），派发轻量 mouseenter 唤起菜单
    const subtitleCtrl = document.querySelector<HTMLElement>('.bpx-player-ctrl-subtitle');
    if (subtitleCtrl) {
      subtitleCtrl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      setTimeout(() => {
        const item = document.querySelector<HTMLElement>(
          '.bpx-player-ctrl-subtitle-language-item:not([data-lan="close"])'
        );
        if (item) {
          const zh =
            Array.from(
              document.querySelectorAll<HTMLElement>('.bpx-player-ctrl-subtitle-language-item')
            ).find((el) => (el.textContent || '').includes('中文')) || item;
          zh.click();
          this.hasAutoEnabledCc = true;
          showBiliPlayerStatusToast('已自动开启 B站 AI字幕并转为双语翻译');
        }
        subtitleCtrl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      }, 150);
      return true;
    }

    return false;
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
        if (!this.hasAutoEnabledCc) {
          this.ensureNativeCcEnabled();
        }
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
        position: absolute !important;
        bottom: 54px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        display: inline-flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 3px !important;
        width: auto !important;
        max-width: 88% !important;
        padding: 5px 14px !important;
        border-radius: 8px !important;
        text-align: center !important;
        pointer-events: none !important;
        z-index: 999999 !important;
        box-sizing: border-box !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
      }

      .translate-king-bili-orig-text {
        display: block !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
        font-weight: 500 !important;
        color: #F8FAFC !important;
        line-height: 1.3 !important;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95) !important;
        word-break: break-word !important;
        white-space: pre-wrap !important;
      }

      .translate-king-bili-trans-text {
        display: block !important;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, "Helvetica Neue", sans-serif !important;
        font-weight: 600 !important;
        line-height: 1.35 !important;
        letter-spacing: 0.02em !important;
        padding: 1px 4px !important;
        border-radius: 4px !important;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.9) !important;
        box-sizing: border-box !important;
        word-break: break-word !important;
        white-space: pre-wrap !important;
        transition: opacity 0.15s ease !important;
      }

      .translate-king-bili-control-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 36px !important;
        min-width: 36px !important;
        height: 100% !important;
        padding: 0 !important;
        margin: 0 2px !important;
        background: transparent !important;
        border: none !important;
        cursor: pointer !important;
        user-select: none !important;
        flex-shrink: 0 !important;
        align-self: center !important;
        opacity: 0.92 !important;
        transition: opacity 0.15s ease, transform 0.15s ease !important;
        z-index: 10 !important;
      }

      .translate-king-bili-control-btn:hover {
        opacity: 1 !important;
        transform: scale(1.08) !important;
      }
    `;
    document.head.appendChild(style);
  }

  private ensureObserverAttached(): void {
    if (typeof document === 'undefined') return;
    const subtitleTarget =
      document.querySelector('.bili-subtitle-x-subtitle-panel-text') ||
      document.querySelector('.bili-subtitle-x-subtitle-panel') ||
      document.querySelector('.bili-subtitle-x-subtitle-panel-wrap') ||
      document.querySelector('.bili-subtitle-x-subtitle-panel-position') ||
      document.querySelector('.bpx-player-subtitle-panel-text') ||
      document.querySelector('.bpx-player-subtitle-panel') ||
      document.querySelector('.bpx-player-subtitle-wrap') ||
      document.querySelector('.bpx-player-container') ||
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
      document.querySelector<HTMLElement>('.bili-subtitle-x-subtitle-panel-text') ||
      document.querySelector<HTMLElement>('.bpx-player-subtitle-panel-text') ||
      document.querySelector<HTMLElement>('.bpx-player-subtitle-item') ||
      document.querySelector<HTMLElement>('.bilibili-player-video-subtitle');

    if (!textEl) {
      this.lastProcessedText = '';
      this.removeInjectedLine();
      return;
    }

    // 排除已挂载的译文节点与 B站 AI 角标水印
    const clone = textEl.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll(
        '.translate-king-bilingual-line, .translate-king-bili-bilingual-line, .bili-subtitle-x-subtitle-panel-ai-mark, .bpx-player-subtitle-panel-ai-mark, [class*="ai-mark"]'
      )
      .forEach((n) => n.remove());
    const rawText = (clone.textContent || '').trim();

    if (!rawText) {
      this.lastProcessedText = '';
      this.removeInjectedLine();
      return;
    }

    const existingLine = document.getElementById('translate-king-bili-subtitle-line');
    if (rawText === this.lastProcessedText && existingLine && existingLine.textContent?.trim()) {
      return;
    }

    this.lastProcessedText = rawText;

    const effectiveLang: TargetLanguage = (cfg.targetLang || this.targetLang || 'zh-CN') as TargetLanguage;
    const cacheKey = `${effectiveLang}:::${rawText}`;
    // 检查缓存
    const cached = this.translationCache.get(cacheKey) || this.translationCache.get(rawText);
    if (cached) {
      this.renderBilingualLine(rawText, cached);
    } else {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage(
            {
              type: 'TRANSLATE_BATCH',
              texts: [rawText],
              toLang: effectiveLang
            },
            (res: TranslateBatchResponse) => {
              if (chrome.runtime.lastError) return;
              if (res && Array.isArray(res.translations) && res.translations[0]) {
                const trans = res.translations[0];
                this.translationCache.set(rawText, trans);
                this.translationCache.set(cacheKey, trans);
                if (this.isRunning && this.lastProcessedText === rawText) {
                  this.renderBilingualLine(rawText, trans);
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

    // 优先挂载在 .bpx-player-video-area 或 .bpx-player-container 顶层，彻底脱离 B站原生 .bili-subtitle-x-subtitle-panel-position 内部的绝对定位覆盖与重绘销毁
    const parentPanel =
      document.querySelector('.bpx-player-video-area') ||
      document.querySelector('.bpx-player-container') ||
      document.querySelector('.bpx-player-subtitle-wrap') ||
      document.querySelector('.bili-subtitle-x-subtitle-panel-wrap') ||
      document.querySelector('.bpx-player-subtitle-panel-position') ||
      document.querySelector('.bili-subtitle-x-subtitle-panel-position');

    if (!parentPanel) return;

    let bilingualLine = document.getElementById('translate-king-bili-subtitle-line');
    if (!bilingualLine) {
      bilingualLine = document.createElement('div');
      bilingualLine.id = 'translate-king-bili-subtitle-line';
      bilingualLine.className = 'translate-king-bilingual-line translate-king-bili-bilingual-line';
      bilingualLine.setAttribute('translate', 'no');
      bilingualLine.setAttribute('data-tk-ignore', 'true');
      parentPanel.appendChild(bilingualLine);
    } else if (bilingualLine.parentElement !== parentPanel) {
      parentPanel.appendChild(bilingualLine);
    }

    // 接管字幕渲染后，将 B站原生灰色 AI 字幕框及外层背景容器隐藏 (opacity: 0; visibility: hidden)，
    // 由我们的 #translate-king-bili-subtitle-line 统一在视频底部同一弹性框内渲染【原文 + 译文】，100% 根治原生 AI 字幕框残留与遮挡问题！
    const nativeEls = document.querySelectorAll<HTMLElement>(
      '.bili-subtitle-x-subtitle-panel, .bpx-player-subtitle-panel, .bili-subtitle-x-subtitle-panel-position, .bpx-player-subtitle-panel-position, .bili-subtitle-x-subtitle-panel-text, .bpx-player-subtitle-panel-text, .bili-subtitle-x-subtitle-panel-major-group, .bpx-player-subtitle-panel-major-group, .bili-subtitle-x-subtitle-panel-ai-mark, .bpx-player-subtitle-panel-ai-mark, .bilibili-player-video-subtitle'
    );
    nativeEls.forEach((nativeEl) => {
      if (!nativeEl.contains(bilingualLine!)) {
        nativeEl.style.setProperty('opacity', '0', 'important');
        nativeEl.style.setProperty('visibility', 'hidden', 'important');
      }
    });

    let origSpan = bilingualLine.querySelector<HTMLElement>('.translate-king-bili-orig-text');
    if (!origSpan) {
      origSpan = document.createElement('span');
      origSpan.className = 'translate-king-orig-text translate-king-bili-orig-text';
      bilingualLine.appendChild(origSpan);
    }

    let textSpan = bilingualLine.querySelector<HTMLElement>('.translate-king-bili-trans-text');
    if (!textSpan) {
      textSpan = document.createElement('span');
      textSpan.className = 'translate-king-trans-text translate-king-bili-trans-text';
      bilingualLine.appendChild(textSpan);
    }

    origSpan.textContent = origText;
    textSpan.textContent = transText;
    recordObservedVideoCue(origText, transText);

    // 动态应用样式：字幕始终位于视频底部 (bottom: 54px)，
    // 译文位置“原文上方 (top)”表示【译文在原文的上方 (column-reverse)】，“原文下方 (bottom)”表示【译文在原文的下方 (column)】
    const baseFontSize = Math.round(20 * (cfg.fontScale || 1.0));
    const origFontSize = Math.max(13, Math.round(baseFontSize * 0.85));
    const bgAlpha = typeof cfg.bgOpacity === 'number' ? cfg.bgOpacity : 0.78;
    const isSameText = origText.trim() === transText.trim();

    bilingualLine.style.setProperty('background', `rgba(0, 0, 0, ${bgAlpha})`, 'important');
    bilingualLine.style.setProperty('bottom', '54px', 'important');
    bilingualLine.style.setProperty('top', 'auto', 'important');
    bilingualLine.style.setProperty(
      'flex-direction',
      cfg.position === 'top' ? 'column-reverse' : 'column',
      'important'
    );

    origSpan.style.setProperty('font-size', `${origFontSize}px`, 'important');
    origSpan.style.setProperty(
      'display',
      cfg.displayMode === 'translation-only' || isSameText ? 'none' : 'block',
      'important'
    );

    textSpan.style.setProperty('font-size', `${baseFontSize}px`, 'important');
    textSpan.style.setProperty('color', cfg.textColor || '#FEF08A', 'important');
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

    const baseFontSize = Math.round(20 * (cfg.fontScale || 1.0));
    const origFontSize = Math.max(13, Math.round(baseFontSize * 0.85));
    const bgAlpha = typeof cfg.bgOpacity === 'number' ? cfg.bgOpacity : 0.78;

    line.style.setProperty('background', `rgba(0, 0, 0, ${bgAlpha})`, 'important');
    line.style.setProperty('bottom', '54px', 'important');
    line.style.setProperty('top', 'auto', 'important');
    line.style.setProperty(
      'flex-direction',
      cfg.position === 'top' ? 'column-reverse' : 'column',
      'important'
    );

    const origSpan = line.querySelector<HTMLElement>('.translate-king-bili-orig-text');
    const textSpan = line.querySelector<HTMLElement>('.translate-king-bili-trans-text');
    const isSameText =
      Boolean(origSpan && textSpan) &&
      (origSpan?.textContent || '').trim() === (textSpan?.textContent || '').trim();

    if (origSpan) {
      origSpan.style.setProperty('font-size', `${origFontSize}px`, 'important');
      origSpan.style.setProperty(
        'display',
        cfg.displayMode === 'translation-only' || isSameText ? 'none' : 'block',
        'important'
      );
    }

    if (textSpan) {
      textSpan.style.setProperty('font-size', `${baseFontSize}px`, 'important');
      textSpan.style.setProperty('color', cfg.textColor || '#FEF08A', 'important');
      textSpan.style.setProperty('background', `rgba(0, 0, 0, ${bgAlpha})`, 'important');
    }

    const nativeEls = document.querySelectorAll<HTMLElement>(
      '.bili-subtitle-x-subtitle-panel, .bpx-player-subtitle-panel, .bili-subtitle-x-subtitle-panel-position, .bpx-player-subtitle-panel-position, .bili-subtitle-x-subtitle-panel-text, .bpx-player-subtitle-panel-text, .bili-subtitle-x-subtitle-panel-major-group, .bpx-player-subtitle-panel-major-group, .bili-subtitle-x-subtitle-panel-ai-mark, .bpx-player-subtitle-panel-ai-mark, .bilibili-player-video-subtitle'
    );
    nativeEls.forEach((nativeEl) => {
      if (!nativeEl.contains(line)) {
        nativeEl.style.setProperty('opacity', '0', 'important');
        nativeEl.style.setProperty('visibility', 'hidden', 'important');
      }
    });
  }

  private removeInjectedLine(): void {
    if (typeof document === 'undefined') return;
    const line = document.getElementById('translate-king-bili-subtitle-line');
    if (line) line.remove();

    const nativeEls = document.querySelectorAll<HTMLElement>(
      '.bili-subtitle-x-subtitle-panel, .bpx-player-subtitle-panel, .bili-subtitle-x-subtitle-panel-position, .bpx-player-subtitle-panel-position, .bili-subtitle-x-subtitle-panel-text, .bpx-player-subtitle-panel-text, .bili-subtitle-x-subtitle-panel-major-group, .bpx-player-subtitle-panel-major-group, .bili-subtitle-x-subtitle-panel-ai-mark, .bpx-player-subtitle-panel-ai-mark, .bilibili-player-video-subtitle'
    );
    nativeEls.forEach((nativeEl) => {
      nativeEl.style.removeProperty('opacity');
      nativeEl.style.removeProperty('visibility');
    });
  }
}

let biliObserver: BiliCaptionObserver | null = null;
let currentBvid: string | null = null;
let domPollTimer: ReturnType<typeof setInterval> | null = null;
let currentTargetLang: TargetLanguage = 'zh-CN';

export function setupBilibiliLifecycle(targetLang: TargetLanguage): void {
  if (typeof window === 'undefined') return;
  if (!isBilibili()) return;

  currentTargetLang = targetLang;
  initSubtitleConfig();

  if (!biliObserver) {
    biliObserver = new BiliCaptionObserver(targetLang);
    biliObserver.start();
  } else {
    biliObserver.setTargetLang(targetLang);
  }
  if (biliSummaryPanel) {
    biliSummaryPanel.setTargetLang(targetLang);
  }

  mountBiliControlButton(targetLang);
  injectBiliSummaryActionButton();

  // 监听单页切集或切视频
  if (!domPollTimer) {
    domPollTimer = setInterval(() => {
      const match = window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
      const p = new URLSearchParams(window.location.search).get('p') || '1';
      const bvid = match ? `${match[1]}_p${p}` : null;
      if (bvid && bvid !== currentBvid) {
        currentBvid = bvid;
        biliObserver?.resetVideo();
        biliSummaryPanel?.resetForNewVideo(bvid);
      }
      mountBiliControlButton(currentTargetLang);
      injectBiliSummaryActionButton();
    }, 500);
  }
}
