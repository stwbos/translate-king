/**
 * 翻译王 (TranslateKing) - YouTube MAIN 世界专有通信桥接脚本
 *
 * 核心设计：
 * 在 YouTube 页面的 MAIN 执行世界（与 YouTube 播放器同属相同 JS 上下文）运行：
 * 1. 穿透 Chrome MV3 隔离世界壁垒，直接调用 #movie_player.getPlayerResponse() 与 window.ytInitialPlayerResponse
 * 2. 深度拦截 XMLHttpRequest 与 Fetch，捕获播放器自身发出的带合法 pot、session、signature 的 /api/timedtext 字幕流
 * 3. 接收并响应 Content Script 的原生 CC 启停控制 (toggleSubtitlesOn / loadModule)
 * 4. 监听 yt-navigate-finish 并在视频切换时通过 window.postMessage 向 Content Script 广播合法字幕轨道与拦截内容
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

  function enablePlayerCaptions(): void {
    const player = document.getElementById('movie_player') as any;
    if (player) {
      try {
        if (typeof player.loadModule === 'function') {
          player.loadModule('captions');
        }
        if (typeof player.toggleSubtitlesOn === 'function') {
          player.toggleSubtitlesOn();
        } else if (typeof player.toggleSubtitles === 'function' && typeof player.isSubtitlesOn === 'function' && !player.isSubtitlesOn()) {
          player.toggleSubtitles();
        }
      } catch (_) {}
    }
  }

  function disablePlayerCaptions(): void {
    const player = document.getElementById('movie_player') as any;
    if (player) {
      try {
        if (typeof player.toggleSubtitles === 'function' && typeof player.isSubtitlesOn === 'function' && player.isSubtitlesOn()) {
          player.toggleSubtitles();
        }
      } catch (_) {}
    }
  }

  // 1. 监听来自 Content Script 的消息
  window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.type === 'TK_REQUEST_YT_TRACKS') {
      broadcastTracks();
    } else if (e.data.type === 'TK_ENABLE_YT_CC') {
      enablePlayerCaptions();
    } else if (e.data.type === 'TK_DISABLE_YT_CC') {
      disablePlayerCaptions();
    }
  });

  // 2. 拦截 XMLHttpRequest (YouTube 播放器核心 timedtext 多走 XHR)
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__tk_url = typeof url === 'string' ? url : url.toString();
    return (originalXhrOpen as any).apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args: any[]) {
    const url = (this as any).__tk_url || '';
    if (typeof url === 'string' && url.includes('/api/timedtext')) {
      // 广播抓获的真实带签名 URL
      window.postMessage({ type: 'TK_YT_NATIVE_TIMEDTEXT_URL', url }, '*');

      this.addEventListener('load', () => {
        try {
          if (this.status === 200 && this.responseText && this.responseText.trim().length > 0) {
            window.postMessage(
              {
                type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
                url: this.responseURL || url,
                body: this.responseText
              },
              '*'
            );
          }
        } catch (_) {}
      });
    }
    return originalXhrSend.apply(this, args as [any]);
  };

  // 3. 拦截 Fetch API
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (...args: any[]) {
      const response = await originalFetch.apply(this, args as [RequestInfo, RequestInit?]);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          window.postMessage({ type: 'TK_YT_NATIVE_TIMEDTEXT_URL', url }, '*');

          const clone = response.clone();
          clone.text().then((text) => {
            if (text && text.trim().length > 0) {
              window.postMessage(
                {
                  type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
                  url,
                  body: text
                },
                '*'
              );
            }
          }).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  // 4. 监听 YouTube 专属 SPA 页面与视频切换事件
  window.addEventListener('yt-navigate-finish', () => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (broadcastTracks() || attempts >= 20) {
        clearInterval(timer);
      }
    }, 250);
  });

  // 5. 启动初次循环嗅探
  let initialAttempts = 0;
  const initialTimer = setInterval(() => {
    initialAttempts++;
    if (broadcastTracks() || initialAttempts >= 30) {
      clearInterval(initialTimer);
    }
  }, 200);
})();
