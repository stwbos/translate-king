import { describe, it, expect } from 'vitest';
import { injectTranslation, removeTranslation } from '../src/content/dom/injector';
import { TranslatableBlock } from '../src/content/dom/extractor';

function createMockElement(tagName: string, text: string): HTMLElement {
  const textNode = { nodeValue: text, nodeType: 3 };
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const children: any[] = [];

  const el = {
    tagName: tagName.toUpperCase(),
    textContent: text,
    getAttribute: (name: string) => attrs[name] || null,
    setAttribute: (name: string, val: string) => { attrs[name] = val; },
    hasAttribute: (name: string) => name in attrs,
    removeAttribute: (name: string) => { delete attrs[name]; },
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c)
    },
    appendChild: (child: any) => children.push(child),
    querySelectorAll: (sel: string) => {
      if (sel === '.translate-king-wrapper') return children.filter(c => c.className?.includes('translate-king-wrapper'));
      return [];
    },
    ownerDocument: {
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        className: '',
        setAttribute: () => {},
        appendChild: () => {},
        addEventListener: () => {}
      }),
      createTreeWalker: () => {
        let done = false;
        return {
          nextNode: () => {
            if (!done) {
              done = true;
              return textNode;
            }
            return null;
          }
        };
      }
    }
  } as unknown as HTMLElement;

  return el;
}

describe('译文渲染与模式切换引擎 (Injector)', () => {
  it('双语对照模式 (bilingual) 应当在段落下方挂载译文容器', () => {
    const el = createMockElement('p', 'Hello world');
    const block: TranslatableBlock = { id: 'b1', element: el, originalText: 'Hello world' };

    injectTranslation(block, '你好，世界', 'bilingual');

    const wrappers = el.querySelectorAll('.translate-king-wrapper');
    expect(wrappers.length).toBe(1);
    expect(el.hasAttribute('data-tk-replaced')).toBe(false);
  });

  it('直接替换模式 (replace) 应当直接就地修改文本内容并标记状态', () => {
    const el = createMockElement('button', 'Follow');
    const block: TranslatableBlock = { id: 'b2', element: el, originalText: 'Follow' };

    injectTranslation(block, '关注', 'replace');

    expect(el.getAttribute('data-tk-orig-text')).toBe('Follow');
    expect(el.getAttribute('data-tk-replaced')).toBe('true');
    // 双语容器不应被插入到按钮中
    const wrappers = el.querySelectorAll('.translate-king-wrapper');
    expect(wrappers.length).toBe(0);
  });

  it('removeTranslation 应当完美恢复直接替换模式的原始文本', () => {
    const el = createMockElement('button', 'Follow');
    const block: TranslatableBlock = { id: 'b3', element: el, originalText: 'Follow' };

    injectTranslation(block, '关注', 'replace');
    expect(el.getAttribute('data-tk-replaced')).toBe('true');

    removeTranslation(el);
    expect(el.hasAttribute('data-tk-replaced')).toBe(false);
    expect(el.hasAttribute('data-tk-orig-text')).toBe(false);
  });

  it('直接替换模式 (replace) 遇到多 span 拼接文本时应清空后续文本节点并在还原时复原', () => {
    const textNode1 = { nodeValue: 'Part 1 ', nodeType: 3 };
    const textNode2 = { nodeValue: 'Part 2', nodeType: 3 };
    const textNodes = [textNode1, textNode2];
    const attrs: Record<string, string> = {};
    const classes = new Set<string>();

    const el = {
      tagName: 'DIV',
      getAttribute: (name: string) => attrs[name] || null,
      setAttribute: (name: string, val: string) => { attrs[name] = val; },
      hasAttribute: (name: string) => name in attrs,
      removeAttribute: (name: string) => { delete attrs[name]; },
      querySelectorAll: () => [],
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c)
      },
      ownerDocument: {
        createTreeWalker: () => {
          let idx = 0;
          return {
            nextNode: () => {
              if (idx < textNodes.length) {
                return textNodes[idx++];
              }
              return null;
            }
          };
        }
      }
    } as unknown as HTMLElement;

    const block: TranslatableBlock = { id: 'b4', element: el, originalText: 'Part 1 Part 2' };
    injectTranslation(block, '全部中文翻译', 'replace');

    expect(textNode1.nodeValue).toBe('全部中文翻译');
    expect(textNode2.nodeValue).toBe('');
    expect(el.hasAttribute('data-tk-extra-text')).toBe(true);

    removeTranslation(el);
    expect(textNode1.nodeValue).toBe('Part 1 ');
    expect(textNode2.nodeValue).toBe('Part 2');
    expect(el.hasAttribute('data-tk-extra-text')).toBe(false);
  });
});
