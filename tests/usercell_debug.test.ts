import { describe, it, expect } from 'vitest';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';

describe('UserCell Twitter DOM Dedicated Extraction', () => {
  it('应当提取 UserCell 中的 bio、人名、和 Follow 按钮', () => {
    // 构造真实嵌套的 Twitter UserCell DOM (模拟 React Native for Web 多层嵌套 div)
    const createEl = (tag: string, attrs: Record<string, string> = {}, text = '', children: any[] = []) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        attributes: attrs,
        getAttribute: (k: string) => attrs[k] || null,
        hasAttribute: (k: string) => k in attrs,
        setAttribute: (k: string, v: string) => { attrs[k] = v; },
        classList: { contains: (c: string) => (attrs['class'] || '').includes(c) },
        children: children,
        childNodes: children,
        parentElement: null,
        isContentEditable: false,
        getBoundingClientRect: () => ({ top: 100, bottom: 200, width: 300, height: 40 }),
        getClientRects: () => [{}],
        textContent: text,
        cloneNode: () => ({
          querySelectorAll: () => [],
          textContent: text
        }),
        querySelector: (sel: string) => {
          for (const ch of children) {
            if (ch.matches && ch.matches(sel)) return ch;
            const found = ch.querySelector ? ch.querySelector(sel) : null;
            if (found) return found;
          }
          return null;
        },
        querySelectorAll: (sel: string) => {
          const list: any[] = [];
          for (const ch of children) {
            if (ch.matches && ch.matches(sel)) list.push(ch);
            if (ch.querySelectorAll) list.push(...ch.querySelectorAll(sel));
          }
          return list;
        },
        matches: (sel: string) => {
          const parts = sel.split(',').map((s) => s.trim());
          for (const p of parts) {
            if (p.toUpperCase() === tag.toUpperCase()) return true;
            if (p.startsWith('[data-testid=') && p.endsWith(']')) {
              const val = p.slice(14, -2);
              if (attrs['data-testid'] === val) return true;
            }
            if (p.includes('$="') && attrs['data-testid']?.endsWith(p.split('$="')[1].slice(0, -2))) return true;
            if (p.includes('[dir="') && attrs['dir'] === p.split('[dir="')[1].slice(0, -2)) return true;
          }
          return false;
        },
        closest: (sel: string) => {
          let cur: any = el;
          while (cur) {
            if (cur.matches && cur.matches(sel)) return cur;
            cur = cur.parentElement;
          }
          return null;
        },
        contains: (other: any) => {
          let cur = other;
          while (cur) {
            if (cur === el) return true;
            cur = cur.parentElement;
          }
          return false;
        }
      };

      for (const ch of children) {
        ch.parentElement = el;
      }
      return el;
    };

    // User-Name:
    const nameSpan = createEl('span', {}, 'Subramanian Swamy');
    const nameLink = createEl('a', { role: 'link' }, 'Subramanian Swamy', [nameSpan]);
    const handleSpan = createEl('span', {}, '@Swamy39');
    const handleDiv = createEl('div', {}, '@Swamy39', [handleSpan]);
    const userNameHeader = createEl('div', { 'data-testid': 'User-Name' }, '', [nameLink, handleDiv]);

    // Button:
    const btnSpan = createEl('span', {}, 'Follow');
    const btn = createEl('button', { 'data-testid': '12345-follow' }, 'Follow', [btnSpan]);

    // Bio (多层嵌套 div):
    const bioText = 'President of Virat Hindustan Sangam, fmr Cabinet Minister, Six terms MP, Member BJP, Harvard Ph.D (Economics), former Professor, I give as good as I get.';
    const bioSpan = createEl('span', {}, bioText);
    const bioInnerDiv = createEl('div', { class: 'css-146c3p1' }, bioText, [bioSpan]);
    const bioOuterDiv = createEl('div', { dir: 'auto' }, bioText, [bioInnerDiv]);

    // Social proof:
    const socialSpan = createEl('span', {}, '陈主任 follows');
    const socialDiv = createEl('div', { dir: 'ltr' }, '陈主任 follows', [socialSpan]);

    // UserCell:
    const contentCol = createEl('div', { class: 'col', dir: 'auto' }, '', [socialDiv, userNameHeader, btn, bioOuterDiv]);
    const userCell = createEl('div', { 'data-testid': 'UserCell' }, '', [contentCol]);

    const root = {
      querySelectorAll: (sel: string) => {
        return userCell.querySelectorAll(sel);
      }
    } as unknown as ParentNode;

    const blocks = extractTranslatableBlocks(root);
    console.log('EXTRACTED BLOCKS:', blocks.map(b => ({ id: b.id, tag: b.element.tagName, text: b.originalText })));

    expect(blocks.some(b => b.originalText.includes('President of Virat'))).toBe(true);
    expect(blocks.some(b => b.originalText === 'Follow')).toBe(true);
    expect(blocks.some(b => b.originalText.includes('陈主任 follows'))).toBe(true);
  });
});
