import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectTranslation, removeTranslation, clearAllTranslations } from '../src/content/dom/injector';
import { translateBatch } from '../src/background/translator';

describe('Wikipedia & Rich Webpage Translation Verification (严格综合测试)', () => {
  it('1. 维基百科目录 (TOC) 应准确提取章节标题，绝不破坏章节编号与折叠箭头', () => {
    const html = `
    <nav id="mw-panel-toc" aria-label="Contents" class="vector-toc-landmark">
      <div class="vector-pinnable-header">
        <h2 class="vector-pinnable-header-label">Contents</h2>
        <button class="vector-pinnable-header-toggle-button">hide</button>
      </div>
      <ul class="vector-toc-contents" id="mw-panel-toc-list">
        <li id="toc-mw-content-text" class="vector-toc-list-item vector-toc-level-1">
          <a href="#" class="vector-toc-link">
            <div class="vector-toc-text">(Top)</div>
          </a>
        </li>
        <li id="toc-Structure" class="vector-toc-list-item vector-toc-level-1">
          <a class="vector-toc-link" href="#Structure">
            <div class="vector-toc-text">
              <span class="vector-toc-numb">1</span>
              <span>Structure</span>
            </div>
          </a>
          <button class="vector-toc-toggle"><span>Toggle Structure subsection</span></button>
        </li>
        <li id="toc-Functions" class="vector-toc-list-item vector-toc-level-2">
          <a class="vector-toc-link" href="#Functions">
            <div class="vector-toc-text">
              <span class="vector-toc-numb">1.1</span>
              <span>Functions</span>
            </div>
          </a>
        </li>
      </ul>
    </nav>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body);

    // 验证：应当提取 "Contents", "hide", "(Top)", "Structure", "Functions"
    const texts = blocks.map(b => b.originalText);
    expect(texts).toContain('Contents');
    expect(texts).toContain('hide');
    expect(texts).toContain('(Top)');
    expect(texts).toContain('Structure');
    expect(texts).toContain('Functions');

    // 核心验证：章节数字 "1" 和 "1.1" 绝对不能作为待翻译块单独提取
    expect(texts).not.toContain('1');
    expect(texts).not.toContain('1.1');

    // 模拟翻译注入
    const structureBlock = blocks.find(b => b.originalText === 'Structure')!;
    injectTranslation(structureBlock, '结构', 'replace');

    const topBlock = blocks.find(b => b.originalText === '(Top)')!;
    injectTranslation(topBlock, '(顶部)', 'replace');

    // 验证注入后的 DOM 完整性
    const structureLi = doc.querySelector('#toc-Structure')!;
    const numberSpan = structureLi.querySelector('.vector-toc-numb')!;
    const titleSpan = structureLi.querySelector('.vector-toc-text > span:not(.vector-toc-numb)')!;
    const linkEl = structureLi.querySelector('a.vector-toc-link')!;

    expect(numberSpan.textContent).toBe('1'); // 编号完好保留
    expect(titleSpan.textContent).toBe('结构'); // 标题成功替换为中文
    expect(linkEl.getAttribute('href')).toBe('#Structure'); // 锚点链接未受破坏
  });

  it('2. 正文段落中的 <a> 超链接、<b> 加粗、<sup> 引用在原地替换后必须 100% 完整保留且可点击', () => {
    const html = `
    <p id="wiki-intro">
      A <b>content management system</b> (<b class="abbr">CMS</b>) is 
      <a rel="mw:WikiLink" href="/wiki/Software" title="Software">computer software</a> 
      used to manage content.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>
    </p>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body);
    expect(blocks.length).toBe(1);

    const pBlock = blocks[0];
    // 验证占位符正确编码
    expect(pBlock.originalText).toContain('<x0>content management system</x0>');
    expect(pBlock.originalText).toContain('<x1>CMS</x1>');
    expect(pBlock.originalText).toContain('<x2>computer software</x2>');
    expect(pBlock.originalText).toContain('<x3>[1]</x3>');
    expect(pBlock.inlineElements?.length).toBe(4);

    // 模拟注入由神经机器翻译引擎返回的带有占位符的中文译文
    const translatedHtml = '<x0>内容管理系统</x0>（<x1>CMS</x1>）是用于管理内容的<x2>计算机软件</x2>。<x3>[1]</x3>';
    injectTranslation(pBlock, translatedHtml, 'replace');

    const pEl = doc.querySelector('#wiki-intro')!;

    // 验证 1：超链接标签是否存在
    const softwareLink = pEl.querySelector('a[href="/wiki/Software"]') as HTMLAnchorElement;
    expect(softwareLink).not.toBeNull();
    expect(softwareLink.textContent).toBe('计算机软件');
    expect(softwareLink.getAttribute('title')).toBe('Software');
    expect(softwareLink.getAttribute('rel')).toBe('mw:WikiLink');

    // 验证 2：引用角标 <sup> 和内部的引用跳转链接是否完好
    const supEl = pEl.querySelector('sup#cite_ref-1');
    expect(supEl).not.toBeNull();
    const citeLink = supEl!.querySelector('a[href="#cite_note-1"]') as HTMLAnchorElement;
    expect(citeLink).not.toBeNull();
    expect(citeLink.textContent).toBe('[1]');

    // 验证 3：加粗属性 class="abbr" 是否完好
    const boldAbbr = pEl.querySelector('b.abbr');
    expect(boldAbbr).not.toBeNull();
    expect(boldAbbr!.textContent).toBe('CMS');

    // 验证 4：还原纯净原文 (Clear / Restore) 测试
    removeTranslation(pEl as HTMLElement);
    expect(pEl.querySelector('a[href="/wiki/Software"]')!.textContent).toBe('computer software');
    expect(pEl.textContent).toContain('content management system');
  });

  it('3. 维基百科段落编辑按钮 [ edit ] 应当汉化为 [ 编辑 ] 且链接属性完整保留', () => {
    const html = `
    <div class="mw-heading mw-heading2">
      <h2 id="Structure">Structure</h2>
      <span class="mw-editsection">
        <span class="mw-editsection-bracket">[</span>
        <a href="/w/index.php?title=CMS&action=edit&section=1" title="Edit section: Structure"><span>edit</span></a>
        <span class="mw-editsection-bracket">]</span>
      </span>
    </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body);
    const texts = blocks.map(b => b.originalText);

    expect(texts).toContain('Structure');
    expect(texts).toContain('edit');
    // 括号绝对不作为独立块误提取
    expect(texts).not.toContain('[');
    expect(texts).not.toContain(']');

    const editBlock = blocks.find(b => b.originalText === 'edit')!;
    injectTranslation(editBlock, '编辑', 'replace');

    const editAnchor = doc.querySelector('.mw-editsection a')!;
    expect(editAnchor.textContent).toBe('编辑');
    expect(editAnchor.getAttribute('title')).toBe('Edit section: Structure');
    expect(editAnchor.getAttribute('href')).toContain('action=edit');

    // 确认括号依旧在
    const brackets = doc.querySelectorAll('.mw-editsection-bracket');
    expect(brackets[0].textContent).toBe('[');
    expect(brackets[1].textContent).toBe(']');
  });

  it('4. UI_GLOSSARY 高频词库验证：维基百科核心术语瞬间地道汉化', async () => {
    const terms = ['Contents', 'hide', 'Light', 'Dark', 'Automatic', '(Top)', 'edit'];
    const res = await translateBatch(terms, 'zh-CN');

    expect(res.translations[0]).toBe('目录');
    expect(res.translations[1]).toBe('隐藏');
    expect(res.translations[2]).toBe('浅色');
    expect(res.translations[3]).toBe('深色');
    expect(res.translations[4]).toBe('自动');
    expect(res.translations[5]).toBe('(顶部)');
    expect(res.translations[6]).toBe('编辑');
  });

  it('5. 双语对照伴读模式下，译文浮层同样能够完整显示带超链接的格式', () => {
    const html = `
    <p id="bilingual-p">
      A <a href="/wiki/CMS">CMS</a> is great.
    </p>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body);
    const pBlock = blocks[0];

    injectTranslation(pBlock, '<x0>内容管理系统</x0>很棒。', 'bilingual');

    const wrapper = doc.querySelector('.translate-king-wrapper')!;
    expect(wrapper).not.toBeNull();
    const linkInSub = wrapper.querySelector('a[href="/wiki/CMS"]');
    expect(linkInSub).not.toBeNull();
    expect(linkInSub!.textContent).toBe('内容管理系统');
  });

  it('6. 参考文献列表 (.mw-references-wrap / .reflist) 与嵌入式 <style> 标签绝对保护，杜绝乱码与中英混杂', () => {
    const html = `
    <div class="mw-heading mw-heading2">
      <h2 id="References">References</h2>
    </div>
    <div class="mw-references-wrap">
      <ol class="mw-references references">
        <li id="cite_note-1">
          <style data-mw-deduplicate="TemplateStyles:r123">.mw-parser-output cite.citation{font-style:inherit}</style>
          <span class="mw-cite-backlink"><a href="#cite_ref-1"><span class="mw-linkback-text">↑</span></a></span>
          <span class="mw-reference-text reference-text"><i>Managing Enterprise Content</i>. Ann Rockley, 2003.</span>
        </li>
      </ol>
    </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body);
    const texts = blocks.map(b => b.originalText);

    // 标题 References 应当正常提取并翻译为 "参考文献"
    expect(texts).toContain('References');

    // 核心断言：参考文献列表本身绝对不被提取破坏
    expect(texts).not.toContain('Managing Enterprise Content');
    // 嵌入式 CSS 绝对不能泄漏到提取文本中
    expect(texts.some(t => t.includes('.mw-parser-output') || t.includes('font-style'))).toBe(false);
  });

  it('7. 参考文献中的文章标题超链接能够精准提取并翻译，链接属性与回跳箭头完好保留', () => {
    const html = `
    <div class="mw-references-wrap">
      <ol class="mw-references references">
        <li id="cite_note-4">
          <span class="mw-cite-backlink"><a href="#cite_ref-4">1</a> <a href="#cite_ref-4-1">2</a></span>
          <span class="mw-reference-text reference-text">
            <cite class="citation web">
              <a rel="nofollow" class="external text" href="https://whatis.com/article">"What is a Content Management System (CMS)? Definition from WhatIs.com"</a>. 
              <i>SearchContentManagement</i>. Retrieved 2019-09-23.
            </cite>
          </span>
        </li>
      </ol>
    </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body);
    const texts = blocks.map(b => b.originalText);

    // 核心断言：参考文献中的外链文章标题应当被成功提取
    expect(texts).toContain('"What is a Content Management System (CMS)? Definition from WhatIs.com"');

    // 回跳数字 "1", "2" 绝对不被提取破坏
    expect(texts).not.toContain('1');
    expect(texts).not.toContain('2');

    // 注入翻译测试
    const linkBlock = blocks.find(b => b.originalText.includes('What is a Content Management System'))!;
    injectTranslation(linkBlock, '“什么是内容管理系统（CMS）？来自 WhatIs.com 的定义”', 'replace');

    const linkEl = doc.querySelector('a.external')!;
    expect(linkEl.textContent).toBe('“什么是内容管理系统（CMS）？来自 WhatIs.com 的定义”');
    expect(linkEl.getAttribute('href')).toBe('https://whatis.com/article');
    expect(linkEl.getAttribute('rel')).toBe('nofollow');

    // 回跳箭头保持原貌
    const backlinks = doc.querySelectorAll('.mw-cite-backlink a');
    expect(backlinks[0].textContent).toBe('1');
    expect(backlinks[1].textContent).toBe('2');
  });
});
