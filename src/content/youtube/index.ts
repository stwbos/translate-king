/**
 * 翻译王 (TranslateKing) - YouTube 实时双语字幕引擎总控入口
 *
 * 核心联动流程：
 * 1. 域名守卫：仅在 youtube.com 下静默激活
 * 2. 四重字幕嗅探流水线 (Quad-Insurance Extraction Pipeline)：
 *    - 通道 1: 0ms 同步读取 document.scripts 内置 captionTracks (沙箱无关、秒级直出)
 *    - 通道 2: MAIN 世界 yt-bridge.js 通信广播
 *    - 通道 3: 原生 fetch 拦截截获带签名的 /api/timedtext 请求
 *    - 通道 4: 异步 HTML 容灾拉取解析
 * 3. 播放器右上角悬浮徽标 + 右下角控制条 [双语 ON] 按钮双重挂载，状态一目了然！
 * 4. 挂载 Sliding Window 调度器与 Overlay 渲染层，无缝实现毫秒级双语对齐与悬停自动暂停查词
 */

import {
  selectBestEnglishTrack,
  fetchAndParseSubtitles,
  parseJson3EventsToCues,
  normalizeTimedTextUrl,
  extractCaptionTracksFromDom
} from './extractor';
import { SubtitleScheduler } from './scheduler';
import { SubtitleOverlay } from './overlay';
import { TargetLanguage } from '../../types';

let scheduler: SubtitleScheduler | null = null;
let overlay: SubtitleOverlay | null = null;
let currentVideoId: string | null = null;
let currentTargetLang: TargetLanguage = 'zh-CN';
let isSubtitlesEnabled = true;
let timeupdateCleanup: (() => void) | null = null;
let hasLoadedForCurrentVideo = false;

function isYouTube(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname.includes('youtube.com');
}

function getVideoIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const v = params.get('v');
  if (v) return v;

  // 兼容 YouTube Shorts (/shorts/ID)
  const match = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * 动态注入 MAIN 世界通信桥接脚本
 */
function injectMainWorldBridge(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('translate-king-yt-bridge')) return;

  const script = document.createElement('script');
  script.id = 'translate-king-yt-bridge';
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    script.src = chrome.runtime.getURL('yt-bridge.js');
    (document.head || document.documentElement).appendChild(script);
  }
}

/**
 * 在视频播放器右上角挂载专属状态徽标 (无论控制栏是否隐藏，悬停画面永远可见)
 */
function injectPlayerBadge(statusText: string, statusType: 'active' | 'loading' | 'no-captions' | 'off' = 'loading'): void {
  const player = document.getElementById('movie_player');
  if (!player) return;

  let badge = document.getElementById('translate-king-yt-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'translate-king-yt-badge';
    badge.className = 'translate-king-yt-badge';
    badge.setAttribute('translate', 'no');
    badge.style.cssText = `
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 59;
      pointer-events: auto;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      transition: all 0.2s ease;
      user-select: none;
    `;

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      isSubtitlesEnabled = !isSubtitlesEnabled;
      updateAllControls();
      if (!isSubtitlesEnabled && overlay) {
        overlay.renderCue(null);
      }
    });

    player.appendChild(badge);
  }

  // 样式状态机
  if (!isSubtitlesEnabled) {
    badge.style.background = 'rgba(15, 23, 42, 0.75)';
    badge.style.border = '1px solid rgba(255, 255, 255, 0.2)';
    badge.style.color = '#94a3b8';
    badge.innerHTML = `<span>👑</span><span>双语字幕: OFF</span>`;
    badge.title = '翻译王：双语字幕已关闭 (点击开启)';
  } else if (statusType === 'active') {
    badge.style.background = 'rgba(15, 23, 42, 0.88)';
    badge.style.border = '1px solid #F59E0B';
    badge.style.color = '#FEF08A';
    badge.innerHTML = `<span>👑</span><span>双语字幕: ON</span>`;
    badge.title = '翻译王：双语字幕已开启并同步 (点击关闭)';
  } else if (statusType === 'no-captions') {
    badge.style.background = 'rgba(15, 23, 42, 0.75)';
    badge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
    badge.style.color = '#f87171';
    badge.innerHTML = `<span>⚠️</span><span>本视频暂无字幕</span>`;
    badge.title = '该 YouTube 视频未包含任何英文字幕或 CC 轨道';
  } else {
    badge.style.background = 'rgba(15, 23, 42, 0.85)';
    badge.style.border = '1px solid rgba(245, 158, 11, 0.5)';
    badge.style.color = '#cbd5e1';
    badge.innerHTML = `<span>⏳</span><span>${statusText}</span>`;
  }
}

/**
 * 向 YouTube 播放器右下角控制条注入原生外观的 [双语] 切换按钮
 */
function injectBottomControls(): void {
  const rightControls = document.querySelector('.ytp-right-controls');
  if (!rightControls) return;

  const existingBtn = document.getElementById('translate-king-yt-control-btn');
  if (existingBtn) {
    updateButtonVisual(existingBtn);
    return;
  }

  const btn = document.createElement('button');
  btn.id = 'translate-king-yt-control-btn';
  btn.className = 'ytp-button translate-king-yt-control-btn';
  btn.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: top;
    margin: 0 4px;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    isSubtitlesEnabled = !isSubtitlesEnabled;
    updateAllControls();
    if (!isSubtitlesEnabled && overlay) {
      overlay.renderCue(null);
    }
  });

  updateButtonVisual(btn);

  // 插入在设置齿轮或全屏按钮前
  const settingsBtn = rightControls.querySelector('.ytp-settings-button');
  if (settingsBtn) {
    rightControls.insertBefore(btn, settingsBtn);
  } else {
    rightControls.prepend(btn);
  }
}

function updateButtonVisual(btn: HTMLElement): void {
  if (isSubtitlesEnabled) {
    btn.innerHTML = `<span style="background: linear-gradient(135deg, #F59E0B, #EAB308); color: #000; padding: 2px 7px; border-radius: 4px; font-weight: bold; font-size: 11px; letter-spacing: 0.5px; box-shadow: 0 1px 3px rgba(0,0,0,0.4);">双语 ON</span>`;
    btn.setAttribute('title', '翻译王：双语字幕已开启 (点击关闭)');
  } else {
    btn.innerHTML = `<span style="background: rgba(255,255,255,0.2); color: #aaa; padding: 2px 7px; border-radius: 4px; font-size: 11px;">双语 OFF</span>`;
    btn.setAttribute('title', '翻译王：双语字幕已关闭 (点击开启)');
  }
}

function updateAllControls(): void {
  const btn = document.getElementById('translate-king-yt-control-btn');
  if (btn) updateButtonVisual(btn);
  injectPlayerBadge(
    hasLoadedForCurrentVideo ? '双语字幕: ON' : '正在连接...',
    hasLoadedForCurrentVideo ? 'active' : 'loading'
  );
}

/**
 * 绑定视频播放器时间轴监听
 */
function bindVideoTimeListener(): void {
  const video = document.querySelector('#movie_player video') as HTMLVideoElement | null;
  if (!video || !scheduler) return;

  if (timeupdateCleanup) {
    timeupdateCleanup();
    timeupdateCleanup = null;
  }

  const onTimeUpdate = () => {
    if (isSubtitlesEnabled && scheduler && video) {
      scheduler.onTimeUpdate(video.currentTime * 1000);
    }
  };

  const onSeeking = () => {
    if (isSubtitlesEnabled && scheduler && video) {
      scheduler.onSeek(video.currentTime * 1000);
    }
  };

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('seeking', onSeeking);

  timeupdateCleanup = () => {
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('seeking', onSeeking);
  };

  onTimeUpdate();
}

/**
 * 处理成功捕获的字幕轨道列表
 */
async function handleTracksReceived(tracks: any[]): Promise<void> {
  if (!isYouTube()) return;
  const bestTrack = selectBestEnglishTrack(tracks);
  if (!bestTrack) {
    console.log('[TranslateKing YouTube] 当前视频未检测到英文字幕轨道');
    injectPlayerBadge('本视频暂无字幕', 'no-captions');
    return;
  }

  try {
    const cues = await fetchAndParseSubtitles(bestTrack);
    if (cues.length === 0) {
      injectPlayerBadge('本视频暂无字幕', 'no-captions');
      return;
    }

    hasLoadedForCurrentVideo = true;
    console.log(`[TranslateKing YouTube] 字幕加载就绪，共 ${cues.length} 个双语句段`);

    if (!scheduler) {
      scheduler = new SubtitleScheduler(currentTargetLang);
    }
    if (!overlay) {
      overlay = new SubtitleOverlay();
    }

    overlay.init();
    scheduler.loadCues(cues, currentTargetLang);
    scheduler.subscribe((cue) => {
      if (isSubtitlesEnabled && overlay) {
        overlay.renderCue(cue);
      }
    });

    injectBottomControls();
    injectPlayerBadge('双语字幕: ON', 'active');
    bindVideoTimeListener();
  } catch (err) {
    console.warn('[TranslateKing YouTube] 解析字幕异常:', err);
    injectPlayerBadge('字幕解析失败', 'no-captions');
  }
}

/**
 * 处理原生播放器网络请求拦截到的 timedtext 地址
 */
async function handleNativeTimedTextUrl(rawUrl: string): Promise<void> {
  if (!isYouTube() || hasLoadedForCurrentVideo) return;

  try {
    const targetUrl = normalizeTimedTextUrl(rawUrl);
    const response = await fetch(targetUrl);
    if (!response.ok) return;

    const data = await response.json();
    const events = data.events || [];
    const isAsr = rawUrl.includes('kind=asr') || rawUrl.includes('a.');
    const cues = parseJson3EventsToCues(events, isAsr);

    if (cues.length > 0) {
      hasLoadedForCurrentVideo = true;
      if (!scheduler) scheduler = new SubtitleScheduler(currentTargetLang);
      if (!overlay) overlay = new SubtitleOverlay();
      overlay.init();
      scheduler.loadCues(cues, currentTargetLang);
      scheduler.subscribe((cue) => {
        if (isSubtitlesEnabled && overlay) overlay.renderCue(cue);
      });
      injectBottomControls();
      injectPlayerBadge('双语字幕: ON', 'active');
      bindVideoTimeListener();
    }
  } catch (_) {
    // ignore
  }
}

/**
 * 尝试通过页面内 HTML 容灾提取字幕
 */
async function tryExtractFromPageFetch(videoId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    if (!res.ok) return false;
    const html = await res.text();
    const match = html.match(/"captionTracks":\s*(\[.+?\])/);
    if (match) {
      const cleaned = match[1].replace(/\\u0026/g, '&');
      const tracks = JSON.parse(cleaned);
      if (Array.isArray(tracks) && tracks.length > 0) {
        await handleTracksReceived(tracks);
        return true;
      }
    }
  } catch (_) {
    // ignore
  }
  return false;
}

/**
 * 核心初始化函数：随视频加载与切视频 (SPA yt-navigate-finish) 自动触发
 */
export async function initYouTubeSubtitles(targetLang: TargetLanguage = 'zh-CN'): Promise<void> {
  if (!isYouTube()) return;

  currentTargetLang = targetLang;
  const videoId = getVideoIdFromUrl();
  if (!videoId) {
    if (overlay) overlay.renderCue(null);
    return;
  }

  // 切视频重置状态
  if (videoId !== currentVideoId) {
    currentVideoId = videoId;
    hasLoadedForCurrentVideo = false;
    if (overlay) overlay.renderCue(null);
  }

  // 1. 尝试通道 1: 0ms 同步从当前页面 DOM scripts 提取
  const domTracks = extractCaptionTracksFromDom(document);
  if (domTracks && domTracks.length > 0) {
    await handleTracksReceived(domTracks);
    return;
  }

  // 2. 动态注入 MAIN 世界通信桥
  injectMainWorldBridge();
  injectPlayerBadge('正在加载字幕...', 'loading');

  // 3. 轮询查找播放器并挂载 Overlay 与控制按钮
  let attempts = 0;
  const pollTimer = setInterval(async () => {
    attempts++;
    const player = document.getElementById('movie_player');
    if (player) {
      if (!overlay) overlay = new SubtitleOverlay();
      overlay.init();
      injectBottomControls();
      injectPlayerBadge(hasLoadedForCurrentVideo ? '双语字幕: ON' : '正在读取轨道...', hasLoadedForCurrentVideo ? 'active' : 'loading');

      // 向 MAIN 世界主动索取当前视频字幕轨道
      window.postMessage({ type: 'TK_REQUEST_YT_TRACKS' }, '*');
    }

    // 若超过 10 次 (2.5秒) 仍未就绪，启动通道 4: 直接抓取网页 HTML 容灾解析
    if (!hasLoadedForCurrentVideo && attempts === 10) {
      tryExtractFromPageFetch(videoId);
    }

    if (hasLoadedForCurrentVideo || attempts >= 40) {
      clearInterval(pollTimer);
      if (!hasLoadedForCurrentVideo && attempts >= 40) {
        injectPlayerBadge('本视频暂无字幕', 'no-captions');
      }
    }
  }, 250);
}

/**
 * 启动 YouTube 全局监听器（监听 SPA 切视频与页面导航）
 */
export function setupYouTubeLifecycle(targetLang: TargetLanguage = 'zh-CN'): void {
  if (!isYouTube()) return;

  currentTargetLang = targetLang;

  // 1. 监听来自 MAIN 世界桥接脚本发出的广播
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'TK_YT_CAPTIONS_READY') {
      if (e.data.tracks) {
        handleTracksReceived(e.data.tracks);
      }
    } else if (e.data && e.data.type === 'TK_YT_NATIVE_TIMEDTEXT_URL') {
      if (e.data.url) {
        handleNativeTimedTextUrl(e.data.url);
      }
    }
  });

  // 2. YouTube 专属 SPA 页面跳转事件（window 与 document 双监听）
  window.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });
  document.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 3. 传统 popstate 与初始加载保底
  window.addEventListener('popstate', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 4. 定时兜底巡检：防止 SPA 无刷新跳转漏判视频切换
  setInterval(() => {
    const v = getVideoIdFromUrl();
    if (v && v !== currentVideoId) {
      initYouTubeSubtitles(currentTargetLang);
    } else if (v && !hasLoadedForCurrentVideo && isSubtitlesEnabled) {
      const domTracks = extractCaptionTracksFromDom(document);
      if (domTracks && domTracks.length > 0) {
        handleTracksReceived(domTracks);
      }
    }
  }, 1000);

  // 立即触发初次初始化
  initYouTubeSubtitles(currentTargetLang);
}
