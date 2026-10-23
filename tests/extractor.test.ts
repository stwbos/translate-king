import { describe, it, expect } from 'vitest';
import { extractTranslatableBlocks, BLOCK_SELECTORS } from '../src/content/dom/extractor';

describe('网页段落与社交流内容提取引擎 (Extractor)', () => {
  it('BLOCK_SELECTORS 应包含 Twitter/X 帖子关键选择器及投票/外链卡片选项', () => {
    expect(BLOCK_SELECTORS).toContain('[data-testid="tweetText"]');
    expect(BLOCK_SELECTORS).toContain('[data-testid="UserDescription"]');
    expect(BLOCK_SELECTORS).toContain('[data-testid="twitterArticleReadView"] p');
    expect(BLOCK_SELECTORS).toContain('[data-testid="pollChoice"]');
    expect(BLOCK_SELECTORS).toContain('[data-testid="card.layoutLarge.detail"] div[dir="auto"]');
    expect(BLOCK_SELECTORS).toContain('[data-testid="SideNav_NewTweet_Button"]');
    expect(BLOCK_SELECTORS).toContain('[data-testid$="-follow"]');
  });

  it('能够成功从 DOM 中提取带有 Twitter/X 标识的帖子', () => {
    // 模拟包含 tweetText 的 DOM 结构
    const mockTweet = {
      tagName: 'DIV',
      getAttribute: (name: string) => (name === 'data-testid' ? 'tweetText' : null),
      hasAttribute: (name: string) => false,
      setAttribute: (_name: string, _val: string) => {},
      classList: { contains: () => false },
      getBoundingClientRect: () => ({ top: 100, bottom: 200, width: 500, height: 100 }),
      getClientRects: () => [{}],
      matches: (selector: string) => {
        const parts = selector.split(',').map((s) => s.trim());
        return parts.includes('[data-testid="tweetText"]');
      },
      closest: (selector: string) => {
        // 不匹配噪声选择器
        return null;
      },
      isContentEditable: false,
      cloneNode: () => ({
        querySelectorAll: (sel: string) => {
          if (sel === 'img[alt]') {
            return [
              {
                alt: '🚀',
                replaceWith: function (newNode: any) {
                  this.replaced = newNode;
                }
              }
            ];
          }
          return [];
        },
        textContent: 'Elon Musk announced Starship launch today! 🚀'
      }),
      contains: () => false
    };

    const mockRoot = {
      querySelectorAll: (sel: string) => {
        if (sel.includes('[data-testid="tweetText"]')) {
          return [mockTweet];
        }
        return [];
      }
    } as unknown as ParentNode;

    const blocks = extractTranslatableBlocks(mockRoot);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toContain('Elon Musk announced Starship launch today!');
  });

  it('头像图片的 alt 文字 (如 "Square头像") 绝不混入提取文本，但原生 emoji 应当保留', () => {
    let replacedWithText = '';
    let removedImage = false;

    const mockBio = {
      tagName: 'DIV',
      getAttribute: () => null,
      hasAttribute: () => false,
      setAttribute: () => {},
      classList: { contains: () => false },
      getBoundingClientRect: () => ({ top: 100, bottom: 200, width: 300, height: 50 }),
      getClientRects: () => [{}],
      matches: () => false,
      closest: () => null,
      querySelector: () => null,
      isContentEditable: false,
      cloneNode: () => ({
        querySelectorAll: (sel: string) => {
          if (sel === 'img') {
            return [
              {
                alt: 'Square头像',
                src: 'https://pbs.twimg.com/profile_images/avatar.jpg',
                classList: { contains: () => false },
                remove: () => { removedImage = true; }
              },
              {
                alt: '🇨🇦',
                src: 'https://abs.twimg.com/emoji/v2/svg/1f1e8-1f1e6.svg',
                classList: { contains: () => true },
                replaceWith: (txt: string) => { replacedWithText = txt; }
              }
            ];
          }
          return [];
        },
        textContent: 'President of Virat Hindustan Sangam 🇨🇦'
      }),
      contains: () => false
    };

    const mockRoot = {
      querySelectorAll: (sel: string) => {
        if (sel.includes('div, li, td')) {
          return [mockBio];
        }
        return [];
      }
    } as unknown as ParentNode;

    const blocks = extractTranslatableBlocks(mockRoot);
    expect(blocks.length).toBe(1);
    expect(removedImage).toBe(true);
    expect(replacedWithText).toBe('🇨🇦');
    expect(blocks[0].originalText).not.toContain('Square头像');
    expect(blocks[0].originalText).toContain('President of Virat Hindustan Sangam');
  });
});
