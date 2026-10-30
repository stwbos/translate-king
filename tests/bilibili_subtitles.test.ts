import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { BiliCaptionObserver } from '../src/content/bilibili';
import { updateSubtitleConfig, getSubtitleConfig } from '../src/content/youtube/subtitle-menu';

describe('Bilibili Video Subtitle Observer Engine', () => {
  let dom: JSDOM;
  let doc: Document;

  beforeEach(() => {
    dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <head></head>
        <body>
          <div class="bpx-player-container">
            <div class="bpx-player-video-area"></div>
            <div class="bpx-player-subtitle-wrap">
              <div class="bpx-player-subtitle">
                <div class="bpx-player-subtitle-panel">
                  <div class="bpx-player-subtitle-panel-position">
                    <div class="bpx-player-subtitle-panel-text"></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="bpx-player-control-bottom-right">
              <div class="bpx-player-ctrl-subtitle">
                <button class="bpx-player-ctrl-btn"></button>
              </div>
            </div>
          </div>
        </body>
      </html>`,
      { url: 'https://www.bilibili.com/video/BV1fj6vBfEnu' }
    );
    doc = dom.window.document;
    (global as any).document = doc;
    (global as any).window = dom.window;
    (global as any).MutationObserver = dom.window.MutationObserver;

    // 模拟 chrome.runtime.sendMessage
    (global as any).chrome = {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((msg, cb) => {
          if (msg.type === 'TRANSLATE_TEXT') {
            cb({ translation: `[KO] ${msg.text}` });
          }
        })
      },
      storage: {
        local: {
          get: vi.fn(),
          set: vi.fn()
        }
      }
    };

    updateSubtitleConfig({
      enabled: true,
      displayMode: 'bilingual',
      fontScale: 1.0,
      textColor: '#FEF08A',
      bgOpacity: 0.78
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('能检测并实时翻译 .bpx-player-subtitle-panel-text 节点中的字幕文本并原位渲染双语行', async () => {
    const observer = new BiliCaptionObserver('ko');
    observer.start();

    const subtitleTextEl = doc.querySelector('.bpx-player-subtitle-panel-text') as HTMLElement;
    subtitleTextEl.textContent = '今天我们来学习 Transformer 核心架构';

    // 触发字幕处理
    observer.processActiveCaptions();

    // 等待异步翻译回调
    await new Promise((r) => setTimeout(r, 20));

    const line = doc.getElementById('translate-king-bili-subtitle-line');
    expect(line).not.toBeNull();

    const transSpan = line?.querySelector('.translate-king-bili-trans-text');
    expect(transSpan).not.toBeNull();
    expect(transSpan?.textContent).toBe('[KO] 今天我们来学习 Transformer 核心架构');

    // 验证翻译缓存已被填充
    expect(observer.getTranslationCache().get('今天我们来学习 Transformer 核心架构')).toBe(
      '[KO] 今天我们来学习 Transformer 核心架构'
    );

    observer.stop();
  });

  it('在仅看译文模式下 (translation-only) 应当隐藏原生字幕并仅展示双语译文', async () => {
    updateSubtitleConfig({ displayMode: 'translation-only' });

    const observer = new BiliCaptionObserver('ko');
    observer.start();

    const subtitleTextEl = doc.querySelector('.bpx-player-subtitle-panel-text') as HTMLElement;
    subtitleTextEl.textContent = '注意力机制是自然语言处理的基石';

    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 20));

    // 原生字幕应该被隐藏
    expect(subtitleTextEl.style.opacity).toBe('0');
    expect(subtitleTextEl.style.visibility).toBe('hidden');

    const transSpan = doc.querySelector('.translate-king-bili-trans-text');
    expect(transSpan?.textContent).toBe('[KO] 注意力机制是自然语言处理的基石');

    observer.stop();
  });

  it('当切集或视频重置时 (resetVideo) 应立即清空已注入的译文字幕行并还原原生字幕状态', async () => {
    const observer = new BiliCaptionObserver('ko');
    observer.start();

    const subtitleTextEl = doc.querySelector('.bpx-player-subtitle-panel-text') as HTMLElement;
    subtitleTextEl.textContent = '第一讲总结';

    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 20));

    expect(doc.getElementById('translate-king-bili-subtitle-line')).not.toBeNull();

    observer.resetVideo();
    expect(doc.getElementById('translate-king-bili-subtitle-line')).toBeNull();

    observer.stop();
  });

  it('当 B站字幕当前处于“关闭”状态时能自动探测并激活“中文 AI”字幕', () => {
    const ctrlWrap = doc.querySelector('.bpx-player-ctrl-subtitle')!;
    const menuBox = doc.createElement('div');
    menuBox.className = 'bpx-player-ctrl-subtitle-box';

    const closeItem = doc.createElement('div');
    closeItem.className = 'bpx-player-ctrl-subtitle-language-item bpx-state-active';
    closeItem.textContent = '关闭';
    closeItem.setAttribute('data-lan', 'close');
    menuBox.appendChild(closeItem);

    const zhAiItem = doc.createElement('div');
    zhAiItem.className = 'bpx-player-ctrl-subtitle-language-item';
    zhAiItem.textContent = '中文 AI';
    zhAiItem.setAttribute('data-lan', 'ai-zh');
    zhAiItem.addEventListener('click', () => {
      closeItem.classList.remove('bpx-state-active');
      zhAiItem.classList.add('bpx-state-active');
    });
    menuBox.appendChild(zhAiItem);

    ctrlWrap.appendChild(menuBox);

    const observer = new BiliCaptionObserver('ko');
    expect(zhAiItem.classList.contains('bpx-state-active')).toBe(false);

    observer.ensureNativeCcEnabled();

    expect(zhAiItem.classList.contains('bpx-state-active')).toBe(true);
    expect(closeItem.classList.contains('bpx-state-active')).toBe(false);

    observer.stop();
  });
});
