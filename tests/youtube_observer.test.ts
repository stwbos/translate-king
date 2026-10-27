// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NativeCaptionObserver } from '../src/content/youtube/native-observer';

describe('YouTube 原生字幕 DOM 监听器 (NativeCaptionObserver)', () => {
  let player: HTMLElement;
  let captionWindow: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="movie_player">
        <button class="ytp-subtitles-button" aria-pressed="false"></button>
        <div class="caption-window ytp-caption-window-bottom" id="caption-window-1">
          <span class="ytp-caption-segment">Hello world</span>
        </div>
      </div>
    `;
    player = document.getElementById('movie_player')!;
    captionWindow = document.getElementById('caption-window-1')!;

    // Mock chrome.runtime.sendMessage
    (global as any).chrome = {
      runtime: {
        sendMessage: vi.fn((msg, cb) => {
          if (msg.type === 'TRANSLATE_BATCH') {
            cb({ translations: ['你好世界'] });
          }
        }),
        lastError: null
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应当能嗅探到页面中的 .ytp-caption-segment 并触发双语更新', async () => {
    const updates: Array<{ orig: string; trans: string }> = [];
    const observer = new NativeCaptionObserver(
      'zh-CN',
      (orig, trans) => {
        updates.push({ orig, trans });
      },
      () => false // scheduler inactive
    );

    observer.start();
    observer.inspectActiveCaptions();

    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].orig).toBe('Hello world');

    // 等待异步翻译返回
    await new Promise((r) => setTimeout(r, 50));
    expect(updates.some((u) => u.trans === '你好世界')).toBe(true);

    observer.stop();
  });

  it('当 SubtitleScheduler 处于激活状态时，Observer 应当静默退让', () => {
    const updates: Array<{ orig: string; trans: string }> = [];
    const observer = new NativeCaptionObserver(
      'zh-CN',
      (orig, trans) => {
        updates.push({ orig, trans });
      },
      () => true // scheduler ACTIVE!
    );

    observer.start();
    observer.inspectActiveCaptions();

    expect(updates).toHaveLength(0);
    observer.stop();
  });

  it('ensureNativeCcEnabled 应当自动点击处于未激活状态的 CC 按钮', () => {
    const btn = document.querySelector('.ytp-subtitles-button') as HTMLElement;
    const clickSpy = vi.spyOn(btn, 'click');

    const observer = new NativeCaptionObserver('zh-CN', () => {}, () => false);
    observer.ensureNativeCcEnabled();

    expect(clickSpy).toHaveBeenCalled();
  });

  it('当字幕段被移出页面时，应当触发清空更新', () => {
    const updates: Array<{ orig: string; trans: string }> = [];
    const observer = new NativeCaptionObserver(
      'zh-CN',
      (orig, trans) => {
        updates.push({ orig, trans });
      },
      () => false
    );

    observer.start();
    observer.inspectActiveCaptions();

    // 移除字幕段
    captionWindow.innerHTML = '';
    observer.inspectActiveCaptions();

    expect(updates[updates.length - 1]).toEqual({ orig: '', trans: '' });
    observer.stop();
  });
});
