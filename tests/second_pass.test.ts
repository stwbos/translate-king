import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectTranslation } from '../src/content/dom/injector';

describe('Second Pass (MutationObserver) Double Extraction Bug', () => {
  it('checks if parent containers are extracted in second pass after children are translated', () => {
    const pageHtml = `
    <nav id="mw-panel-toc" class="vector-toc-landmark">
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
          <button class="cdx-button vector-toc-toggle"><span>Toggle Structure</span></button>
        </li>
        <li id="toc-Installation" class="vector-toc-list-item vector-toc-level-1">
          <a class="vector-toc-link" href="#Installation">
            <div class="vector-toc-text">
              <span class="vector-toc-numb">2</span>
              <span>Installation</span>
            </div>
          </a>
        </li>
      </ul>
    </nav>
    `;
    const dom = new JSDOM(pageHtml);
    const doc = dom.window.document;

    // PASS 1
    const blocks1 = extractTranslatableBlocks(doc.body);
    expect(blocks1.length).toBeGreaterThan(0);

    // Inject Pass 1
    blocks1.forEach(b => injectTranslation(b, '【译】' + b.originalText, 'replace'));

    // PASS 2 (simulating MutationObserver)
    const blocks2 = extractTranslatableBlocks(doc.body);

    // blocks2 must NOT contain any elements that enclose elements from blocks1
    let foundDisaster = false;
    for (const b2 of blocks2) {
      for (const b1 of blocks1) {
        if (b2.element.contains(b1.element)) {
          foundDisaster = true;
        }
      }
    }

    expect(foundDisaster).toBe(false);
    expect(blocks2.length).toBe(0);
  });
});
