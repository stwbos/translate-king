/**
 * 翻译王 (TranslateKing) - 全网通用视频平台双语字幕与时间轴总结引擎
 *
 * 覆盖范围：
 * 除 YouTube 与 Bilibili 专用引擎外的所有主流视频网站与 HTML5 播放器：
 * Coursera, Udemy, TED, Vimeo, Twitter/X, Khan Academy, 以及 Video.js, Plyr,
 * JWPlayer, Shaka Player, DPlayer, ArtPlayer, XGPlayer 与原生 HTML5 <video> textTracks。
 *
 * 核心能力：
 * 1. 自动嗅探页面主视频播放器，注入翻译王官方品牌 Logo 设置按钮与 [✨ 视频总结] 按钮
 * 2. 点击 Logo 按钮直接打开统一的沉浸式字幕设置面板（支持字号、颜色、遮罩、双语/仅译文、下载双语 SRT）
 * 3. 实时监听第三方播放器字幕容器及原生 HTML5 <video> textTracks 轨道，原位渲染双语字幕
 * 4. 100% 遵守 TrustedTypes CSP 规范（零 innerHTML，纯原生 DOM API）
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

const UNIVERSAL_CAPTION_SELECTORS = [
  '.vjs-text-track-cue',
  '.vjs-text-track-display',
  '.plyr__caption',
  '.plyr__captions',
  '.jw-text-track-cue',
  '.jw-text-track-display',
  '.shaka-text-container',
  '.art-subtitle',
  '.dplayer-subtitle',
  '.xgplayer-texttrack',
  '[data-purpose="captions-cue-text"]',
  '.vds-captions',
  '.mejs__captions-text'
].join(', ');

let universalSummaryPanel: YouTubeSummaryPanel | null = null;
let universalObserver: UniversalVideoCaptionObserver | null = null;
let currentTargetLang: TargetLanguage = 'zh-CN';
let pollTimer: ReturnType<typeof setInterval> | null = null;

function isDedicatedVideoSite(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname || '';
  return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('bilibili.com');
}

export function openUniversalVideoSummaryPanel(): void {
  // 打开总结面板前，自动从 HTML5 <video> textTracks 收集全量字幕轨道节点，确保有真实字幕时 100% 能生成总结
  if (typeof document !== 'undefined') {
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      if (!v.textTracks) continue;
      for (let i = 0; i < v.textTracks.length; i++) {
        const track = v.textTracks[i];
        if (track.cues && track.cues.length > 0) {
          for (let j = 0; j < track.cues.length; j++) {
            const cue = track.cues[j] as any;
            const text = cue?.text ? String(cue.text).replace(/<[^>]+>/g, '').trim() : '';
            if (text) {
              recordObservedVideoCue(text, '');
            }
          }
        }
      }
    }
  }
  if (!universalSummaryPanel) {
    universalSummaryPanel = new YouTubeSummaryPanel(currentTargetLang);
  }
  universalSummaryPanel.togglePanel();
}

export function downloadUniversalVideoSrt(): void {
  const cues = getSharedVideoCues();
  if (!cues || cues.length === 0) {
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
  const host = (typeof window !== 'undefined' ? window.location.hostname : 'video').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download = `TranslateKing_${host}_bilingual.srt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 500);
}

/**
 * 判断某个 <video> 及其容器是否真正具备外挂字幕轨道或第三方播放器字幕层
 * 严格过滤普通网页的无字幕宣传片、背景视频、GIF 短视频，绝不在无字幕视频右上角乱挂按钮！
 */
function videoHasRealCaptions(video: HTMLVideoElement, rootDoc: Document): boolean {
  // 1. 存在主流播放器字幕容器节点 (如 Video.js / Plyr / JWPlayer / DPlayer / Coursera / Udemy 字幕层)
  if (rootDoc.querySelector(UNIVERSAL_CAPTION_SELECTORS)) {
    return true;
  }
  // 2. <video> 内含显式 <track> 字幕标签
  if (video.querySelector('track')) {
    return true;
  }
  // 3. HTML5 textTracks 含有有效字幕队列
  if (video.textTracks && video.textTracks.length > 0) {
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if ((t.cues && t.cues.length > 0) || (t.activeCues && t.activeCues.length > 0)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 查找页面中具备真实字幕轨道的主视频节点及其播放器包裹容器
 */
export function findPrimaryVideoContainer(): { video: HTMLVideoElement; container: HTMLElement } | null {
  if (typeof document === 'undefined') return null;
  const videos = Array.from(document.querySelectorAll('video')).filter((v) =>
    videoHasRealCaptions(v, document)
  );
  if (videos.length === 0) return null;

  let bestVideo: HTMLVideoElement | null = null;
  let maxArea = 0;

  for (const v of videos) {
    const rect = typeof v.getBoundingClientRect === 'function' ? v.getBoundingClientRect() : null;
    const width = rect?.width || v.offsetWidth || Number(v.getAttribute('width')) || 0;
    const height = rect?.height || v.offsetHeight || Number(v.getAttribute('height')) || 0;
    const area = width * height;
    if (area > maxArea) {
      maxArea = area;
      bestVideo = v;
    }
  }

  if (!bestVideo) {
    bestVideo = videos[0];
  }

  const container =
    (bestVideo.closest(
      '.video-js, .plyr, .jwplayer, .dplayer, .artplayer-app, .xgplayer, [class*="player-container" i], [class*="video-player" i], [class*="video-container" i]'
    ) as HTMLElement | null) ||
    bestVideo.parentElement ||
    document.body;

  return { video: bestVideo, container };
}

function updateUniversalButtonVisual(btn: HTMLElement, force = false): void {
  const cfg = getSubtitleConfig();
  const targetState = cfg.enabled ? 'true' : 'false';
  if (!force && btn.getAttribute('data-tk-enabled') === targetState && btn.firstChild) {
    return;
  }
  btn.setAttribute('data-tk-enabled', targetState);

  while (btn.firstChild) {
    btn.removeChild(btn.firstChild);
  }

  const logoWrap = createTranslateKingLogoElement(22, 'universal-video');
  if (cfg.enabled) {
    btn.setAttribute('title', '翻译王双语字幕设置 (当前已开启)');
    logoWrap.style.filter = 'drop-shadow(0 1px 3px rgba(37, 99, 235, 0.5))';
  } else {
    btn.setAttribute('title', '翻译王双语字幕设置 (当前已关闭)');
    logoWrap.style.filter = 'grayscale(1) opacity(0.45)';
  }

  btn.appendChild(logoWrap);
}

/**
 * 在通用视频播放器容器右上角/控制栏挂载 [翻译王 Logo 设置] 与 [✨ 视频总结] 快捷控制组
 */
export function mountUniversalVideoControls(targetLang: TargetLanguage): boolean {
  if (typeof document === 'undefined') return false;
  const found = findPrimaryVideoContainer();
  if (!found) {
    const staleBar = document.getElementById('translate-king-universal-video-bar');
    if (staleBar) staleBar.remove();
    return false;
  }

  const { container } = found;
  const computedPos = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(container).position : '';
  if (computedPos === 'static' && container !== document.body) {
    container.style.position = 'relative';
  }

  let bar = document.getElementById('translate-king-universal-video-bar') as HTMLElement | null;
  if (bar && !container.contains(bar)) {
    bar.remove();
    bar = null;
  }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'translate-king-universal-video-bar';
    bar.setAttribute('translate', 'no');
    bar.setAttribute('data-tk-ignore', 'true');
    bar.style.cssText = `
      position: absolute !important;
      top: 14px !important;
      right: 16px !important;
      z-index: 2147483640 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 4px 8px !important;
      border-radius: 999px !important;
      background: rgba(15, 23, 42, 0.85) !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
      border: 1px solid rgba(59, 130, 246, 0.35) !important;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45) !important;
      opacity: 0.88 !important;
      transition: opacity 0.2s ease, transform 0.2s ease !important;
      pointer-events: auto !important;
      user-select: none !important;
    `;

    bar.addEventListener('mouseenter', () => {
      if (bar) bar.style.opacity = '1';
    });
    bar.addEventListener('mouseleave', () => {
      if (bar) bar.style.opacity = '0.88';
    });

    // 1. 翻译王官方 Logo 按钮（点击直接打开字幕设置面板）
    const ctrlBtn = document.createElement('button');
    ctrlBtn.id = 'translate-king-universal-control-btn';
    ctrlBtn.className = 'translate-king-universal-control-btn';
    ctrlBtn.setAttribute('translate', 'no');
    ctrlBtn.setAttribute('aria-label', '翻译王双语字幕设置');
    ctrlBtn.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 28px !important;
      height: 28px !important;
      padding: 0 !important;
      margin: 0 !important;
      background: transparent !important;
      border: none !important;
      cursor: pointer !important;
      outline: none !important;
      transition: transform 0.15s ease !important;
    `;

    const openSettings = () => {
      toggleSubtitleSettingsMenu({
        onToggleEnabled: (en) => {
          updateSubtitleConfig({ enabled: en });
          updateUniversalButtonVisual(ctrlBtn, true);
        },
        onChangeTargetLang: (lang) => {
          currentTargetLang = lang;
          updateSubtitleConfig({ targetLang: lang });
          universalObserver?.setTargetLang(lang);
          universalSummaryPanel?.setTargetLang(lang);
          updateUniversalButtonVisual(ctrlBtn, true);
        },
        onOpenSummary: () => openUniversalVideoSummaryPanel(),
        onDownloadSrt: () => downloadUniversalVideoSrt()
      });
    };

    ctrlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openSettings();
    });

    ctrlBtn.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openSettings();
    });

    updateUniversalButtonVisual(ctrlBtn, true);

    // 2. [✨ 视频总结] 按钮
    const summaryBtn = document.createElement('button');
    summaryBtn.id = 'translate-king-universal-summary-btn';
    summaryBtn.className = 'translate-king-universal-summary-btn';
    summaryBtn.setAttribute('translate', 'no');
    summaryBtn.setAttribute('title', '翻译王：提取视频时间轴字幕并生成总结');
    summaryBtn.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 5px !important;
      height: 26px !important;
      padding: 0 10px !important;
      border-radius: 13px !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important;
      cursor: pointer !important;
      border: 1px solid rgba(59, 130, 246, 0.5) !important;
      background: linear-gradient(135deg, rgba(30, 64, 175, 0.9), rgba(37, 99, 235, 0.9)) !important;
      color: #FFFFFF !important;
      outline: none !important;
      white-space: nowrap !important;
    `;
    const summaryLogo = createTranslateKingLogoElement(15, 'universal-summary');
    const summaryLabel = document.createElement('span');
    summaryLabel.textContent = '视频总结';
    summaryBtn.appendChild(summaryLogo);
    summaryBtn.appendChild(summaryLabel);
    summaryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openUniversalVideoSummaryPanel();
    });

    bar.appendChild(ctrlBtn);
    bar.appendChild(summaryBtn);
    container.appendChild(bar);
  } else {
    const ctrlBtn = document.getElementById('translate-king-universal-control-btn');
    if (ctrlBtn) {
      updateUniversalButtonVisual(ctrlBtn, false);
    }
  }

  return true;
}

export class UniversalVideoCaptionObserver {
  private targetLang: TargetLanguage;
  private translationCache = new Map<string, string>();
  private lastProcessedText = '';
  private isRunning = false;
  private unsubscribeConfig: (() => void) | null = null;

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

  public setTargetLang(lang: TargetLanguage): void {
    if (this.targetLang === lang) return;
    this.targetLang = lang;
    this.translationCache.clear();
    this.lastProcessedText = '';
    this.removeInjectedLine();
  }

  public start(): void {
    this.isRunning = true;
    this.processActiveCaptions();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.unsubscribeConfig) {
      this.unsubscribeConfig();
      this.unsubscribeConfig = null;
    }
    this.removeInjectedLine();
  }

  private extractCurrentCaptionText(): string {
    if (typeof document === 'undefined') return '';

    // 1. 检查主流第三方视频播放器字幕节点
    const captionEl = document.querySelector<HTMLElement>(UNIVERSAL_CAPTION_SELECTORS);
    if (captionEl) {
      const clone = captionEl.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('#translate-king-universal-subtitle-line').forEach((n) => n.remove());
      const text = (clone.textContent || '').trim();
      if (text) return text;
    }

    // 2. 检查原生 HTML5 <video> activeCues
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      if (!v.textTracks) continue;
      for (let i = 0; i < v.textTracks.length; i++) {
        const track = v.textTracks[i];
        if (track.activeCues && track.activeCues.length > 0) {
          const texts: string[] = [];
          for (let j = 0; j < track.activeCues.length; j++) {
            const cue = track.activeCues[j] as any;
            if (cue && cue.text) {
              texts.push(String(cue.text).replace(/<[^>]+>/g, '').trim());
            }
          }
          const joined = texts.join(' ').trim();
          if (joined) return joined;
        }
      }
    }

    return '';
  }

  public processActiveCaptions(): void {
    if (!this.isRunning) return;
    const cfg = getSubtitleConfig();
    if (!cfg.enabled) {
      this.removeInjectedLine();
      return;
    }

    const rawText = this.extractCurrentCaptionText();
    if (!rawText) {
      this.lastProcessedText = '';
      this.removeInjectedLine();
      return;
    }

    const existingLine = document.getElementById('translate-king-universal-subtitle-line');
    if (rawText === this.lastProcessedText && existingLine && existingLine.textContent?.trim()) {
      return;
    }

    this.lastProcessedText = rawText;
    const effectiveLang = cfg.targetLang || this.targetLang || 'zh-CN';

    const cached = this.translationCache.get(rawText);
    if (cached) {
      this.renderBilingualLine(rawText, cached);
    } else if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
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
              if (this.isRunning && this.lastProcessedText === rawText) {
                this.renderBilingualLine(rawText, trans);
              }
            }
          }
        );
      } catch (_) {}
    }
  }

  private renderBilingualLine(origText: string, transText: string): void {
    const cfg = getSubtitleConfig();
    if (!this.isRunning || !cfg.enabled) {
      this.removeInjectedLine();
      return;
    }

    const found = findPrimaryVideoContainer();
    if (!found) return;
    const { container } = found;

    let line = document.getElementById('translate-king-universal-subtitle-line');
    if (!line) {
      line = document.createElement('div');
      line.id = 'translate-king-universal-subtitle-line';
      line.className = 'translate-king-bilingual-line translate-king-universal-bilingual-line';
      line.setAttribute('translate', 'no');
      line.setAttribute('data-tk-ignore', 'true');
      container.appendChild(line);
    } else if (line.parentElement !== container) {
      container.appendChild(line);
    }

    line.style.cssText = `
      position: absolute !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      bottom: 10% !important;
      top: auto !important;
      z-index: 2147483638 !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      pointer-events: none !important;
      max-width: 86% !important;
      text-align: center !important;
    `;

    while (line.firstChild) {
      line.removeChild(line.firstChild);
    }

    const baseFontSize = Math.round(19 * (cfg.fontScale || 1.0));
    const bgAlpha = typeof cfg.bgOpacity === 'number' ? cfg.bgOpacity : 0.78;
    const isSameText = origText.trim() === transText.trim();

    const box = document.createElement('div');
    box.style.cssText = `
      background: rgba(0, 0, 0, ${bgAlpha}) !important;
      padding: 4px 12px !important;
      border-radius: 6px !important;
      display: flex !important;
      flex-direction: ${cfg.position === 'top' ? 'column-reverse' : 'column'} !important;
      gap: 2px !important;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95) !important;
    `;

    if (cfg.displayMode !== 'translation-only' && !isSameText) {
      const origSpan = document.createElement('div');
      origSpan.className = 'translate-king-universal-orig-text';
      origSpan.style.cssText = `
        color: #FFFFFF !important;
        font-size: ${Math.max(12, Math.round(baseFontSize * 0.85))}px !important;
        line-height: 1.35 !important;
      `;
      origSpan.textContent = origText;
      box.appendChild(origSpan);
    }

    const transSpan = document.createElement('div');
    transSpan.className = 'translate-king-trans-text translate-king-universal-trans-text';
    transSpan.style.cssText = `
      color: ${cfg.textColor || '#FEF08A'} !important;
      font-size: ${baseFontSize}px !important;
      font-weight: 600 !important;
      line-height: 1.4 !important;
    `;
    transSpan.textContent = transText;
    box.appendChild(transSpan);

    line.appendChild(box);
    recordObservedVideoCue(origText, transText);
  }

  private applyLiveStyleUpdate(): void {
    if (this.lastProcessedText) {
      const cached = this.translationCache.get(this.lastProcessedText);
      if (cached) {
        this.renderBilingualLine(this.lastProcessedText, cached);
      }
    }
  }

  private removeInjectedLine(): void {
    if (typeof document === 'undefined') return;
    const line = document.getElementById('translate-king-universal-subtitle-line');
    if (line) line.remove();
  }
}

export function setupUniversalVideoLifecycle(targetLang: TargetLanguage): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (isDedicatedVideoSite()) return;

  currentTargetLang = targetLang;
  initSubtitleConfig();

  if (!universalObserver) {
    universalObserver = new UniversalVideoCaptionObserver(targetLang);
    universalObserver.start();
  } else {
    universalObserver.setTargetLang(targetLang);
  }

  mountUniversalVideoControls(targetLang);

  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (document.querySelector('video')) {
        mountUniversalVideoControls(currentTargetLang);
        universalObserver?.processActiveCaptions();
      }
    }, 600);
  }
}
