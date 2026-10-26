/**
 * 翻译王 (TranslateKing) - YouTube 实时双语字幕引擎总控入口
 *
 * 核心联动流程：
 * 1. 域名守卫：仅在 youtube.com 下静默激活
 * 2. SPA 路由与播放器状态嗅探：监听 yt-navigate-finish 与播放器加载
 * 3. 提取合法签名字幕轨道，通过 ASR Sentence Merger 管道清洗
 * 4. 挂载 Sliding Window 调度器与 Overlay 渲染层，无缝实现毫秒级双语对齐与悬停自动暂停查词
 */

import { selectBestEnglishTrack, fetchAndParseSubtitles } from './extractor';
import { SubtitleScheduler } from './scheduler';
import { SubtitleOverlay } from './overlay';
import { TargetLanguage } from '../../types';

let scheduler: SubtitleScheduler | null = null;
let overlay: SubtitleOverlay | null = null;
let currentVideoId: string | null = null;
let timeupdateCleanup: (() => void) | null = null;

function isYouTube(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname.includes('youtube.com');
}

function getVideoIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('v');
}

/**
 * 核心初始化函数：随视频加载与切视频 (SPA yt-navigate-finish) 自动触发
 */
export async function initYouTubeSubtitles(targetLang: TargetLanguage = 'zh-CN'): Promise<void> {
  if (!isYouTube()) return;

  const videoId = getVideoIdFromUrl();
  if (!videoId) {
    if (overlay) overlay.renderCue(null);
    return;
  }

  // 若已是同一视频且已初始化，无需重复重建
  if (videoId === currentVideoId && scheduler && overlay) {
    return;
  }
  currentVideoId = videoId;

  // 清理前序监听
  if (timeupdateCleanup) {
    timeupdateCleanup();
    timeupdateCleanup = null;
  }

  if (!scheduler) {
    scheduler = new SubtitleScheduler(targetLang);
  }
  if (!overlay) {
    overlay = new SubtitleOverlay();
  }

  overlay.init();
  scheduler.subscribe((cue) => {
    overlay?.renderCue(cue);
  });

  // 轮询等待 #movie_player 播放器与其内部 API 准备就绪 (最多等待 6 秒)
  let attempts = 0;
  const pollPlayer = setInterval(async () => {
    attempts++;
    const player = document.getElementById('movie_player') as any;
    const video = document.querySelector('#movie_player video') as HTMLVideoElement | null;

    if (player && typeof player.getPlayerResponse === 'function' && video) {
      clearInterval(pollPlayer);

      try {
        const response = player.getPlayerResponse();
        const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const bestTrack = selectBestEnglishTrack(tracks);

        if (bestTrack) {
          console.log(`[TranslateKing YouTube] 成功捕获有效字幕轨道: ${bestTrack.languageCode} (${bestTrack.kind || 'human CC'})`);
          const cues = await fetchAndParseSubtitles(bestTrack);
          console.log(`[TranslateKing YouTube] 字幕断句清洗完成，共就绪 ${cues.length} 个完整双语句段`);

          scheduler?.loadCues(cues, targetLang);

          // 绑定视频高频时间推进
          const onTimeUpdate = () => {
            if (video && scheduler) {
              scheduler.onTimeUpdate(video.currentTime * 1000);
            }
          };

          const onSeeking = () => {
            if (video && scheduler) {
              scheduler.onSeek(video.currentTime * 1000);
            }
          };

          video.addEventListener('timeupdate', onTimeUpdate);
          video.addEventListener('seeking', onSeeking);

          timeupdateCleanup = () => {
            video.removeEventListener('timeupdate', onTimeUpdate);
            video.removeEventListener('seeking', onSeeking);
          };

          // 立即触发一次初屏时间同步
          onTimeUpdate();
        } else {
          console.log('[TranslateKing YouTube] 当前视频未检测到官方或 ASR 英文字幕轨道');
        }
      } catch (err) {
        console.warn('[TranslateKing YouTube] 加载双语字幕异常:', err);
      }
    }

    if (attempts >= 30) {
      clearInterval(pollPlayer);
    }
  }, 200);
}

/**
 * 启动 YouTube 全局监听器（监听 SPA 切视频与页面导航）
 */
export function setupYouTubeLifecycle(targetLang: TargetLanguage = 'zh-CN'): void {
  if (!isYouTube()) return;

  // 1. YouTube 专属 SPA 页面跳转事件
  window.addEventListener('yt-navigate-finish', () => {
    initYouTubeSubtitles(targetLang);
  });

  // 2. 传统 popstate 与初始加载保底
  window.addEventListener('popstate', () => {
    initYouTubeSubtitles(targetLang);
  });

  // 立即尝试初次初始化
  initYouTubeSubtitles(targetLang);
}
