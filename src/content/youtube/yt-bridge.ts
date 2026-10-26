/**
 * 翻译王 (TranslateKing) - YouTube MAIN 世界专有通信桥接脚本
 *
 * 核心设计：
 * 在 YouTube 页面的 MAIN 执行世界（与 YouTube 播放器同属相同 JS 上下文）运行：
 * 1. 穿透 Chrome MV3 隔离世界壁垒，直接调用 #movie_player.getPlayerResponse() 与 window.ytInitialPlayerResponse
 * 2. 拦截并监听 YouTube 原生 /api/timedtext 带有合法 pot 和 session 的字幕请求
 * 3. 监听 yt-navigate-finish 并在视频切换时通过 window.postMessage 向 Content Script 广播合法字幕轨道
 */

(function () {
  if ((window as any).__TRANSLATE_KING_YT_BRIDGE_INITIALIZED__) {
    return;
  }
  (window as any).__TRANSLATE_KING_YT_BRIDGE_INITIALIZED__ = true;

  function broadcastTracks(): boolean {
    let tracks: any[] | null = null;
    const player = document.getElementById('movie_player') as any;

    // 1. 优先调用播放器内核方法
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const response = player.getPlayerResponse();
        tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
      } catch (_) {
        // ignore
      }
    }

    // 2. 备用读取全局 ytInitialPlayerResponse
    if (!tracks && (window as any).ytInitialPlayerResponse) {
      try {
        tracks = (window as any).ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
      } catch (_) {
        // ignore
      }
    }

    if (tracks && Array.isArray(tracks) && tracks.length > 0) {
      window.postMessage(
        {
          type: 'TK_YT_CAPTIONS_READY',
          tracks: JSON.parse(JSON.stringify(tracks)),
          videoId: (player && typeof player.getVideoData === 'function') ? player.getVideoData()?.video_id : null
        },
        '*'
      );
      return true;
    }
    return false;
  }

  // 监听 YouTube 专属 SPA 页面与视频切换事件
  window.addEventListener('yt-navigate-finish', () => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (broadcastTracks() || attempts >= 20) {
        clearInterval(timer);
      }
    }, 250);
  });

  // 监听来自 Content Script 的主动索取广播
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'TK_REQUEST_YT_TRACKS') {
      broadcastTracks();
    }
  });

  // 拦截/侦听原生 fetch 请求，若播放器自身发起了 /api/timedtext，捕获真实带参 URL
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args: any[]) {
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          window.postMessage(
            {
              type: 'TK_YT_NATIVE_TIMEDTEXT_URL',
              url
            },
            '*'
          );
        }
      } catch (_) {
        // ignore
      }
      return originalFetch.apply(this, args as [RequestInfo, RequestInit?]);
    };
  }

  // 启动初次循环嗅探
  let initialAttempts = 0;
  const initialTimer = setInterval(() => {
    initialAttempts++;
    if (broadcastTracks() || initialAttempts >= 30) {
      clearInterval(initialTimer);
    }
  }, 200);
})();
