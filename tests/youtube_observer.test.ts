// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NativeCaptionObserver } from '../src/content/youtube/native-observer';

describe('YouTube 原生字幕双语原位注入引擎 (NativeCaptionObserver)', () => {
  let player: HTMLElement;
  let captionWindow: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="movie_player">
        <video src="test.mp4"></video>
        <button class="ytp-subtitles-button" aria-pressed="false"></button>
        <div class="caption-window ytp-caption-window-bottom" id="caption-window-1">
          <span class="captions-text">
            <span class="caption-visual-line">
              <span class="ytp-caption-segment">Hello world</span>
            </span>
          </span>
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
            const translations = msg.texts.map((t: string) => {
              if (t.includes('Hello world')) return '你好世界';
              if (t.includes('next sentence')) return '这是下一句话';
              if (t.includes('Third continuous')) return '第三句连续字幕';
              return '已翻译内容';
            });
            cb({ translations });
          }
        }),
        lastError: null
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应当在 .caption-window 内原位注入 .translate-king-bilingual-line 双语译文', async () => {
    const observer = new NativeCaptionObserver('zh-CN');
    observer.start();
    observer.processActiveCaptions();

    // 等待异步翻译返回
    await new Promise((r) => setTimeout(r, 50));

    const transLine = captionWindow.querySelector('.translate-king-bilingual-line');
    expect(transLine).not.toBeNull();

    const transText = transLine?.querySelector('.translate-king-trans-text');
    expect(transText?.textContent).toBe('你好世界');

    // 原生字幕依然保留未被破坏
    const origSeg = captionWindow.querySelector('.caption-visual-line:not(.translate-king-bilingual-line) .ytp-caption-segment');
    expect(origSeg?.textContent).toBe('Hello world');

    observer.stop();
  });

  it('随着视频播放推进到下一句，译文应当实时跟随切换，绝不定格卡死', async () => {
    const observer = new NativeCaptionObserver('zh-CN');
    observer.start();

    // 句 1: Hello world
    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 50));
    expect(captionWindow.querySelector('.translate-king-trans-text')?.textContent).toBe('你好世界');

    // 句 2: YouTube 切换为下一句话
    const container = captionWindow.querySelector('.captions-text')!;
    container.innerHTML = `
      <span class="caption-visual-line">
        <span class="ytp-caption-segment">This is the next sentence</span>
      </span>
    `;

    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 50));

    // 译文必须自动切换为第二句
    expect(captionWindow.querySelector('.translate-king-trans-text')?.textContent).toBe('这是下一句话');

    // 句 3: 第三句话
    container.innerHTML = `
      <span class="caption-visual-line">
        <span class="ytp-caption-segment">Third continuous subtitle</span>
      </span>
    `;

    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 50));

    expect(captionWindow.querySelector('.translate-king-trans-text')?.textContent).toBe('第三句连续字幕');

    observer.stop();
  });

  it('ensureNativeCcEnabled 应当单次安全唤醒未激活的原生字幕按钮，已激活时绝不重复点击', () => {
    const btn = document.querySelector('.ytp-subtitles-button') as HTMLElement;
    const clickSpy = vi.spyOn(btn, 'click');

    const observer = new NativeCaptionObserver('zh-CN');

    // 首次调用未激活：应当点击
    observer.ensureNativeCcEnabled();
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // 模拟按钮已激活
    btn.setAttribute('aria-pressed', 'true');

    // 再次调用：绝不重复点击
    observer.ensureNativeCcEnabled();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('stop 时应当彻底清理注入的译文行，100% 还原原生字幕状态', async () => {
    const observer = new NativeCaptionObserver('zh-CN');
    observer.start();
    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 50));

    expect(captionWindow.querySelector('.translate-king-bilingual-line')).not.toBeNull();

    observer.stop();

    expect(captionWindow.querySelector('.translate-king-bilingual-line')).toBeNull();
  });
});
