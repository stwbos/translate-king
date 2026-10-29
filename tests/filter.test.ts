// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { shouldIgnoreElement, isValidTranslatableText } from '../src/content/dom/filter';

// 模拟简易 DOM Element
function createMockElement(
  tagName: string,
  attributes: Record<string, string> = {},
  classes: string[] = []
): Element {
  const el = {
    tagName: tagName.toUpperCase(),
    getAttribute: (name: string) => attributes[name] || null,
    classList: {
      contains: (cls: string) => classes.includes(cls)
    },
    matches: (selector: string) => {
      const parts = selector.split(',').map((s) => s.trim());
      for (const part of parts) {
        if (part === tagName.toLowerCase()) return true;
        const attrMatch = part.match(/\[([a-zA-Z0-9_-]+)="([^"]+)"\]/);
        if (attrMatch) {
          const [, attrName, attrVal] = attrMatch;
          if (attributes[attrName] === attrVal) return true;
        }
      }
      return false;
    },
    closest: (selector: string) => {
      if (selector.includes('translate-king-wrapper') && classes.includes('translate-king-wrapper')) return {};
      const parts = selector.split(',').map((s) => s.trim());
      for (const part of parts) {
        const attrMatch = part.match(/\[([a-zA-Z0-9_-]+)="([^"]+)"\]/);
        if (attrMatch) {
          const [, attrName, attrVal] = attrMatch;
          if (attributes[attrName] === attrVal) return {};
        }
      }
      return null;
    },
    isContentEditable: false
  } as unknown as Element;
  return el;
}

describe('DOM 智能过滤引擎 (Filter)', () => {
  it('应准确过滤代码块、脚本、时间与非文本标签', () => {
    expect(shouldIgnoreElement(createMockElement('script'))).toBe(true);
    expect(shouldIgnoreElement(createMockElement('style'))).toBe(true);
    expect(shouldIgnoreElement(createMockElement('code'))).toBe(true);
    expect(shouldIgnoreElement(createMockElement('pre'))).toBe(true);
    expect(shouldIgnoreElement(createMockElement('svg'))).toBe(true);
    expect(shouldIgnoreElement(createMockElement('time'))).toBe(true);
  });

  it('普通文本标签应正常允许翻译', () => {
    expect(shouldIgnoreElement(createMockElement('p'))).toBe(false);
    expect(shouldIgnoreElement(createMockElement('h1'))).toBe(false);
    expect(shouldIgnoreElement(createMockElement('li'))).toBe(false);
    expect(shouldIgnoreElement(createMockElement('blockquote'))).toBe(false);
  });

  it('X / Twitter 帖子文本容器应当允许翻译', () => {
    const tweetEl = createMockElement('div', { 'data-testid': 'tweetText' });
    expect(shouldIgnoreElement(tweetEl)).toBe(false);
  });

  it('X / Twitter 趋势与今日新闻模块应当允许翻译', () => {
    const trendEl = createMockElement('div', { 'data-testid': 'trend' });
    expect(shouldIgnoreElement(trendEl)).toBe(false);
  });

  it('X / Twitter 交互输入与非正文噪声应当被严密过滤', () => {
    const composer = createMockElement('div', { 'data-testid': 'tweetTextarea_0' });
    expect(shouldIgnoreElement(composer)).toBe(true);

    const searchInput = createMockElement('div', { 'data-testid': 'SearchBox_Search_Input' });
    expect(shouldIgnoreElement(searchInput)).toBe(true);

    const dmInput = createMockElement('div', { 'data-testid': 'DMComposerTextInput' });
    expect(shouldIgnoreElement(dmInput)).toBe(true);
  });

  it('明确标记 translate="no" 或 notranslate 的元素应被忽略', () => {
    expect(shouldIgnoreElement(createMockElement('p', { translate: 'no' }))).toBe(true);
    expect(shouldIgnoreElement(createMockElement('div', {}, ['notranslate']))).toBe(true);
  });

  it('自身即为翻译容器时应被忽略，避免自递归注入', () => {
    expect(shouldIgnoreElement(createMockElement('span', {}, ['translate-king-wrapper']))).toBe(true);
  });

  it('应准确过滤无意义纯符号与单个字母', () => {
    expect(isValidTranslatableText('')).toBe(false);
    expect(isValidTranslatableText('   ')).toBe(false);
    expect(isValidTranslatableText('1.')).toBe(false);
    expect(isValidTranslatableText('•')).toBe(false);
    expect(isValidTranslatableText('---')).toBe(false);
    expect(isValidTranslatableText('123,456.78')).toBe(false);
    expect(isValidTranslatableText('@elonmusk')).toBe(false);
    expect(isValidTranslatableText('@jasondemers5')).toBe(false);
    expect(isValidTranslatableText('https://t.co/abc1234')).toBe(false);
    expect(isValidTranslatableText('2h')).toBe(false);
    expect(isValidTranslatableText('5m')).toBe(false);
    expect(isValidTranslatableText('Follow')).toBe(true);
    expect(isValidTranslatableText('Show more')).toBe(true);
    expect(isValidTranslatableText('Hello world!')).toBe(true);
    expect(isValidTranslatableText('Artificial Intelligence')).toBe(true);
  });

  it('YouTube 播放器及原生字幕容器应当绝对被忽略，避免 Alt+T 全网页翻译误伤', () => {
    const player = document.createElement('div');
    player.id = 'movie_player';
    const captionWindow = document.createElement('div');
    captionWindow.className = 'caption-window ytp-caption-window-bottom';
    const segment = document.createElement('span');
    segment.className = 'ytp-caption-segment';
    captionWindow.appendChild(segment);
    player.appendChild(captionWindow);

    expect(shouldIgnoreElement(player)).toBe(true);
    expect(shouldIgnoreElement(captionWindow)).toBe(true);
    expect(shouldIgnoreElement(segment)).toBe(true);
  });
});
