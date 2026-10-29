/**
 * 翻译王 (TranslateKing) - YouTube 原生双语字幕与视频总结总控入口
 *
 * 核心设计架构：
 * 1. 100% 兼容 YouTube TrustedTypes CSP 安全策略 (零 .innerHTML 赋值，纯原生 DOM API 构建)
 * 2. 控制条最左侧自然融合 + 沉浸式多维字幕菜单：
 *    - 双语控制按钮挂载于播放器右下角控制组 (.ytp-right-controls) 的最左侧第一个位置
 *    - 点击左侧「双语 ON/OFF」秒切双语开关；点击右侧「⚙」弹出多维字幕控制台（双语/仅译文、位置、字号、颜色、遮罩、下载双语 SRT）
 *    - 视频下方操作栏移除重复的双语按钮，仅保留独立的 [✨ 视频总结] 按钮
 * 3. 零延迟点击响应：
 *    - 状态幂等守卫 (data-tk-enabled)，严禁在 MutationObserver 轮询中重复销毁重建按钮子节点导致吞噬鼠标 click 事件
 */

import { NativeCaptionObserver } from './native-observer';
import { YouTubeSummaryPanel, getSharedVideoCues } from './summary-panel';
import {
  initSubtitleConfig,
  getSubtitleConfig,
  updateSubtitleConfig,
  toggleSubtitleSettingsMenu,
  formatSrtTime
} from './subtitle-menu';
import { TargetLanguage } from '../../types';

let nativeObserver: NativeCaptionObserver | null = null;
let summaryPanel: YouTubeSummaryPanel | null = null;
let currentVideoId: string | null = null;
let currentTargetLang: TargetLanguage = 'zh-CN';
let isSubtitlesEnabled = true;
let isLifecycleSetup = false;
let domObserver: MutationObserver | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function isYouTube(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname || '';
  return host.includes('youtube.com') || host.includes('youtu.be');
}

function getVideoIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const v = params.get('v');
  if (v) return v;

  const match = window.location.pathname.match(/\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * 纯 DOM API 构建 SVG 翻译图标（规避 YouTube TrustedHTML CSP 拦截）
 */
function createTranslateIconSvg(size: number): SVGSVGElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.style.cssText =
    'display: inline-block !important; vertical-align: middle !important; flex-shrink: 0 !important; pointer-events: none !important;';

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute(
    'd',
    'M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z'
  );
  svg.appendChild(path);
  return svg;
}

/**
 * 清除历史旧版遗留元素及操作栏重复的双语按钮
 */
function cleanupLegacyElements(): void {
  if (typeof document === 'undefined') return;

  const idsToRemove = [
    'translate-king-yt-badge',
    'translate-king-yt-overlay',
    'translate-king-yt-styles',
    'translate-king-yt-action-btn' // 移除视频下方重复的双语按钮
  ];
  for (const id of idsToRemove) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
}

/**
 * 在播放器内显示轻量切换反馈提示（1.2秒自动消失）
 */
function showPlayerStatusToast(text: string): void {
  if (typeof document === 'undefined') return;
  const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  if (!player) return;

  let toast = document.getElementById('translate-king-yt-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'translate-king-yt-toast';
    toast.setAttribute('translate', 'no');
    toast.style.cssText = `
      position: absolute !important;
      top: 18px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      background: rgba(15, 23, 42, 0.92) !important;
      color: #93C5FD !important;
      border: 1px solid rgba(59, 130, 246, 0.45) !important;
      padding: 6px 14px !important;
      border-radius: 20px !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif !important;
      z-index: 2000 !important;
      pointer-events: none !important;
      transition: opacity 0.2s ease !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4) !important;
    `;
    player.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.opacity = '1';

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toast) toast.style.opacity = '0';
  }, 1400);
}

/**
 * 一键导出当前视频的双语 .SRT 字幕文件
 */
function downloadCurrentVideoSrt(): void {
  const cues = getSharedVideoCues();
  if (!cues || cues.length === 0) {
    showPlayerStatusToast('⏳ 正在提取字幕轨道，请先打开一次「视频总结」面板或稍后重试');
    if (!summaryPanel) {
      summaryPanel = new YouTubeSummaryPanel(currentTargetLang);
    }
    summaryPanel.togglePanel();
    return;
  }

  const cache = nativeObserver?.getTranslationCache();
  const lines: string[] = [];

  cues.forEach((cue, idx) => {
    const startStr = formatSrtTime(cue.startTimeMs);
    const endStr = formatSrtTime(cue.startTimeMs + Math.max(1500, cue.durationMs || 2500));
    const orig = cue.originalText.trim();
    const trans = (cue.translatedText || cache?.get(orig) || '').trim();

    lines.push(String(idx + 1));
    lines.push(`${startStr} --> ${endStr}`);
    lines.push(orig);
    if (trans && trans !== orig) {
      lines.push(trans);
    }
    lines.push('');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const vid = getVideoIdFromUrl() || 'youtube';
  a.href = url;
  a.download = `TranslateKing-${vid}-bilingual.srt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showPlayerStatusToast(`📥 已导出双语 SRT 字幕 (${cues.length} 条)`);
}

/**
 * 打开右侧视频时间轴总结面板
 */
function openVideoSummaryPanel(): void {
  if (!summaryPanel) {
    summaryPanel = new YouTubeSummaryPanel(currentTargetLang);
  }
  summaryPanel.togglePanel();
}

/**
 * 向 YouTube 播放器右下角控制条的最左侧第一个位置注入 [双语 ON | ⚙] 复合按钮
 */
function injectBottomControls(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    const rightControls = (
      player?.querySelector('.ytp-right-controls') ||
      document.querySelector('.ytp-right-controls')
    ) as HTMLElement | null;

    if (!rightControls) return false;

    const existingBtn = document.getElementById('translate-king-yt-control-btn') as HTMLElement | null;
    if (existingBtn) {
      if (rightControls.contains(existingBtn)) {
        // 确保始终位于全屏按钮所在控制行的最左侧第一个位置
        if (rightControls.firstElementChild !== existingBtn) {
          rightControls.insertBefore(existingBtn, rightControls.firstChild);
        }
        // 关键：仅在状态发生变化时才更新内部 DOM，绝不在每次轮询中销毁子节点，彻底保证点击 100% 灵敏响应！
        updateButtonVisual(existingBtn, false);
        return true;
      } else {
        existingBtn.remove();
      }
    }

    const btn = document.createElement('button');
    btn.id = 'translate-king-yt-control-btn';
    btn.className = 'ytp-button translate-king-yt-control-btn';
    btn.setAttribute('translate', 'no');
    btn.setAttribute('aria-label', '翻译王双语字幕与设置');
    btn.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      vertical-align: top !important;
      width: auto !important;
      min-width: 82px !important;
      height: 100% !important;
      margin: 0 6px 0 0 !important;
      padding: 0 4px !important;
      cursor: pointer !important;
      background: transparent !important;
      border: none !important;
      outline: none !important;
      line-height: normal !important;
      overflow: visible !important;
      opacity: 1 !important;
      visibility: visible !important;
      box-sizing: border-box !important;
      z-index: 100 !important;
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const target = e.target as HTMLElement | null;
      // 如果点击的是右侧齿轮设置区，弹出多维字幕设置菜单
      if (target && target.closest('[data-tk-role="settings-trigger"]')) {
        toggleSubtitleSettingsMenu({
          onToggleEnabled: (enabled) => toggleSubtitles(enabled),
          onOpenSummary: () => openVideoSummaryPanel(),
          onDownloadSrt: () => downloadCurrentVideoSrt()
        });
        return;
      }
      // 否则直接切换双语字幕主开关
      toggleSubtitles();
    });

    // 支持右键直接呼出字幕设置菜单
    btn.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleSubtitleSettingsMenu({
        onToggleEnabled: (enabled) => toggleSubtitles(enabled),
        onOpenSummary: () => openVideoSummaryPanel(),
        onDownloadSrt: () => downloadCurrentVideoSrt()
      });
    });

    updateButtonVisual(btn, true);

    // 挂载在全屏按钮所在控制行 (.ytp-right-controls) 的最左侧第一个位置
    if (rightControls.firstChild) {
      rightControls.insertBefore(btn, rightControls.firstChild);
    } else {
      rightControls.appendChild(btn);
    }

    return true;
  } catch (err) {
    console.warn('[TranslateKing YouTube] 挂载底栏控制按钮异常:', err);
    return false;
  }
}

/**
 * 向视频下方主操作栏仅注入 [✨ 视频总结] 按钮（不再重复挂载双语字幕按钮）
 */
function injectSummaryActionButton(): boolean {
  if (typeof document === 'undefined') return false;

  try {
    const actionsContainer = (
      document.querySelector('#top-row #actions #menu ytd-menu-renderer') ||
      document.querySelector('#top-row #actions #actions-inner') ||
      document.querySelector('#top-row #actions') ||
      document.querySelector('ytd-watch-metadata #actions #menu') ||
      document.querySelector('ytd-watch-metadata #actions') ||
      document.querySelector('#actions.ytd-watch-metadata')
    ) as HTMLElement | null;

    if (!actionsContainer) return false;

    const existingSummaryBtn = document.getElementById('translate-king-yt-summary-btn') as HTMLElement | null;
    if (existingSummaryBtn) {
      if (actionsContainer.contains(existingSummaryBtn)) {
        return true;
      } else {
        existingSummaryBtn.remove();
      }
    }

    const summaryBtn = document.createElement('button');
    summaryBtn.id = 'translate-king-yt-summary-btn';
    summaryBtn.className = 'translate-king-yt-action-btn';
    summaryBtn.setAttribute('translate', 'no');
    summaryBtn.setAttribute('title', '翻译王：提取视频全程时间轴字幕并生成中文总结');
    summaryBtn.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      height: 36px !important;
      padding: 0 14px !important;
      margin: 0 8px 0 0 !important;
      border-radius: 18px !important;
      font-size: 13.5px !important;
      font-weight: 600 !important;
      font-family: Roboto, -apple-system, sans-serif !important;
      cursor: pointer !important;
      border: 1px solid rgba(59, 130, 246, 0.5) !important;
      background: linear-gradient(135deg, rgba(30, 64, 175, 0.88), rgba(37, 99, 235, 0.88)) !important;
      color: #FFFFFF !important;
      outline: none !important;
      box-sizing: border-box !important;
      vertical-align: middle !important;
      user-select: none !important;
      z-index: 10 !important;
    `;
    summaryBtn.textContent = '✨ 视频总结';
    summaryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openVideoSummaryPanel();
    });

    if (actionsContainer.firstChild) {
      actionsContainer.insertBefore(summaryBtn, actionsContainer.firstChild);
    } else {
      actionsContainer.appendChild(summaryBtn);
    }

    return true;
  } catch (err) {
    console.warn('[TranslateKing YouTube] 挂载视频总结按钮异常:', err);
    return false;
  }
}

function updateButtonVisual(btn: HTMLElement, force = false): void {
  const targetState = isSubtitlesEnabled ? 'true' : 'false';
  if (!force && btn.getAttribute('data-tk-enabled') === targetState && btn.firstChild) {
    return;
  }
  btn.setAttribute('data-tk-enabled', targetState);

  while (btn.firstChild) {
    btn.removeChild(btn.firstChild);
  }

  const pill = document.createElement('span');
  pill.className = 'translate-king-btn-pill';

  if (isSubtitlesEnabled) {
    pill.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 4px !important;
      background: linear-gradient(135deg, #2563EB 0%, #3B82F6 100%) !important;
      color: #FFFFFF !important;
      padding: 2px 6px 2px 8px !important;
      border-radius: 12px !important;
      font-weight: 700 !important;
      font-size: 11px !important;
      line-height: 16px !important;
      letter-spacing: 0.2px !important;
      user-select: none !important;
      white-space: nowrap !important;
      height: 22px !important;
      box-shadow: 0 2px 8px rgba(37, 99, 235, 0.4) !important;
    `;
    btn.setAttribute('title', '左键切换双语字幕 · 点击右侧 ⚙ 调节字幕样式/位置/下载SRT');
  } else {
    pill.style.cssText = `
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 4px !important;
      background: rgba(255, 255, 255, 0.18) !important;
      color: rgba(255, 255, 255, 0.9) !important;
      padding: 2px 6px 2px 8px !important;
      border-radius: 12px !important;
      font-weight: 600 !important;
      font-size: 11px !important;
      line-height: 16px !important;
      letter-spacing: 0.2px !important;
      user-select: none !important;
      white-space: nowrap !important;
      height: 22px !important;
    `;
    btn.setAttribute('title', '双语字幕已关闭 (点击开启 · 点击右侧 ⚙ 打开字幕设置)');
  }

  const icon = createTranslateIconSvg(12);
  const label = document.createElement('span');
  label.style.cssText = 'pointer-events: none !important;';
  label.textContent = isSubtitlesEnabled ? '双语 ON' : '双语 OFF';

  // 分隔竖线 + 齿轮设置触发区
  const gearTrigger = document.createElement('span');
  gearTrigger.setAttribute('data-tk-role', 'settings-trigger');
  gearTrigger.setAttribute('title', '打开双语字幕多维设置面板');
  gearTrigger.style.cssText = `
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    margin-left: 2px !important;
    padding-left: 4px !important;
    border-left: 1px solid rgba(255, 255, 255, 0.32) !important;
    font-size: 11px !important;
    cursor: pointer !important;
    pointer-events: auto !important;
  `;
  gearTrigger.textContent = '⚙';

  pill.appendChild(icon);
  pill.appendChild(label);
  pill.appendChild(gearTrigger);
  btn.appendChild(pill);
}

/**
 * 切换双语字幕开关状态
 */
function toggleSubtitles(enabled?: boolean): void {
  isSubtitlesEnabled = enabled !== undefined ? enabled : !isSubtitlesEnabled;
  updateSubtitleConfig({ enabled: isSubtitlesEnabled });

  const bottomBtn = document.getElementById('translate-king-yt-control-btn');
  if (bottomBtn) updateButtonVisual(bottomBtn, true);

  if (isSubtitlesEnabled) {
    showPlayerStatusToast('🌐 双语字幕：已开启 (点击 ⚙ 可调字号/颜色/位置)');
    if (!nativeObserver) {
      nativeObserver = new NativeCaptionObserver(currentTargetLang);
    }
    nativeObserver.ensureNativeCcEnabled();
    nativeObserver.start();
  } else {
    showPlayerStatusToast('🌐 双语字幕：已关闭');
    if (nativeObserver) {
      nativeObserver.stop();
    }
  }
}

/**
 * 确保播放器控制条按钮、视频总结按钮与 Native Observer 全部挂载就绪
 */
export function ensurePlayerMounted(): boolean {
  if (typeof document === 'undefined') return false;

  cleanupLegacyElements();

  const injectedBottom = injectBottomControls();
  const injectedSummary = injectSummaryActionButton();

  try {
    if (!nativeObserver) {
      nativeObserver = new NativeCaptionObserver(currentTargetLang);
    }

    if (isSubtitlesEnabled) {
      nativeObserver.start();
      nativeObserver.ensureNativeCcEnabled();
    }
  } catch (err) {
    console.warn('[TranslateKing YouTube] 启动字幕观察器异常:', err);
  }

  return injectedBottom || injectedSummary;
}

/**
 * 核心初始化函数：随视频加载与切视频 (SPA yt-navigate-finish) 自动触发
 */
export async function initYouTubeSubtitles(targetLang: TargetLanguage = 'zh-CN'): Promise<void> {
  if (!isYouTube()) return;

  currentTargetLang = targetLang;
  if (nativeObserver) {
    nativeObserver.setTargetLang(targetLang);
  }
  if (summaryPanel) {
    summaryPanel.setTargetLang(targetLang);
  }

  const videoId = getVideoIdFromUrl();

  // 切视频或回退到首页/搜索列表时立即重置状态并清理上一个视频的总结面板
  if (videoId !== currentVideoId) {
    currentVideoId = videoId;
    if (nativeObserver) {
      nativeObserver.resetVideo();
    }
    if (summaryPanel) {
      summaryPanel.resetForNewVideo(videoId);
    }
    const staleSummary = typeof document !== 'undefined' ? document.getElementById('translate-king-yt-summary-panel') : null;
    if (staleSummary) staleSummary.remove();
    const staleMenu = typeof document !== 'undefined' ? document.getElementById('translate-king-yt-subtitle-menu') : null;
    if (staleMenu) staleMenu.remove();
  }

  if (!videoId) {
    return;
  }

  cleanupLegacyElements();
  ensurePlayerMounted();

  let attempts = 0;
  const pollTimer = setInterval(() => {
    attempts++;
    ensurePlayerMounted();

    if (attempts >= 20) {
      clearInterval(pollTimer);
    }
  }, 250);
}

/**
 * 启动动态 DOM 监听引擎
 */
function setupDOMObserver(): void {
  if (domObserver || typeof document === 'undefined') return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  domObserver = new MutationObserver(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      ensurePlayerMounted();
    }, 120);
  });

  const root = document.body || document.documentElement;
  if (root) {
    domObserver.observe(root, {
      childList: true,
      subtree: true
    });
  }
}

/**
 * 启动 YouTube 全局监听器（带防重注入清理机制）
 */
export function setupYouTubeLifecycle(targetLang: TargetLanguage = 'zh-CN'): void {
  if (!isYouTube()) return;

  initSubtitleConfig();
  isSubtitlesEnabled = getSubtitleConfig().enabled;
  currentTargetLang = targetLang;

  if (isLifecycleSetup) {
    initYouTubeSubtitles(currentTargetLang);
    return;
  }

  // 若页面由于扩展重载曾运行过旧实例，先清理旧实例定时器
  if (typeof window !== 'undefined' && typeof (window as any).__TK_YT_CLEANUP__ === 'function') {
    try {
      (window as any).__TK_YT_CLEANUP__();
    } catch (_) {}
  }

  isLifecycleSetup = true;

  const onNav = () => initYouTubeSubtitles(currentTargetLang);
  window.addEventListener('yt-navigate-finish', onNav);
  document.addEventListener('yt-navigate-finish', onNav);
  window.addEventListener('popstate', onNav);

  setupDOMObserver();

  heartbeatTimer = setInterval(() => {
    const v = getVideoIdFromUrl();
    if (v !== currentVideoId) {
      initYouTubeSubtitles(currentTargetLang);
    } else if (v) {
      ensurePlayerMounted();
    }
  }, 800);

  if (typeof window !== 'undefined') {
    (window as any).__TK_YT_CLEANUP__ = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
      if (nativeObserver) {
        nativeObserver.stop();
      }
      window.removeEventListener('yt-navigate-finish', onNav);
      document.removeEventListener('yt-navigate-finish', onNav);
      window.removeEventListener('popstate', onNav);
    };
  }

  initYouTubeSubtitles(currentTargetLang);
}
