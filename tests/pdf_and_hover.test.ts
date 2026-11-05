// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isMathFontOrToken,
  protectMathTokens,
  restoreMathTokens,
  clusterPdfTextItemsToParagraphs,
  parsePlainDocumentToBlocks,
  PdfRawTextItem
} from '../src/pdf/parser';
import {
  findHoverParagraphElement,
  toggleSingleParagraphTranslation,
  isCurrentPagePdfDocument,
  mountOnlinePdfDetectorBanner,
  toggleWebpageSummaryPanel
} from '../src/content/hover-translate';
import { setupFloatingBall, removeFloatingBall } from '../src/content/floating-ball';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectTranslation, clearAllTranslations } from '../src/content/dom/injector';

describe('PDFMathTranslate Protocol & Dual-Mode Layout Parser', () => {
  it('identifies math fonts (CMMI, CMSY, Math) and symbolic tokens accurately', () => {
    expect(isMathFontOrToken('CMMI10', 'x')).toBe(true);
    expect(isMathFontOrToken('Times-Roman', '∑')).toBe(true);
    expect(isMathFontOrToken('NimbusRomNo9L', 'Attention(Q,K,V)=softmax(QK^T/√d_k)V')).toBe(true);
    expect(isMathFontOrToken('NimbusRomNo9L', 'Natural language processing')).toBe(false);
  });

  it('protects inline math formulas and font tokens into {v1}, {v2} placeholders and restores them after translation', () => {
    const rawText = 'Given input matrix $Q, K, V$ and scaling factor √d_k = 64, we compute Softmax(QK^T).';
    const { protectedText, mathTokens } = protectMathTokens(rawText, ['d_k']);

    expect(protectedText).toContain('{v1}');
    expect(mathTokens.length).toBeGreaterThanOrEqual(2);

    // Simulate translation engine returning Chinese with {v1}, {v2} preserved (even with extra spaces like { v1 })
    const simulatedTranslated = protectedText
      .replace('Given input matrix', '给定输入矩阵')
      .replace('{v1}', '{ v1 }')
      .replace('and scaling factor', '以及缩放因子')
      .replace('we compute', '我们计算');

    const segments = restoreMathTokens(simulatedTranslated, mathTokens);
    const mathSegments = segments.filter((s) => s.type === 'math');
    expect(mathSegments.length).toBeGreaterThanOrEqual(2);
    expect(mathSegments.some((s) => s.value.includes('Q, K, V'))).toBe(true);
  });

  it('clusters 2-column academic PDF text items in correct reading order (Full-width -> Left Col -> Right Col) with normBox and hyphen healing', () => {
    const pageWidth = 600;
    const pageHeight = 800;

    // PDF native coordinates have Y=0 at bottom, Y=800 at top
    const rawItems: PdfRawTextItem[] = [
      // 1. Full-width title near top (pdfY = 730 -> topY ≈ 52)
      {
        str: '1 Introduction: Attention Is All You Need',
        transform: [18, 0, 0, 18, 80, 730],
        width: 420,
        height: 18,
        fontName: 'Times-Bold'
      },
      // 2. Left column paragraph line 1 (x = 50, pdfY = 620) with trailing hyphen
      {
        str: 'The dominant sequence trans-',
        transform: [10, 0, 0, 10, 50, 620],
        width: 210,
        height: 10,
        fontName: 'Times-Roman'
      },
      // 3. Left column paragraph line 2 (x = 50, pdfY = 606)
      {
        str: 'duction models are based on recurrent networks.',
        transform: [10, 0, 0, 10, 50, 606],
        width: 220,
        height: 10,
        fontName: 'Times-Roman'
      },
      // 4. Right column paragraph line 1 (x = 330, pdfY = 620)
      {
        str: 'We propose a new simple network architecture, the Transformer.',
        transform: [10, 0, 0, 10, 330, 620],
        width: 230,
        height: 10,
        fontName: 'Times-Roman'
      },
      // 5. Right column paragraph line 2 (x = 330, pdfY = 560)
      {
        str: 'Experiments on two machine translation tasks show superior quality.',
        transform: [10, 0, 0, 10, 330, 560],
        width: 230,
        height: 10,
        fontName: 'Times-Roman'
      },
      // 6. Standalone display equation in Left column (x = 70, pdfY = 540)
      {
        str: 'Attention(Q, K, V) = softmax(QK^T / √d_k)V   (1)',
        transform: [10, 0, 0, 10, 70, 540],
        width: 200,
        height: 12,
        fontName: 'CMMI10'
      }
    ];

    const blocks = clusterPdfTextItemsToParagraphs(rawItems, pageWidth, pageHeight, 1);
    expect(blocks.length).toBe(5);

    // Block 0: Full-width heading
    expect(blocks[0].kind).toBe('heading');
    expect(blocks[0].originalText).toContain('Attention Is All You Need');
    expect(blocks[0].column).toBe('full');

    // Block 1: Left column paragraph with hyphen healed ("trans-" + "duction" -> "transduction")
    expect(blocks[1].column).toBe('left');
    expect(blocks[1].originalText).toContain('transduction models are based on recurrent networks.');
    expect(blocks[1].normBox.leftPct).toBeCloseTo((50 / 600) * 100, 1);
    expect(blocks[1].normBox.widthPct).toBeGreaterThan(30);

    // Block 2: Left column standalone formula block
    expect(blocks[2].column).toBe('left');
    expect(blocks[2].kind).toBe('formula');

    // Block 3 & 4: Right column paragraphs come AFTER left column blocks
    expect(blocks[3].column).toBe('right');
    expect(blocks[3].originalText).toContain('Transformer');
  });

  it('parses Markdown and SRT documents into structured blocks', () => {
    const srtContent = `1\n00:00:01,000 --> 00:00:04,000\nWelcome to the Transformer paper walkthrough.\n\n2\n00:00:05,000 --> 00:00:09,000\nSelf-attention relates different positions of a single sequence.`;
    const srtBlocks = parsePlainDocumentToBlocks(srtContent, 'lecture.srt');
    expect(srtBlocks.length).toBe(2);
    expect(srtBlocks[0].originalText).toContain('Welcome to the Transformer paper walkthrough.');

    const mdContent = `# 1 Introduction\n\nWe replace recurrence with self-attention $O(1)$ operations in every layer.`;
    const mdBlocks = parsePlainDocumentToBlocks(mdContent, 'notes.md');
    expect(mdBlocks.length).toBe(2);
    expect(mdBlocks[0].kind).toBe('heading');
    expect(mdBlocks[1].protectedText).toContain('{v1}');
  });
});

describe('Ctrl Hover Single-Paragraph Translation & Online PDF / Webpage Summary', () => {
  beforeEach(() => {
    removeFloatingBall();
    document.body.textContent = '';
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        getURL: (p: string) => `chrome-extension://test-ext-id/${p}`,
        sendMessage: vi.fn((msg: any, cb?: (res: any) => void) => {
          if (msg.type === 'TRANSLATE_BATCH') {
            cb?.({
              translations: msg.texts.map((t: string) => `[中译] ${t}`)
            });
          }
        })
      },
      storage: {
        local: {
          get: vi.fn((_keys: any, cb?: (res: any) => void) => cb?.({ enableHoverTranslate: true })),
          set: vi.fn()
        },
        onChanged: {
          addListener: vi.fn()
        }
      }
    };
  });

  it('translates a single hovered paragraph on first trigger and restores pure original text on second trigger', async () => {
    const article = document.createElement('article');
    const p = document.createElement('p');
    p.textContent = 'Self-attention allows the model to jointly attend to information from different representation subspaces.';
    article.appendChild(p);
    document.body.appendChild(article);

    const found = findHoverParagraphElement(p);
    expect(found).toBe(p);

    // 1st trigger: translates paragraph in-place
    const translated = await toggleSingleParagraphTranslation(p, 'zh-CN');
    expect(translated).toBe(true);
    expect(p.querySelector('.translate-king-wrapper')).not.toBeNull();
    expect(p.textContent).toContain('[中译] Self-attention allows the model');

    // 2nd trigger: restores original paragraph cleanly
    const restored = await toggleSingleParagraphTranslation(p, 'zh-CN');
    expect(restored).toBe(false);
    expect(p.querySelector('.translate-king-wrapper')).toBeNull();
  });

  it('detects online arXiv PDF URLs and mounts the dual-mode PDF + arXiv HTML banner', () => {
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://arxiv.org/pdf/1706.03762.pdf')
    });

    const detection = isCurrentPagePdfDocument();
    expect(detection.isPdf).toBe(true);
    expect(detection.arxivHtmlUrl).toBe('https://arxiv.org/html/1706.03762');

    const mounted = mountOnlinePdfDetectorBanner();
    expect(mounted).toBe(true);
    const banner = document.getElementById('translate-king-pdf-detector-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('沉浸式原位对照打开 PDF');
    expect(banner?.textContent).toContain('聚光灯精读打开 PDF');
    expect(banner?.textContent).toContain('arXiv 原生 HTML 双语版');

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation
    });
  });

  it('extracts webpage key points and opens the Webpage Summary panel', () => {
    const main = document.createElement('main');
    const h2 = document.createElement('h2');
    h2.textContent = 'Why Self-Attention Architecture Matters for Long-Range Dependencies';
    const p1 = document.createElement('p');
    p1.textContent =
      'Recurrent models typically factor computation along the symbol positions of the input and output sequences, which precludes parallelization within training examples.';
    main.appendChild(h2);
    main.appendChild(p1);
    document.body.appendChild(main);

    toggleWebpageSummaryPanel('zh-CN');
    const panel = document.getElementById('translate-king-webpage-summary-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('[中译]');
  });

  it('renders Floating Ball with Ctrl Hover switch, Webpage Summary button, and PDF Studio button', () => {
    setupFloatingBall({
      onToggleTranslate: vi.fn(),
      onChangeMode: vi.fn(),
      onChangeTheme: vi.fn(),
      onToggleAutoSite: vi.fn(),
      getState: () => ({
        isTranslated: false,
        mode: 'bilingual',
        theme: 'default',
        isAutoSite: false,
        enabled: true
      })
    });

    const host = document.getElementById('translate-king-floating-ball');
    expect(host).not.toBeNull();
    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();

    // Click the floating ball pill to open the popover card
    const pill = shadow?.querySelector('.tk-ball-pill') as HTMLElement | null;
    pill?.click();

    expect(shadow?.querySelector('[data-tk-action="summary"]')).not.toBeNull();
    expect(shadow?.querySelector('[data-tk-action="pdf-studio"]')).not.toBeNull();
    expect(shadow?.textContent).toContain('鼠标悬停单段译');
    expect(shadow?.textContent).toContain('Ctrl');
  });

  it('never reparents or destroys Virtual DOM child nodes on LinkedIn/SPA feeds and prevents re-extraction flicker loops', () => {
    const pageRoot = document.createElement('div');
    const root = document.createElement('div');
    root.className = 'occludable-update feed-shared-update-v2 ember-view';

    const updateText = document.createElement('div');
    updateText.className = 'update-components-text';
    const spanBreakWords = document.createElement('span');
    spanBreakWords.className = 'break-words';
    spanBreakWords.appendChild(document.createTextNode('Building reliable agentic workflows with '));
    const anchor = document.createElement('a');
    anchor.href = 'https://www.linkedin.com';
    anchor.textContent = 'open source models';
    spanBreakWords.appendChild(anchor);
    spanBreakWords.appendChild(document.createTextNode(' in production.'));
    const moreBtn = document.createElement('button');
    moreBtn.className = 'inline-show-more-text__button';
    moreBtn.textContent = '…更多';
    spanBreakWords.appendChild(moreBtn);
    updateText.appendChild(spanBreakWords);
    root.appendChild(updateText);
    pageRoot.appendChild(root);

    // Paragraph containing an inline action <button>, plus a standalone <button> outside LinkedIn feed card
    const articleSec = document.createElement('section');
    const pWithBtn = document.createElement('p');
    pWithBtn.appendChild(document.createTextNode('Architecture overview for distributed training '));
    const inlineBtn = document.createElement('button');
    inlineBtn.textContent = 'Copy citation';
    pWithBtn.appendChild(inlineBtn);
    articleSec.appendChild(pWithBtn);

    const standaloneBtn = document.createElement('button');
    standaloneBtn.textContent = 'Load more papers';
    articleSec.appendChild(standaloneBtn);
    pageRoot.appendChild(articleSec);

    document.body.appendChild(pageRoot);

    const blocks = extractTranslatableBlocks(pageRoot, 'zh-CN');
    const texts = blocks.map((b) => b.originalText);

    // 1. Zero DOM reparenting during extraction (prevents React/Ember removeChild crash)
    expect(pageRoot.querySelectorAll('[data-tk-inline-group="true"]').length).toBe(0);
    expect(anchor.parentElement).toBe(spanBreakWords);

    // 2. Paragraph with inline button and standalone button extracted cleanly
    expect(texts).toContain('Architecture overview for distributed training');
    expect(texts).not.toContain('Architecture overview for distributed training Copy citation');
    expect(texts).toContain('Load more papers');

    // 3. Inject translations in replace mode on Virtual DOM feed and verify anchor.parentElement is STILL spanBreakWords (no removeChild crash!) and second pass extracts 0 blocks (no flicker loop!)
    for (const block of blocks) {
      injectTranslation(block, `[中译] ${block.originalText}`, 'replace');
    }
    expect(anchor.parentElement).toBe(spanBreakWords);
    const secondPassReplace = extractTranslatableBlocks(pageRoot, 'zh-CN');
    expect(secondPassReplace.length).toBe(0);

    // 4. Restore and verify bilingual mode also yields 0 blocks on second pass
    clearAllTranslations(pageRoot);
    const blocksBilingual = extractTranslatableBlocks(pageRoot, 'zh-CN');
    for (const block of blocksBilingual) {
      injectTranslation(block, `[中译] ${block.originalText}`, 'bilingual');
    }
    expect(anchor.parentElement).toBe(spanBreakWords);
    const secondPassBilingual = extractTranslatableBlocks(pageRoot, 'zh-CN');
    expect(secondPassBilingual.length).toBe(0);

    clearAllTranslations(pageRoot);
    expect(pageRoot.querySelectorAll('.translate-king-wrapper').length).toBe(0);
  });
});
