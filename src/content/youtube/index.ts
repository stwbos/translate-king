/**
 * 翻译王 (TranslateKing) - YouTube 实时双语字幕引擎总控入口
 *
 * 核心联动流程：
 * 1. 域名守卫：仅在 youtube.com 下静默激活
 * 2. MAIN 世界通信打通：通过 yt-bridge.js 与 postMessage 突破 MV3 隔离沙箱，100% 捕获带鉴权签名的 captionTracks
 * 3. 提取合法签名字幕轨道，通过 ASR Sentence Merger 管道清洗
 * 4. 挂载 Sliding Window 调度器与 Overlay 渲染层，无缝实现毫秒级双语对齐与悬停自动暂停查词
 * 5. 播放器右下角控制栏原生挂载 [双语] 快捷开关，清晰可视！
 */

import { selectBestEnglishTrack, fetchAndParseSubtitles, parseJson3EventsToCues, normalizeTimedTextUrl } from './extractor';
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
 * 向 YouTube 播放器右下角控制条注入原生外观的 [双语] 切换按钮
 */
function injectPlayerControls(): void {
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
    updateButtonVisual(btn);
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
    return;
  }

  try {
    const cues = await fetchAndParseSubtitles(bestTrack);
    if (cues.length === 0) return;

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

    injectPlayerControls();
    bindVideoTimeListener();
  } catch (err) {
    console.warn('[TranslateKing YouTube] 解析字幕异常:', err);
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
      injectPlayerControls();
      bindVideoTimeListener();
    }
  } catch (_) {
    // ignore
  }
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

  // 1. 动态注入 MAIN 世界通信桥
  injectMainWorldBridge();

  // 2. 轮询查找播放器并挂载 Overlay 与控制按钮
  let attempts = 0;
  const pollTimer = setInterval(() => {
    attempts++;
    const player = document.getElementById('movie_player');
    if (player) {
      if (!overlay) overlay = new SubtitleOverlay();
      overlay.init();
      injectPlayerControls();

      // 向 MAIN 世界主动索取当前视频字幕轨道
      window.postMessage({ type: 'TK_REQUEST_YT_TRACKS' }, '*');
    }

    if (hasLoadedForCurrentVideo || attempts >= 25) {
      clearInterval(pollTimer);
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

  // 2. YouTube 专属 SPA 页面跳转事件
  window.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 3. 传统 popstate 与初始加载保底
  window.addEventListener('popstate', () => {
    initYouTubeSubtitles(currentTargetLang);
  });

  // 立即触发初次初始化
  initYouTubeSubtitles(currentTargetLang);
}
