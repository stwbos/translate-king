/**
 * 翻译王 (TranslateKing) - YouTube 实时双语字幕引擎总控入口
 *
 * 核心联动流程：
 * 1. 域名守卫：仅在 youtube.com 下静默激活
 * 2. 双重全冗余字幕获取架构 (Dual-Insurance Acquisition Architecture)：
 *    - 坚盾驱动 (NativeCaptionObserver): 100% 免疫 pot 校验，实时毫秒级捕获原生字幕，随视频播放瞬态流转
 *    - 主航道拦截 (Sliding Window): MAIN 世界拦截合法 signed timedtext，由 SubtitleScheduler 调度二分查找与提前 120 秒预取
 * 3. 播放器右上角专属徽标 + 控制条 [双语 ON] 切换按钮双重挂载，自愈防丢。
 * 4. 样式安全隔离：开启时透明隐藏原生单语黑框并呈现影院级双语，关闭时 100% 还原 YouTube 原生字幕。
 * 5. 电影级排版与悬停自动暂停 (Hover-Pause)，从容查词与生词本联动。
 */

import {
  selectBestEnglishTrack,
  fetchAndParseSubtitles,
  parseSubtitlePayload,
  extractCaptionTracksFromDom
} from './extractor';
import { SubtitleScheduler } from './scheduler';
import { SubtitleOverlay } from './overlay';
import { NativeCaptionObserver } from './native-observer';
import { TargetLanguage } from '../../types';

let scheduler: SubtitleScheduler | null = null;
let overlay: SubtitleOverlay | null = null;
let nativeObserver: NativeCaptionObserver | null = null;
let currentVideoId: string | null = null;
let currentTargetLang: TargetLanguage = 'zh-CN';
let isSubtitlesEnabled = true;
let timeupdateCleanup: (() => void) | null = null;
let hasLoadedCues = false;
let isLifecycleSetup = false;

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
 * 挂载或更新播放器右上角状态徽标
 */
function injectPlayerBadge(statusText: string, statusType: 'active' | 'loading' | 'no-captions' | 'off' = 'active'): void {
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
      toggleSubtitles();
    });

    player.appendChild(badge);
  }

  // 样式状态机
  if (!isSubtitlesEnabled || statusType === 'off') {
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
    badge.title = '翻译王：双语字幕已开启并随视频同步推进 (点击关闭)';
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
    toggleSubtitles();
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
    isSubtitlesEnabled ? '双语字幕: ON' : '双语字幕: OFF',
    isSubtitlesEnabled ? 'active' : 'off'
  );
}

/**
 * 切换字幕开关状态
 */
function toggleSubtitles(enabled?: boolean): void {
  isSubtitlesEnabled = enabled !== undefined ? enabled : !isSubtitlesEnabled;
  updateAllControls();

  if (overlay) {
    overlay.setActive(isSubtitlesEnabled);
  }

  if (isSubtitlesEnabled) {
    if (nativeObserver) {
      nativeObserver.start();
      nativeObserver.ensureNativeCcEnabled();
    }
    const video = document.querySelector('#movie_player video') as HTMLVideoElement | null;
    if (video && scheduler && scheduler.hasCues()) {
      scheduler.onTimeUpdate(video.currentTime * 1000);
    }
  } else {
    if (nativeObserver) {
      nativeObserver.stop();
    }
    if (overlay) {
      overlay.renderCue(null);
    }
  }
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
 * 确保播放器容器、Overlay、Badge、Bottom Controls 与 Native Observer 全部挂载就绪 (自愈无条件挂载)
 */
function ensurePlayerMounted(): boolean {
  if (typeof document === 'undefined') return false;
  const player = document.getElementById('movie_player');
  if (!player) return false;

  // 1. 确保字幕渲染器挂载并设置激活态
  if (!overlay) {
    overlay = new SubtitleOverlay();
  }
  overlay.init();
  overlay.setActive(isSubtitlesEnabled);

  // 2. 确保右上角徽标挂载
  injectPlayerBadge(
    isSubtitlesEnabled ? '双语字幕: ON' : '双语字幕: OFF',
    isSubtitlesEnabled ? 'active' : 'off'
  );

  // 3. 确保控制栏底部按钮挂载
  injectBottomControls();

  // 4. 确保 Native Caption Observer 启动并监听
  if (!nativeObserver) {
    nativeObserver = new NativeCaptionObserver(currentTargetLang);
  }

  if (isSubtitlesEnabled) {
    nativeObserver.start();
    nativeObserver.ensureNativeCcEnabled();
  }

  // 5. 绑定时间轴监听
  if (scheduler && scheduler.hasCues()) {
    bindVideoTimeListener();
  }

  return true;
}

/**
 * 载入高精度字幕段入调度器，接管滑动窗口翻译
 */
function loadCuesIntoScheduler(cues: any[]): void {
  if (!cues || cues.length === 0) return;

  hasLoadedCues = true;
  console.log(`[TranslateKing YouTube] 成功载入全片字幕流，共 ${cues.length} 个句段`);

  if (!scheduler) {
    scheduler = new SubtitleScheduler(currentTargetLang);
  }
  if (!overlay) {
    overlay = new SubtitleOverlay();
  }
  overlay.init();
  overlay.setActive(isSubtitlesEnabled);

  scheduler.loadCues(cues, currentTargetLang);
  scheduler.subscribe((cue) => {
    if (isSubtitlesEnabled && overlay) {
      overlay.renderCue(cue);
    }
  });

  injectPlayerBadge('双语字幕: ON', 'active');
  injectBottomControls();
  bindVideoTimeListener();
}

/**
 * 处理拦截到的原生 timedtext 完整载荷 (XML 或 JSON3)
 */
function handleInterceptedTimedText(payloadText: string, url = ''): void {
  if (!isYouTube() || hasLoadedCues) return;

  try {
    const isAsr = url.includes('kind=asr') || url.includes('a.');
    const cues = parseSubtitlePayload(payloadText, isAsr);
    if (cues && cues.length > 0) {
      loadCuesIntoScheduler(cues);
    }
  } catch (err) {
    console.warn('[TranslateKing YouTube] 解析拦截 timedtext 载荷异常:', err);
  }
}

/**
 * 处理成功捕获的字幕轨道列表
 */
async function handleTracksReceived(tracks: any[]): Promise<void> {
  if (!isYouTube() || hasLoadedCues) return;
  const bestTrack = selectBestEnglishTrack(tracks);
  if (!bestTrack) {
    return;
  }

  try {
    const cues = await fetchAndParseSubtitles(bestTrack);
    if (cues && cues.length > 0) {
      loadCuesIntoScheduler(cues);
    }
  } catch (_) {
    // 0 字节或 pot 校验时静默由 NativeObserver 接管
  }
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
  if (!videoId) {
    if (overlay) overlay.renderCue(null);
    return;
  }

  // 切视频重置状态
  if (videoId !== currentVideoId) {
    currentVideoId = videoId;
    hasLoadedCues = false;
    if (scheduler) {
      scheduler.destroy();
      scheduler = null;
    }
    if (nativeObserver) {
      nativeObserver.resetVideo();
    }
    if (overlay) {
      overlay.setActive(isSubtitlesEnabled);
      overlay.renderCue(null);
    }
  }

  // 1. 动态注入 MAIN 世界通信桥
  injectMainWorldBridge();

  // 2. 无论网络请求状态如何，第一时间无条件挂载播放器 UI 控件与 Observer
  ensurePlayerMounted();

  // 3. 轮询巡检挂载（确保 SPA 异步渲染 controls 或 video 挂载时立即贴合）
  let attempts = 0;
  const pollTimer = setInterval(() => {
    attempts++;
    ensurePlayerMounted();

    // 向 MAIN 世界主动索取当前视频字幕轨道
    window.postMessage({ type: 'TK_REQUEST_YT_TRACKS' }, '*');

    if (hasLoadedCues || attempts >= 16) {
      clearInterval(pollTimer);
    }
  }, 250);

  // 4. 同步尝试从当前页面 DOM scripts 读取字幕轨道
  const domTracks = extractCaptionTracksFromDom(document);
  if (domTracks && domTracks.length > 0) {
    handleTracksReceived(domTracks);
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

  // 1. 监听来自 MAIN 世界桥接脚本发出的广播
  window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.type === 'TK_YT_CAPTIONS_READY' && e.data.tracks) {
      handleTracksReceived(e.data.tracks);
    } else if (e.data.type === 'TK_YT_INTERCEPTED_TIMEDTEXT' && e.data.body) {
      handleInterceptedTimedText(e.data.body, e.data.url);
    }
  });

  // 2. YouTube 专属 SPA 页面跳转事件（window 与 document 双监听）
  window.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });
  document.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 3. 传统 popstate 保底
  window.addEventListener('popstate', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 4. 定时心跳巡检：保证 SPA 无刷新切换及控制栏重绘时控件永远存在
  setInterval(() => {
    const v = getVideoIdFromUrl();
    if (v && v !== currentVideoId) {
      initYouTubeSubtitles(currentTargetLang);
    } else if (v) {
      ensurePlayerMounted();
    }
  }, 1000);

  // 立即触发初次初始化
  initYouTubeSubtitles(currentTargetLang);
}
