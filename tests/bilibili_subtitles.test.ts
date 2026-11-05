import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  BiliCaptionObserver,
  mountBiliControlButton,
  injectBiliSummaryActionButton
} from '../src/content/bilibili';
import { updateSubtitleConfig } from '../src/content/youtube/subtitle-menu';
import { parseSubtitlePayload, parseVttOrSrtToCues } from '../src/content/youtube/extractor';
import {
  parseTimestampChaptersFromText,
  isBiliHoneyPotRawText,
  isBiliHoneyPotCues,
  YouTubeSummaryPanel
} from '../src/content/youtube/summary-panel';
import {
  UniversalVideoCaptionObserver,
  mountUniversalVideoControls
} from '../src/content/video/universal';

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
          if (msg.type === 'TRANSLATE_BATCH') {
            cb({ translations: msg.texts.map((t: string) => `[KO] ${t}`) });
          } else if (msg.type === 'TRANSLATE_TEXT') {
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

  it('能检测并实时翻译现代 B站 .bili-subtitle-x-subtitle-panel-text 节点并渲染双语字幕', async () => {
    // 构造现代 B站 DOM 结构
    const container = doc.querySelector('.bpx-player-container')!;
    const modernWrap = doc.createElement('div');
    modernWrap.className = 'bili-subtitle-x-subtitle-panel-wrap';
    const modernPosition = doc.createElement('div');
    modernPosition.className = 'bili-subtitle-x-subtitle-panel-position';
    const modernText = doc.createElement('div');
    modernText.className = 'bili-subtitle-x-subtitle-panel-text';
    modernPosition.appendChild(modernText);
    modernWrap.appendChild(modernPosition);
    container.appendChild(modernWrap);

    // 移除旧的 text 节点确保测试只命中现代节点
    doc.querySelector('.bpx-player-subtitle-panel-text')?.remove();

    const observer = new BiliCaptionObserver('ko');
    observer.start();

    modernText.textContent = '现代神经网络的注意力机制解析';
    observer.processActiveCaptions();

    await new Promise((r) => setTimeout(r, 20));

    const line = doc.getElementById('translate-king-bili-subtitle-line');
    expect(line).not.toBeNull();

    const transSpan = line?.querySelector('.translate-king-bili-trans-text');
    expect(transSpan).not.toBeNull();
    expect(transSpan?.textContent).toBe('[KO] 现代神经网络的注意力机制解析');

    observer.stop();
  });

  it('mountBiliControlButton 渲染翻译王品牌 Logo 图标且左键点击直接打开字幕设置面板', () => {
    const observer = new BiliCaptionObserver('zh-CN');
    mountBiliControlButton(observer);

    const btn = doc.querySelector('.translate-king-bili-control-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('data-tk-enabled')).toBe('true');

    // 验证包含翻译王专属 Logo 容器，且不再包含旧版“双语 ON”胶囊文字
    const logoWrap = btn?.querySelector('.translate-king-logo-wrap');
    expect(logoWrap).not.toBeNull();
    expect(btn?.textContent || '').not.toContain('双语 ON');

    // 点击按钮应直接弹出双语字幕设置菜单 (#translate-king-yt-subtitle-menu)
    btn?.click();
    const menu = doc.getElementById('translate-king-yt-subtitle-menu');
    expect(menu).not.toBeNull();

    observer.stop();
  });

  it('injectBiliSummaryActionButton 在 B站视频工具栏注入 [✨ 视频总结] 按钮，且支持解析简介时间戳章节与 B站 JSON 字幕', () => {
    const toolbar = doc.createElement('div');
    toolbar.className = 'video-toolbar-left';
    doc.body.appendChild(toolbar);

    injectBiliSummaryActionButton('zh-CN');
    const summaryBtn = doc.getElementById('translate-king-bili-summary-btn');
    expect(summaryBtn).not.toBeNull();
    expect(summaryBtn?.textContent).toContain('视频总结');
    expect(summaryBtn?.querySelector('.translate-king-logo-wrap')).not.toBeNull();

    // 验证 B站 JSON 字幕格式解析
    const biliJson = JSON.stringify({
      body: [
        { from: 0.5, to: 4.2, content: '欢迎来到 Blender 雕刻入门教程' },
        { from: 4.5, to: 9.0, content: '今天我们学习抓起笔刷和遮罩笔刷' }
      ]
    });
    const cues = parseSubtitlePayload(biliJson);
    expect(cues).toHaveLength(2);
    expect(cues[0].originalText).toBe('欢迎来到 Blender 雕刻入门教程');
    expect(cues[0].startMs).toBe(500);

    // 验证 B站视频简介时间戳章节提取（如 BV1dV7Cz5Efc）
    const descChapters = parseTimestampChaptersFromText(
      `本视频涵盖小狐狸头部制作：\n00:00 🔨简单雕刻入门\n00:57 🦊制作头部基础大型\n02:35 👂制作耳朵与毛发`
    );
    expect(descChapters).toHaveLength(3);
    expect(descChapters[0].startMs).toBe(0);
    expect(descChapters[1].startMs).toBe(57000);
    expect(descChapters[2].originalText).toContain('制作耳朵与毛发');
  });

  it('全平台通用视频引擎 (UniversalVideoCaptionObserver) 支持解析 WebVTT/SRT 并在任意 HTML5 视频挂载 Logo 与 [✨ 视频总结]', async () => {
    const vttSample = `WEBVTT

00:00:01.000 --> 00:00:04.500
Welcome to the Universal Video Course.

00:00:05.000 --> 00:00:09.000
Let us explore deep learning architectures.`;

    const parsedVtt = parseVttOrSrtToCues(vttSample);
    expect(parsedVtt).toHaveLength(2);
    expect(parsedVtt[0].originalText).toBe('Welcome to the Universal Video Course.');
    expect(parsedVtt[1].startMs).toBe(5000);

    // 构造通用视频页面 DOM (如 Coursera / TED / 任意 HTML5 视频站)
    const videoWrap = doc.createElement('div');
    videoWrap.className = 'course-video-player';
    const videoEl = doc.createElement('video');
    videoWrap.appendChild(videoEl);
    const captionNode = doc.createElement('div');
    captionNode.className = 'vjs-text-track-display';
    captionNode.textContent = 'Welcome to the Universal Video Course.';
    videoWrap.appendChild(captionNode);
    doc.body.appendChild(videoWrap);

    const univObserver = new UniversalVideoCaptionObserver('zh-CN');
    univObserver.start();
    mountUniversalVideoControls('zh-CN');

    const bar = doc.getElementById('translate-king-universal-video-bar');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('.translate-king-logo-wrap')).not.toBeNull();
    expect(bar?.querySelector('.translate-king-universal-summary-btn')?.textContent).toContain('视频总结');

    univObserver.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 20));

    const univSubLine = doc.getElementById('translate-king-universal-subtitle-line');
    expect(univSubLine).not.toBeNull();
    expect(univSubLine?.querySelector('.translate-king-universal-trans-text')?.textContent).toBe(
      '[KO] Welcome to the Universal Video Course.'
    );

    univObserver.stop();
  });

  it('严格遵循用户设定的目标语言 (如 zh-CN)，且译文位置“原文上方 (top)”保持在视频底部并将译文排在原文上方 (column-reverse)', async () => {
    const sentMessages: any[] = [];
    (global as any).chrome.runtime.sendMessage = vi.fn((msg, cb) => {
      sentMessages.push(msg);
      cb({ translations: msg.texts.map((t: string) => `[${msg.toLang.toUpperCase()}] ${t}`) });
    });

    updateSubtitleConfig({
      enabled: true,
      displayMode: 'bilingual',
      position: 'top',
      targetLang: 'zh-CN'
    });

    const observer = new BiliCaptionObserver('zh-CN');
    observer.start();

    const subtitleTextEl = doc.querySelector('.bpx-player-subtitle-panel-text') as HTMLElement;
    const subtitlePosEl = doc.querySelector('.bpx-player-subtitle-panel-position') as HTMLElement;
    subtitleTextEl.textContent = 'Transformer attention mechanism';

    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 20));

    // 1. 验证严格使用用户设定的目标语言 zh-CN，绝不自作主张改成 en
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0].toLang).toBe('zh-CN');

    // 2. 验证 B站原生字幕框及外层背景容器均已被隐藏 (opacity: 0, visibility: hidden)，彻底消除底部残留黑灰块
    expect(subtitleTextEl.style.opacity).toBe('0');
    expect(subtitleTextEl.style.visibility).toBe('hidden');
    expect(subtitlePosEl.style.opacity).toBe('0');
    expect(subtitlePosEl.style.visibility).toBe('hidden');

    // 3. 验证 #translate-king-bili-subtitle-line 始终保持在视频底部 (bottom: 54px)，且 position='top' 时通过 column-reverse 将译文置于原文上方
    const line = doc.getElementById('translate-king-bili-subtitle-line') as HTMLElement | null;
    expect(line).not.toBeNull();
    expect(line?.style.bottom).toBe('54px');
    expect(line?.style.top).toBe('auto');
    expect(line?.style.flexDirection).toBe('column-reverse');

    const origSpan = line?.querySelector('.translate-king-bili-orig-text') as HTMLElement | null;
    const transSpan = line?.querySelector('.translate-king-bili-trans-text') as HTMLElement | null;
    expect(origSpan?.textContent).toBe('Transformer attention mechanism');
    expect(origSpan?.style.display).toBe('block');
    expect(transSpan?.textContent).toBe('[ZH-CN] Transformer attention mechanism');

    observer.stop();
  });

  it('精准拦截 B站未签名接口的反爬假字幕蜜罐（亚历克斯独自抚养孩子故事），且总结面板挂载在 #danmukuBox 上方并支持完整交互', async () => {
    const honeyPotJson = JSON.stringify({
      body: [
        { from: 0, to: 5, content: '大家好 我的名字是亚历克斯 我二十二岁 现在我必须独自抚养孩子' },
        { from: 5, to: 10, content: '因为我失去了所有对我重要的人 我做了一件冲动的事情' }
      ]
    });
    expect(isBiliHoneyPotRawText(honeyPotJson)).toBe(true);
    const parsedHoneyPot = parseSubtitlePayload(honeyPotJson);
    expect(isBiliHoneyPotCues(parsedHoneyPot)).toBe(true);

    // 构造 B站右侧栏 DOM (.right-container-inner > .up-panel-container + #danmukuBox)
    const rightInner = doc.createElement('div');
    rightInner.className = 'right-container-inner';
    const upPanel = doc.createElement('div');
    upPanel.className = 'up-panel-container';
    const danmakuBox = doc.createElement('div');
    danmakuBox.id = 'danmukuBox';
    rightInner.appendChild(upPanel);
    rightInner.appendChild(danmakuBox);
    doc.body.appendChild(rightInner);

    const panel = new YouTubeSummaryPanel('zh-CN');
    panel.togglePanel();

    const mountedPanel = doc.getElementById('translate-king-yt-summary-panel');
    expect(mountedPanel).not.toBeNull();
    // 验证挂载在 #danmukuBox 之前、.up-panel-container 之后，避开 B站顶部固定导航栏遮挡
    expect(mountedPanel?.nextElementSibling?.id).toBe('danmukuBox');
    expect(mountedPanel?.previousElementSibling?.className).toBe('up-panel-container');
    expect(mountedPanel?.style.pointerEvents).toBe('auto');
    expect(mountedPanel?.style.userSelect).toBe('text');

    // 验证在视频总结面板内部划词释放鼠标 (mouseup) 时，事件能正常传递到 document 以触发划词翻译卡片
    let docMouseUpReceived = false;
    doc.addEventListener('mouseup', () => {
      docMouseUpReceived = true;
    });
    mountedPanel?.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    expect(docMouseUpReceived).toBe(true);
  });
});
