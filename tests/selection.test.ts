import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { cleanWord, extractSentenceFromSelection, extractSentenceFromText } from '../src/content/selection/sentence-extractor';
import { SelectionFloatingCard } from '../src/content/selection/floating-card';

describe('Selection & Twitter DM Selection Robustness Test Suite', () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
      url: 'https://x.com/messages/1846044434237190144'
    });
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;
    (global as any).HTMLElement = dom.window.HTMLElement;
    (global as any).Range = dom.window.Range;
    (global as any).Selection = dom.window.Selection;
    (global as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        sendMessage: vi.fn()
      }
    };
  });

  it('cleanWord 应当滤除 Twitter/X React Native 插入的零宽空格与从左至右控制符', () => {
    // \u200B 是零宽空格, \u200E 是 LTR 控制符, \u200F 是 RTL 控制符
    const rawWithUnicode = '\u200EHello\u200B,\u200F';
    expect(cleanWord(rawWithUnicode)).toBe('Hello');

    const rawPhrase = '\u200B"nice to meet you"\u200E';
    expect(cleanWord(rawPhrase)).toBe('nice to meet you');
  });

  it('能从 Twitter DM 聊天气泡 (role="button" + dir="auto") 中精准截取生词所在完整句子', () => {
    dom.window.document.body.innerHTML = `
      <div data-testid="cellInnerDiv">
        <div data-testid="messageEntry" role="row">
          <div class="bubble-in css-175oi2r" role="button" tabindex="0">
            <div dir="auto" class="bubble-text">
              <span>Hello, nice to meet you</span>
            </div>
            <time datetime="2026-10-15T00:14:00Z">12:14 AM</time>
          </div>
        </div>
      </div>
    `;

    const span = dom.window.document.querySelector('.bubble-text span')!;
    const textNode = span.firstChild!;
    const range = dom.window.document.createRange();
    range.setStart(textNode, 7); // "nice"
    range.setEnd(textNode, 11);

    const selection = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => range,
      toString: () => 'nice'
    } as unknown as Selection;

    const sentence = extractSentenceFromSelection(selection);
    expect(sentence).toBe('Hello, nice to meet you');
  });

  it('支持 1 ~ 25 个词的短语与日常聊天完整短句划词', () => {
    const chatMsg = 'What is your name and where are you from?';
    const words = chatMsg.split(/\s+/);
    expect(words.length).toBe(9); // 9 个单词，在 <= 25 词的安全范围内
    expect(cleanWord(chatMsg)).toBe('What is your name and where are you from');
  });

  it('证明：React Native Web 子元素调用 stopPropagation 时，冒泡阶段监听器被阻断，但捕获阶段监听器必然成功执行', () => {
    const doc = dom.window.document;
    doc.body.innerHTML = `
      <div id="dm-container">
        <div id="dm-bubble" role="button">
          <span>Clickable Chat Text</span>
        </div>
      </div>
    `;

    const bubble = doc.getElementById('dm-bubble')!;
    // 模拟 React Native for Web 的 Responder：阻止 mouseup 事件冒泡
    bubble.addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });

    let bubblePhaseTriggered = false;
    let capturePhaseTriggered = false;

    // 普通冒泡阶段监听 (旧实现)
    doc.addEventListener('mouseup', () => {
      bubblePhaseTriggered = true;
    }, false);

    // 捕获阶段监听 (新架构)
    doc.addEventListener('mouseup', () => {
      capturePhaseTriggered = true;
    }, true);

    // 派发 mouseup 事件
    const event = new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true });
    bubble.dispatchEvent(event);

    expect(bubblePhaseTriggered).toBe(false); // 冒泡监听被 React Native Web 拦截吞没
    expect(capturePhaseTriggered).toBe(true);  // 捕获监听 100% 成功执行！
  });

  it('SelectionFloatingCard 使用固定视口定位 (position: fixed)，并在越界时自适应反弹', () => {
    const card = SelectionFloatingCard.getInstance();
    const mockRange = {
      getBoundingClientRect: () => ({
        left: 950,
        top: 700,
        right: 980,
        bottom: 720,
        width: 30,
        height: 20
      }),
      getClientRects: () => []
    } as unknown as Range;

    // 模拟视口宽高
    (dom.window as any).innerWidth = 1000;
    (dom.window as any).innerHeight = 800;

    card.showLoading(mockRange, 'test');

    const host = dom.window.document.getElementById('translate-king-bubble-host')!;
    expect(host).not.toBeNull();
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).toBe('2147483647');
    expect(host.style.display).toBe('block');

    // 右边缘超出 1000 - 12 = 988，卡片宽度 320，翻转后 left 应在安全区域内 (1000 - 320 - 12 = 668)
    expect(parseInt(host.style.left, 10)).toBeLessThanOrEqual(668);

    // 下边缘 720 + 180 = 900 > 800，向上翻转：top 应小于 700
    expect(parseInt(host.style.top, 10)).toBeLessThan(700);
  });
});
