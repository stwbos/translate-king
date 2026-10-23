import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks, findTopLevelInlineElements } from '../src/content/dom/extractor';
import { injectTranslation, removeTranslation } from '../src/content/dom/injector';

describe('知乎等富文本排版与加粗内联链接专项测试 (Zhihu RichText & Nested Inlines)', () => {
  it('1. 当整段被 <strong> 加粗且内部嵌套 <a> 链接时，应提取真实的 <a> 为占位符，绝不把整段加粗当成单一内联项', () => {
    const html = `
      <div class="RichContent-inner">
        <p><strong>方向框定了胜率，真正拉开差距的是<a class="internal" href="https://www.zhihu.com/search?q=预期差">预期差</a>，也就是市场以为的样子和实际发生的样子之间的缺口。</strong></p>
      </div>
    `;
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const p = doc.querySelector('p') as HTMLElement;

    // 1. 验证 findTopLevelInlineElements 深度穿透整段加粗外壳，定位内部真实的 <a> 标签
    const inlines = findTopLevelInlineElements(p);
    expect(inlines.length).toBe(1);
    expect(inlines[0].tagName).toBe('A');
    expect(inlines[0].textContent).toBe('预期差');

    // 2. 验证提取器生成的 rawText 正确将 <a> 替换为 <x0>，保留整段语义
    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe(
      '方向框定了胜率，真正拉开差距的是<x0>预期差</x0>，也就是市场以为的样子和实际发生的样子之间的缺口。'
    );
    expect(blocks[0].inlineElements?.length).toBe(1);
    expect(blocks[0].inlineElements![0].tagName).toBe('A');

    // 3. 模拟翻译引擎返回的完整译文 (含 <x0> 占位符)
    const translatedText =
      'Direction sets the winning rate; what truly widens the gap is <x0>the expectation gap</x0>—the gap between what the market thinks and what actually happens.';

    // 4. 执行直接替换模式注入 (replace mode)
    injectTranslation(blocks[0], translatedText, 'replace');

    // 5. 严格断言：
    // a. 绝无“中文 + 英文 + 中文”半截残留与中英拼贴！
    expect(p.textContent).not.toContain('方向框定了胜率');
    expect(p.textContent).not.toContain('，也就是市场以为的样子');
    expect(p.textContent).toBe(
      'Direction sets the winning rate; what truly widens the gap is the expectation gap—the gap between what the market thinks and what actually happens.'
    );

    // b. 原有 <strong> 加粗排版与 <a> 超链接及 href 属性 100% 完整保留！
    const strongEl = p.querySelector('strong');
    expect(strongEl).not.toBeNull();
    const anchorEl = p.querySelector('a');
    expect(anchorEl).not.toBeNull();
    expect(anchorEl?.getAttribute('href')).toBe('https://www.zhihu.com/search?q=预期差');
    expect(anchorEl?.textContent).toBe('the expectation gap');

    // 6. 还原测试
    removeTranslation(p);
    expect(p.textContent).toBe(
      '方向框定了胜率，真正拉开差距的是预期差，也就是市场以为的样子和实际发生的样子之间的缺口。'
    );
  });

  it('2. 在双语对照模式 (bilingual mode) 下，带链接与加粗的段落应优雅呈现双语，不破坏原链接', () => {
    const html = `
      <p><strong>方向框定了胜率，真正拉开差距的是<a class="internal" href="https://www.zhihu.com/search?q=预期差">预期差</a>，也就是市场以为的样子和实际发生的样子之间的缺口。</strong></p>
    `;
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const blocks = extractTranslatableBlocks(doc);

    const translatedText =
      'Direction sets the winning rate; what truly widens the gap is <x0>the expectation gap</x0>—the gap between what the market thinks and what actually happens.';

    injectTranslation(blocks[0], translatedText, 'bilingual');

    const p = doc.querySelector('p') as HTMLElement;
    // 原文保持不变
    expect(p.innerHTML).toContain('方向框定了胜率');
    // 双语容器已插入
    const wrapper = p.querySelector('.translate-king-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.textContent).toContain('Direction sets the winning rate');
    // 译文内部的 <a> 链接也正确生成
    const transAnchor = wrapper?.querySelector('a');
    expect(transAnchor).not.toBeNull();
    expect(transAnchor?.textContent).toBe('the expectation gap');
    expect(transAnchor?.getAttribute('href')).toBe('https://www.zhihu.com/search?q=预期差');
  });
});
