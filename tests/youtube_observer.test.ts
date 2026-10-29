// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NativeCaptionObserver } from '../src/content/youtube/native-observer';
import { ensurePlayerMounted } from '../src/content/youtube/index';
import { updateSubtitleConfig, DEFAULT_YT_SUBTITLE_CONFIG } from '../src/content/youtube/subtitle-menu';
import { groupCuesIntoSections, mergeCuesIntoTranscriptParagraphs, YouTubeSummaryPanel } from '../src/content/youtube/summary-panel';
import { extractCaptionTracksFromDom, parseSubtitlePayload } from '../src/content/youtube/extractor';

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
    await new Promise((r) => setTimeout(r, 220));

    // 译文必须自动切换为第二句
    expect(captionWindow.querySelector('.translate-king-trans-text')?.textContent).toBe('这是下一句话');

    // 句 3: 第三句话
    container.innerHTML = `
      <span class="caption-visual-line">
        <span class="ytp-caption-segment">Third continuous subtitle</span>
      </span>
    `;

    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 220));

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

  it('ensurePlayerMounted 应当将双语切换按钮精准注入到控制栏最左侧第一个位置，且点击灵敏响应', () => {
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

    // 必须位于控制行 (.ytp-right-controls) 的最左侧第一个位置
    expect(rightControls.firstElementChild).toBe(btn);

    // 点击按钮切换为关闭状态
    btn?.click();
    expect(btn?.textContent).toContain('双语 OFF');

    // 再次点击恢复为开启状态
    btn?.click();
    expect(btn?.textContent).toContain('双语 ON');

    // 多次调用 ensurePlayerMounted 绝不产生重复按钮，且不销毁重建子节点
    const childBefore = btn?.firstChild;
    ensurePlayerMounted();
    expect(btn?.firstChild).toBe(childBefore);
    const allBtns = document.querySelectorAll('#translate-king-yt-control-btn');
    expect(allBtns.length).toBe(1);
  });

  it('ensurePlayerMounted 应当在视频下方操作栏仅挂载 [✨ 视频总结] 按钮，移除重复的双语按钮', () => {
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

    // 视频下方不再重复挂载双语字幕按钮
    const duplicateActionBtn = document.getElementById('translate-king-yt-action-btn');
    expect(duplicateActionBtn).toBeNull();

    // 仅挂载 [✨ 视频总结] 按钮
    const summaryBtn = document.getElementById('translate-king-yt-summary-btn');
    expect(summaryBtn).not.toBeNull();
    expect(summaryBtn?.textContent).toContain('✨ 视频总结');
  });

  it('3 小时超长视频 (10800 秒) 的总结与双语文字稿应当 100% 覆盖 00:00 至 3:00:00 结尾，绝不提前截断', () => {
    // 构造 3 小时 (3600 条，每条 3 秒) 的完整视频字幕流
    const threeHourCues = Array.from({ length: 3600 }, (_, i) => ({
      id: i + 1,
      startMs: i * 3000,
      endMs: (i + 1) * 3000,
      originalText: `This is sentence number ${i + 1} discussing machine learning architecture and system scaling.`
    }));

    const sections = groupCuesIntoSections(threeHourCues, 24);
    expect(sections.length).toBeGreaterThanOrEqual(20);
    // 第一段从 00:00 开始
    expect(sections[0].startMs).toBe(0);
    // 最后一段必须覆盖到第 3 小时末尾 (10800000 ms)
    expect(sections[sections.length - 1].endMs).toBe(10800000);

    const paragraphs = mergeCuesIntoTranscriptParagraphs(threeHourCues, 18000);
    expect(paragraphs.length).toBeGreaterThan(300);
    expect(paragraphs[0].startMs).toBe(0);
    // 文字稿最后一段同样必须覆盖到第 3 小时末尾 (10800000 ms)
    expect(paragraphs[paragraphs.length - 1].endMs).toBe(10800000);
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

  it('点击控制栏按钮右侧 ⚙ 应当弹出多维字幕设置菜单，且修改仅看译文/字号/颜色/位置实时生效', async () => {
    const rightControls = document.createElement('div');
    rightControls.className = 'ytp-right-controls';
    player.appendChild(rightControls);

    ensurePlayerMounted();
    const observer = new NativeCaptionObserver('zh-CN');
    observer.start();
    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 50));

    // 点击按钮内的齿轮触发器 [data-tk-role="settings-trigger"]
    const gear = document.querySelector('[data-tk-role="settings-trigger"]') as HTMLElement;
    expect(gear).not.toBeNull();
    gear.click();

    const menu = document.getElementById('translate-king-yt-subtitle-menu');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('双语字幕控制台');

    // 切换为「仅看译文」+「原文上方」+「冰青色」
    updateSubtitleConfig({
      displayMode: 'translation-only',
      position: 'top',
      textColor: '#22D3EE',
      learningMask: true
    });

    const origSeg = captionWindow.querySelector(
      '.ytp-caption-segment:not(.translate-king-trans-text)'
    ) as HTMLElement;
    expect(origSeg.style.display).toBe('none');

    const line = captionWindow.querySelector('.translate-king-bilingual-line') as HTMLElement;
    expect(captionWindow.firstElementChild).toBe(line);

    const transSpan = line.querySelector('.translate-king-trans-text') as HTMLElement;
    expect(transSpan.style.filter).toContain('blur');

    // 恢复默认配置
    updateSubtitleConfig(DEFAULT_YT_SUBTITLE_CONFIG);
    observer.stop();
  });

  it('切视频鲁棒性：extractCaptionTracksFromDom 传入新视频 ID 时应拒绝旧视频残留在 script 标签中的字幕轨道，且总结面板切视频应彻底清空', () => {
    const script = document.createElement('script');
    script.textContent = `
      var ytInitialPlayerResponse = {
        "videoDetails": {"videoId": "OLD_VID_111"},
        "captions": {
          "playerCaptionsTracklistRenderer": {
            "captionTracks": [
              {"baseUrl": "https://www.youtube.com/api/timedtext?v=OLD_VID_111&lang=en", "languageCode": "en"}
            ]
          }
        }
      };
    `;
    document.body.appendChild(script);

    // 当查询旧视频 ID 时命中
    expect(extractCaptionTracksFromDom(document, 'OLD_VID_111')).not.toBeNull();
    // 当切到新视频 NEW_VID_222 时，必须拒绝旧视频残留的 script 数据！
    expect(extractCaptionTracksFromDom(document, 'NEW_VID_222')).toBeNull();

    // 总结面板切视频重置验证
    const panel = new YouTubeSummaryPanel('zh-CN');
    panel.resetForNewVideo('OLD_VID_111');
    panel.resetForNewVideo(null); // 模拟回退到首页
    panel.resetForNewVideo('NEW_VID_222');
    expect(document.getElementById('translate-king-yt-summary-panel')).toBeNull();
  });

  it('ASR 逐词滚动字幕 (.ytp-caption-window-rollup) 严禁携带 caption-visual-line 类名防止被追加单字，且配合 srv3 时间轴应直接渲染完整长句', async () => {
    // 1. 验证 srv3 XML 逐词偏移格式解析并聚合为完整句子
    const srv3Xml = `
      <timedtext format="3">
        <body>
          <p t="1000" d="3000"><s t="0">Hello</s><s t="300"> world</s><s t="600"> this</s><s t="900"> is</s><s t="1200"> next</s><s t="1500"> sentence.</s></p>
        </body>
      </timedtext>
    `;
    const mergedCues = parseSubtitlePayload(srv3Xml, true);
    expect(mergedCues.length).toBe(1);
    expect(mergedCues[0].originalText).toBe('Hello world this is next sentence.');

    // 2. 模拟向 window 广播已拦截的 ASR 字幕流
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'TK_YT_INTERCEPTED_TIMEDTEXT',
          url: 'https://www.youtube.com/api/timedtext?v=UHXCSeoU-YM&kind=asr&fmt=srv3',
          body: srv3Xml
        }
      })
    );

    // 3. 将字幕窗口设为 YouTube ASR 逐词滚动模式 (.ytp-caption-window-rollup)，且此时画面仅蹦出前两个词 "Hello world"
    captionWindow.classList.add('ytp-caption-window-rollup');
    const container = captionWindow.querySelector('.captions-text')!;
    container.innerHTML = `
      <span class="caption-visual-line">
        <span class="ytp-caption-segment">Hello</span>
        <span class="ytp-caption-segment"> world</span>
      </span>
    `;

    const observer = new NativeCaptionObserver('zh-CN');
    observer.start();
    observer.processActiveCaptions();
    await new Promise((r) => setTimeout(r, 60));

    const line = captionWindow.querySelector('.translate-king-bilingual-line') as HTMLElement;
    expect(line).not.toBeNull();
    // 严禁带有 caption-visual-line，杜绝 YouTube 原生播放器把后续蹦出的单字塞进译文容器
    expect(line.classList.contains('caption-visual-line')).toBe(false);

    // 原生蹦字碎片已被隐藏，改为在双语行内同时展示合并后的完整英文句子与中文译文
    const origOverride = line.querySelector('.translate-king-orig-text') as HTMLElement;
    expect(origOverride.textContent).toBe('Hello world this is next sentence.');
    expect(origOverride.style.display).toBe('block');

    const transSpan = line.querySelector('.translate-king-trans-text') as HTMLElement;
    expect(transSpan.textContent).toBe('你好世界');

    observer.stop();
  });
});
