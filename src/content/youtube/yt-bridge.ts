/**
 * 翻译王 (TranslateKing) - YouTube MAIN 世界专有通信桥接脚本
 *
 * 核心设计：
 * 在 YouTube 页面的 MAIN 执行世界（与 YouTube 播放器同属相同 JS 上下文）运行：
 * 1. 深度拦截 XMLHttpRequest 与 Fetch，被动捕获播放器自身发出的带合法 pot、session、signature 的 /api/timedtext 字幕流
 * 2. 将拦截到的字幕流持久化缓存在 window.__TK_LAST_TIMEDTEXT__ 中，解决 document_start 早于 content.js (document_idle) 的时序差
 * 3. 严禁调用 player.loadModule('captions') 或 player.toggleSubtitlesOn()，100% 保护 YouTube 原生字幕状态机不被重置或关闭！
 */

(function () {
  const win = window as any;

  function getUrlVideoId(): string | null {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('v');
      if (v) return v;
      const match = window.location.pathname.match(/\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function extractVideoIdFromTimedTextUrl(rawUrl: string): string | null {
    try {
      const u = new URL(rawUrl, window.location.origin);
      return u.searchParams.get('v');
    } catch {
      const m = rawUrl.match(/[?&]v=([a-zA-Z0-9_-]+)/);
      return m ? m[1] : null;
    }
  }

  function tracksMatchVideoId(tracks: any[], expectedVid: string | null): boolean {
    if (!expectedVid) return true;
    for (const t of tracks) {
      if (t && typeof t.baseUrl === 'string') {
        const trackVid = extractVideoIdFromTimedTextUrl(t.baseUrl);
        if (trackVid && trackVid !== expectedVid) {
          return false;
        }
      }
    }
    return true;
  }

  function broadcastTracks(): boolean {
    const currentVid = getUrlVideoId();
    if (!currentVid) return false;

    let tracks: any[] | null = null;
    const player = document.getElementById('movie_player') as any;

    // 1. 优先从播放器实时实例读取，并严格校验 response.videoDetails.videoId === currentVid
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const response = player.getPlayerResponse();
        const respVid = response?.videoDetails?.videoId || (typeof player.getVideoData === 'function' ? player.getVideoData()?.video_id : null);
        const candidate = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
        if (candidate && Array.isArray(candidate) && candidate.length > 0 && (!respVid || respVid === currentVid) && tracksMatchVideoId(candidate, currentVid)) {
          tracks = candidate;
        }
      } catch (_) {}
    }

    // 2. 尝试从 YouTube SPA 根组件 ytd-watch-flexy 读取最新 playerData
    if (!tracks) {
      try {
        const flexy = document.querySelector('ytd-watch-flexy') as any;
        const playerResp = flexy?.playerData || flexy?.__data?.playerData;
        const respVid = playerResp?.videoDetails?.videoId;
        const candidate = playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
        if (candidate && Array.isArray(candidate) && candidate.length > 0 && (!respVid || respVid === currentVid) && tracksMatchVideoId(candidate, currentVid)) {
          tracks = candidate;
        }
      } catch (_) {}
    }

    // 3. 退回检查 window.ytInitialPlayerResponse，但必须严格校验 videoId 等于当前 URL 视频 ID，绝不返回上一个视频的残留数据！
    if (!tracks && win.ytInitialPlayerResponse) {
      try {
        const respVid = win.ytInitialPlayerResponse?.videoDetails?.videoId;
        const candidate = win.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
        if (candidate && Array.isArray(candidate) && candidate.length > 0 && (!respVid || respVid === currentVid) && tracksMatchVideoId(candidate, currentVid)) {
          tracks = candidate;
        }
      } catch (_) {}
    }

    if (tracks && Array.isArray(tracks) && tracks.length > 0) {
      window.postMessage(
        {
          type: 'TK_YT_CAPTIONS_READY',
          tracks: JSON.parse(JSON.stringify(tracks)),
          videoId: currentVid
        },
        '*'
      );
      return true;
    }
    return false;
  }

  const originalFetch = window.fetch;
  let recoveringVid: string | null = null;

  function recoverTimedTextFromPerformance(currentVid: string): void {
    if (recoveringVid === currentVid) return;
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return;
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entryUrl = entries[i]?.name || '';
        if (entryUrl.includes('/api/timedtext')) {
          const entryVid = extractVideoIdFromTimedTextUrl(entryUrl);
          if (entryVid === currentVid) {
            recoveringVid = currentVid;
            let fetchUrl = entryUrl;
            if (fetchUrl.includes('fmt=')) {
              fetchUrl = fetchUrl.replace(/fmt=[^&]+/, 'fmt=json3');
            } else {
              fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + 'fmt=json3';
            }
            const nativeFetch = originalFetch || window.fetch;
            if (typeof nativeFetch === 'function') {
              nativeFetch
                .call(window, fetchUrl)
                .then((r) => (r.ok ? r.text() : ''))
                .then((text) => {
                  if (text && text.trim().length > 0 && getUrlVideoId() === currentVid) {
                    const payload = { url: fetchUrl, body: text, videoId: currentVid };
                    win.__TK_LAST_TIMEDTEXT__ = payload;
                    window.postMessage(
                      {
                        type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
                        url: fetchUrl,
                        body: text,
                        videoId: currentVid
                      },
                      '*'
                    );
                  }
                })
                .catch(() => {});
            }
            break;
          }
        }
      }
    } catch (_) {}
  }

  function replayCachedTimedText(): void {
    const currentVid = getUrlVideoId();
    if (!currentVid) return;
    const cached = win.__TK_LAST_TIMEDTEXT__;
    if (cached && cached.body) {
      const cachedVid = cached.videoId || extractVideoIdFromTimedTextUrl(cached.url || '');
      // 严格校验缓存的字幕流是否属于当前正在观看的视频，若属于旧视频则立即销毁！
      if (cachedVid && cachedVid !== currentVid) {
        win.__TK_LAST_TIMEDTEXT__ = null;
        recoverTimedTextFromPerformance(currentVid);
        return;
      }
      window.postMessage(
        {
          type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
          url: cached.url,
          body: cached.body,
          videoId: cachedVid || currentVid
        },
        '*'
      );
      return;
    }
    recoverTimedTextFromPerformance(currentVid);
  }

  if (win.__TRANSLATE_KING_YT_BRIDGE_INITIALIZED__) {
    broadcastTracks();
    replayCachedTimedText();
    return;
  }
  win.__TRANSLATE_KING_YT_BRIDGE_INITIALIZED__ = true;

  // 1. 监听来自 Content Script 的主动索取请求
  window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.type === 'TK_REQUEST_YT_TRACKS') {
      broadcastTracks();
      replayCachedTimedText();
    }
  });

  // 2. 被动拦截 XMLHttpRequest (零副作用读取播放器自身的 timedtext 响应)
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__tk_url = typeof url === 'string' ? url : url.toString();
    return (originalXhrOpen as any).apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args: any[]) {
    const url = (this as any).__tk_url || '';
    if (typeof url === 'string' && url.includes('/api/timedtext')) {
      window.postMessage({ type: 'TK_YT_NATIVE_TIMEDTEXT_URL', url }, '*');

      this.addEventListener('load', () => {
        try {
          if (this.status === 200 && this.responseText && this.responseText.trim().length > 0) {
            const finalUrl = this.responseURL || url;
            const urlVid = extractVideoIdFromTimedTextUrl(finalUrl) || getUrlVideoId();
            const currentVid = getUrlVideoId();
            if (currentVid && urlVid && urlVid !== currentVid) {
              return;
            }
            const payload = {
              url: finalUrl,
              body: this.responseText,
              videoId: urlVid
            };
            win.__TK_LAST_TIMEDTEXT__ = payload;
            window.postMessage(
              {
                type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
                url: payload.url,
                body: payload.body,
                videoId: urlVid
              },
              '*'
            );
          }
        } catch (_) {}
      });
    }
    return originalXhrSend.apply(this, args as [any]);
  };

  // 3. 被动拦截 Fetch API
  if (typeof originalFetch === 'function') {
    window.fetch = async function (...args: any[]) {
      const response = await originalFetch.apply(this, args as [RequestInfo, RequestInit?]);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          window.postMessage({ type: 'TK_YT_NATIVE_TIMEDTEXT_URL', url }, '*');

          const clone = response.clone();
          clone
            .text()
            .then((text) => {
              if (text && text.trim().length > 0) {
                const urlVid = extractVideoIdFromTimedTextUrl(url) || getUrlVideoId();
                const currentVid = getUrlVideoId();
                if (currentVid && urlVid && urlVid !== currentVid) {
                  return;
                }
                const payload = { url, body: text, videoId: urlVid };
                win.__TK_LAST_TIMEDTEXT__ = payload;
                window.postMessage(
                  {
                    type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
                    url,
                    body: text,
                    videoId: urlVid
                  },
                  '*'
                );
              }
            })
            .catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  // 4. 监听 YouTube 专属 SPA 页面与视频切换事件 (含回退 popstate 与导航开始)
  function handleBridgeRouteChange(): void {
    const currentVid = getUrlVideoId();
    if (win.__TK_LAST_TIMEDTEXT__ && win.__TK_LAST_TIMEDTEXT__.videoId !== currentVid) {
      win.__TK_LAST_TIMEDTEXT__ = null;
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (broadcastTracks() || attempts >= 24) {
        clearInterval(timer);
      }
    }, 250);
  }

  window.addEventListener('yt-navigate-start', () => {
    win.__TK_LAST_TIMEDTEXT__ = null;
  });
  window.addEventListener('yt-navigate-finish', handleBridgeRouteChange);
  window.addEventListener('popstate', handleBridgeRouteChange);

  // 5. 启动初次循环嗅探
  let initialAttempts = 0;
  const initialTimer = setInterval(() => {
    initialAttempts++;
    replayCachedTimedText();
    if (broadcastTracks() && initialAttempts >= 8) {
      clearInterval(initialTimer);
    }
    if (initialAttempts >= 25) {
      clearInterval(initialTimer);
    }
  }, 250);
})();
