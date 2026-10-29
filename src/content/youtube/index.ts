/**
 * 翻译王 (TranslateKing) - YouTube 原生双语字幕总控入口
 *
 * 核心设计架构：
 * 1. 零破坏原生排版 (In-situ Native Integration)：
 *    - 不创建冗余独立的悬浮字幕遮罩层，直接在 YouTube 原生 .caption-window 内部原位注入第二行高对比度译文
 *    - 彻底消除“多个字幕重叠堆叠”问题，第一行白字英文原文 + 第二行亮金色中文译文，极其规整
 * 2. 双重高可用按键生态：
 *    - 位置 A（行业验证播放器底栏）：在播放器右下角控制条全屏按钮旁注入原生的 [双语 ON/OFF]
 *    - 位置 B（视频下方主操作栏常驻）：在视频标题正下方（点赞/分享按钮旁）注入永久可见的 [🌐 双语字幕 ON/OFF]，无需鼠标悬停视频即可一目了然一键切换！
 * 3. ASR 流式识别自适应对齐：
 *    - 解决逐词流式识别造成的“译文回填条件错位”竞态，只要当前字幕包含已翻译片段即秒级上屏，绝不定格卡死！
 */

import { NativeCaptionObserver } from './native-observer';
import { TargetLanguage } from '../../types';

let nativeObserver: NativeCaptionObserver | null = null;
let currentVideoId: string | null = null;
let currentTargetLang: TargetLanguage = 'zh-CN';
let isSubtitlesEnabled = true;
let isLifecycleSetup = false;
let domObserver: MutationObserver | null = null;

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

  // 兼容 YouTube Shorts (/shorts/ID), Live (/live/ID), Embed (/embed/ID)
  const match = window.location.pathname.match(/\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * 清除任何历史旧版遗留的悬浮遮罩或右上角徽标 (防止重叠与视觉污染)
 */
function cleanupLegacyElements(): void {
  if (typeof document === 'undefined') return;

  const oldBadge = document.getElementById('translate-king-yt-badge');
  if (oldBadge) oldBadge.remove();

  const oldOverlay = document.getElementById('translate-king-yt-overlay');
  if (oldOverlay) oldOverlay.remove();

  const oldStyles = document.getElementById('translate-king-yt-styles');
  if (oldStyles) oldStyles.remove();
}

/**
 * 向 YouTube 播放器右下角控制条（全屏按钮旁）注入原生的 [双语] 切换按钮
 */
function injectBottomControls(): boolean {
  if (typeof document === 'undefined') return false;

  // 优先寻找主播放器的右侧控制栏
  const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  const rightControls = (
    player?.querySelector('.ytp-right-controls') ||
    document.querySelector('.ytp-right-controls')
  ) as HTMLElement | null;

  if (!rightControls) return false;

  const existingBtn = document.getElementById('translate-king-yt-control-btn') as HTMLElement | null;
  if (existingBtn) {
    if (rightControls.contains(existingBtn)) {
      updateButtonVisual(existingBtn);
      return true;
    } else {
      existingBtn.remove();
    }
  }

  const btn = document.createElement('button');
  btn.id = 'translate-king-yt-control-btn';
  btn.className = 'ytp-button translate-king-yt-control-btn';
  btn.setAttribute('translate', 'no');
  btn.setAttribute('aria-label', '翻译王双语字幕');
  btn.style.cssText = `
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    vertical-align: top !important;
    width: auto !important;
    min-width: 76px !important;
    height: 100% !important;
    margin: 0 4px !important;
    padding: 0 2px !important;
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
    toggleSubtitles();
  });

  updateButtonVisual(btn);

  // 放置在全屏按钮 (.ytp-fullscreen-button) 前
  const fullscreenBtn = rightControls.querySelector('.ytp-fullscreen-button');
  if (fullscreenBtn) {
    rightControls.insertBefore(btn, fullscreenBtn);
  } else {
    rightControls.appendChild(btn);
  }

  return true;
}

/**
 * 向视频下方主操作栏（点赞/分享按钮旁）注入永久可见的 [🌐 双语字幕] 切换按钮
 * 即使鼠标移出播放器，也永远清晰可见！
 */
function injectActionBarControls(): boolean {
  if (typeof document === 'undefined') return false;

  const actionsContainer = (
    document.querySelector('#top-row #actions #menu ytd-menu-renderer') ||
    document.querySelector('#top-row #actions #actions-inner') ||
    document.querySelector('#top-row #actions') ||
    document.querySelector('ytd-watch-metadata #actions #menu') ||
    document.querySelector('ytd-watch-metadata #actions') ||
    document.querySelector('#actions.ytd-watch-metadata')
  ) as HTMLElement | null;

  if (!actionsContainer) return false;

  const existingBtn = document.getElementById('translate-king-yt-action-btn') as HTMLElement | null;
  if (existingBtn) {
    if (actionsContainer.contains(existingBtn)) {
      updateActionButtonVisual(existingBtn);
      return true;
    } else {
      existingBtn.remove();
    }
  }

  const btn = document.createElement('button');
  btn.id = 'translate-king-yt-action-btn';
  btn.className = 'translate-king-yt-action-btn';
  btn.setAttribute('translate', 'no');
  btn.setAttribute('aria-label', '翻译王双语字幕');
  btn.style.cssText = `
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
    height: 36px !important;
    padding: 0 16px !important;
    margin: 0 6px 0 0 !important;
    border-radius: 18px !important;
    font-size: 14px !important;
    font-weight: 600 !important;
    font-family: Roboto, -apple-system, sans-serif !important;
    cursor: pointer !important;
    border: none !important;
    outline: none !important;
    box-sizing: border-box !important;
    vertical-align: middle !important;
    user-select: none !important;
    transition: all 0.2s ease !important;
    z-index: 10 !important;
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleSubtitles();
  });

  updateActionButtonVisual(btn);

  if (actionsContainer.firstChild) {
    actionsContainer.insertBefore(btn, actionsContainer.firstChild);
  } else {
    actionsContainer.appendChild(btn);
  }

  return true;
}

function updateButtonVisual(btn: HTMLElement): void {
  if (isSubtitlesEnabled) {
    btn.innerHTML = `
      <span class="translate-king-btn-pill" style="
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        background: linear-gradient(135deg, #F59E0B, #EAB308) !important;
        color: #000000 !important;
        padding: 3px 8px !important;
        border-radius: 12px !important;
        font-weight: 700 !important;
        font-size: 11px !important;
        line-height: 14px !important;
        letter-spacing: 0.5px !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important;
        user-select: none !important;
        white-space: nowrap !important;
        height: 20px !important;
      ">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block !important; vertical-align:middle !important; flex-shrink: 0 !important;">
          <path d="M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
        </svg>
        <span>双语 ON</span>
      </span>
    `;
    btn.setAttribute('title', '翻译王：双语字幕已开启 (点击关闭)');
  } else {
    btn.innerHTML = `
      <span class="translate-king-btn-pill" style="
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        background: rgba(255,255,255,0.2) !important;
        color: #ffffff !important;
        padding: 3px 8px !important;
        border-radius: 12px !important;
        font-weight: 600 !important;
        font-size: 11px !important;
        line-height: 14px !important;
        letter-spacing: 0.5px !important;
        user-select: none !important;
        white-space: nowrap !important;
        height: 20px !important;
      ">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block !important; vertical-align:middle !important; flex-shrink: 0 !important;">
          <path d="M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
        </svg>
        <span>双语 OFF</span>
      </span>
    `;
    btn.setAttribute('title', '翻译王：双语字幕已关闭 (点击开启)');
  }
}

function updateActionButtonVisual(btn: HTMLElement): void {
  if (isSubtitlesEnabled) {
    btn.style.background = 'linear-gradient(135deg, #F59E0B, #EAB308)';
    btn.style.color = '#000000';
    btn.style.boxShadow = '0 2px 8px rgba(245, 158, 11, 0.4)';
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
      <span>双语字幕 ON</span>
    `;
    btn.setAttribute('title', '翻译王：双语字幕已开启 (点击关闭)');
  } else {
    btn.style.background = 'rgba(255, 255, 255, 0.12)';
    btn.style.color = '#ffffff';
    btn.style.boxShadow = 'none';
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </svg>
      <span>双语字幕 OFF</span>
    `;
    btn.setAttribute('title', '翻译王：双语字幕已关闭 (点击开启)');
  }
}

function updateAllControls(): void {
  const bottomBtn = document.getElementById('translate-king-yt-control-btn');
  if (bottomBtn) updateButtonVisual(bottomBtn);

  const actionBtn = document.getElementById('translate-king-yt-action-btn');
  if (actionBtn) updateActionButtonVisual(actionBtn);
}

/**
 * 切换字幕开关状态
 */
function toggleSubtitles(enabled?: boolean): void {
  isSubtitlesEnabled = enabled !== undefined ? enabled : !isSubtitlesEnabled;
  updateAllControls();

  if (isSubtitlesEnabled) {
    if (nativeObserver) {
      nativeObserver.start();
      nativeObserver.ensureNativeCcEnabled();
    }
  } else {
    if (nativeObserver) {
      nativeObserver.stop();
    }
  }
}

/**
 * 确保播放器控制条按钮、操作栏按钮与 Native Observer 全部挂载就绪 (自愈无条件挂载)
 */
export function ensurePlayerMounted(): boolean {
  if (typeof document === 'undefined') return false;

  cleanupLegacyElements();

  const injectedBottom = injectBottomControls();
  const injectedAction = injectActionBarControls();

  if (!nativeObserver) {
    nativeObserver = new NativeCaptionObserver(currentTargetLang);
  }

  if (isSubtitlesEnabled) {
    nativeObserver.start();
    nativeObserver.ensureNativeCcEnabled();
  }

  return injectedBottom || injectedAction;
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

  const videoId = getVideoIdFromUrl();

  // 切视频重置状态
  if (videoId && videoId !== currentVideoId) {
    currentVideoId = videoId;
    if (nativeObserver) {
      nativeObserver.resetVideo();
    }
  }

  cleanupLegacyElements();
  ensurePlayerMounted();

  // 轮询巡检挂载（确保 YouTube 控制条与操作栏异步就绪时第一时间插入）
  let attempts = 0;
  const pollTimer = setInterval(() => {
    attempts++;
    ensurePlayerMounted();

    if (attempts >= 16) {
      clearInterval(pollTimer);
    }
  }, 200);
}

/**
 * 启动动态 DOM 监听引擎：秒级捕捉控制条与操作栏的创建与重绘
 */
function setupDOMObserver(): void {
  if (domObserver || typeof document === 'undefined') return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  domObserver = new MutationObserver(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      ensurePlayerMounted();
    }, 50);
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
 * 启动 YouTube 全局监听器（监听 SPA 切视频与页面导航）
 */
export function setupYouTubeLifecycle(targetLang: TargetLanguage = 'zh-CN'): void {
  if (!isYouTube()) return;

  currentTargetLang = targetLang;

  if (isLifecycleSetup) {
    initYouTubeSubtitles(currentTargetLang);
    return;
  }
  isLifecycleSetup = true;

  // 1. YouTube 专属 SPA 页面跳转事件（window 与 document 双监听）
  window.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });
  document.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 2. 传统 popstate 保底
  window.addEventListener('popstate', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 3. 动态 DOM 监听引擎
  setupDOMObserver();

  // 4. 定时心跳自愈巡检：保证控制栏与操作栏在任何重绘后按键永远存在
  setInterval(() => {
    const v = getVideoIdFromUrl();
    if (v && v !== currentVideoId) {
      initYouTubeSubtitles(currentTargetLang);
    } else {
      ensurePlayerMounted();
    }
  }, 800);

  // 立即触发初次初始化
  initYouTubeSubtitles(currentTargetLang);
}
