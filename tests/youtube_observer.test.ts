// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NativeCaptionObserver } from '../src/content/youtube/native-observer';
import { ensurePlayerMounted } from '../src/content/youtube/index';

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

  it('ensurePlayerMounted 应当将双语切换按钮精准注入到全屏按钮左侧，并具备高防御样式', () => {
    // 构造播放器底栏控制区
    const rightControls = document.createElement('div');
    rightControls.className = 'ytp-right-controls';
    rightControls.innerHTML = `
      <button class="ytp-subtitles-button ytp-button" aria-pressed="false"></button>
      <button class="ytp-settings-button ytp-button"></button>
      <button class="ytp-fullscreen-button ytp-button"></button>
    `;
    player.appendChild(rightControls);

    const success = ensurePlayerMounted();
    expect(success).toBe(true);

    const btn = document.getElementById('translate-king-yt-control-btn');
    expect(btn).not.toBeNull();
    expect(btn?.classList.contains('translate-king-yt-control-btn')).toBe(true);
    expect(btn?.textContent).toContain('双语 ON');

    // 必须位于全屏按键紧邻的左侧
    const fullscreenBtn = rightControls.querySelector('.ytp-fullscreen-button');
    expect(btn?.nextElementSibling).toBe(fullscreenBtn);

    // 点击按钮切换为关闭状态
    btn?.click();
    expect(btn?.textContent).toContain('双语 OFF');

    // 再次点击恢复为开启状态
    btn?.click();
    expect(btn?.textContent).toContain('双语 ON');

    // 多次调用 ensurePlayerMounted 绝不产生重复按钮
    ensurePlayerMounted();
    const allBtns = document.querySelectorAll('#translate-king-yt-control-btn');
    expect(allBtns.length).toBe(1);
  });

  it('ensurePlayerMounted 应当在视频下方主操作栏注入常驻的 [双语字幕 ON] 按钮并与底栏状态同步', () => {
    // 构造视频下方操作栏
    const topRow = document.createElement('div');
    topRow.id = 'top-row';
    topRow.innerHTML = `
      <div id="actions">
        <div id="actions-inner">
          <div id="menu">
            <button class="yt-like-btn">Like</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(topRow);

    ensurePlayerMounted();

    const actionBtn = document.getElementById('translate-king-yt-action-btn');
    expect(actionBtn).not.toBeNull();
    expect(actionBtn?.textContent).toContain('双语字幕 ON');

    // 点击主操作栏按钮，底栏按钮与操作栏按钮同步切换为 OFF
    actionBtn?.click();
    expect(actionBtn?.textContent).toContain('双语字幕 OFF');

    const bottomBtn = document.getElementById('translate-king-yt-control-btn');
    if (bottomBtn) {
      expect(bottomBtn.textContent).toContain('双语 OFF');
    }

    // 再次点击恢复为 ON
    actionBtn?.click();
    expect(actionBtn?.textContent).toContain('双语字幕 ON');
    if (bottomBtn) {
      expect(bottomBtn.textContent).toContain('双语 ON');
    }
  });

  it('ASR 逐词流式识别追加新词时，译文应当自适应对齐并成功上屏，绝不因严格相等而丢弃', async () => {
    const observer = new NativeCaptionObserver('zh-CN');
    observer.start();

    // 模拟 ASR 逐词涌入：初始句为 "Hello world"
    const container = captionWindow.querySelector('.captions-text')!;
    container.innerHTML = `
      <span class="caption-visual-line">
        <span class="ytp-caption-segment">Hello world</span>
      </span>
    `;
    observer.processActiveCaptions();

    // 在网络翻译返回前，ASR 紧接着追加了新词 "Hello world next sentence"
    container.innerHTML = `
      <span class="caption-visual-line">
        <span class="ytp-caption-segment">Hello world next sentence</span>
      </span>
    `;

    // 等待异步翻译返回并检验是否能自适应上屏
    await new Promise((r) => setTimeout(r, 60));

    const transEl = captionWindow.querySelector('.translate-king-trans-text');
    expect(transEl).not.toBeNull();
    expect(transEl?.textContent).toBe('你好世界');

    observer.stop();
  });
});
