/**
 * 翻译王 (TranslateKing) - 双模式学术 PDF 与文档双语工作台主控脚本
 *
 * 支持三大阅读模式一键切换：
 * 1. 🖼️ 沉浸式原位对照模式 (immersive)：左栏 1:1 原版 PDF + 右栏 1:1 原版面坐标原位覆盖译文（复刻沉浸式翻译方案）
 * 2. 🔦 聚光灯双栏精读模式 (spotlight)：左栏 1:1 原版 PDF（带宝石蓝聚光灯高亮框）+ 右栏舒适大字号双语卡片流 + 原版公式切片
 * 3. 📄 单栏原位译文模式 (single)：单栏全宽展示原位覆盖中文译文的 PDF 画布，悬停段落浮现原文
 */

import type { TargetLanguage, TranslateBatchResponse } from '../types';
import type { WordLookupResult } from '../background/dictionary';
import {
  PdfParagraphBlock,
  PdfRawTextItem,
  clusterPdfTextItemsToParagraphs,
  parsePlainDocumentToBlocks,
  restoreMathTokens
} from './parser';

function createPdfStudioLogo(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    width: 30px;
    height: 30px;
    border-radius: 7px;
    background: linear-gradient(135deg, #1E40AF 0%, #2563EB 55%, #3B82F6 100%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #FDE047;
    font-weight: 800;
    font-size: 13px;
    box-shadow: 0 2px 8px rgba(37, 99, 235, 0.45);
    border: 1px solid rgba(147, 197, 253, 0.45);
  `;
  wrap.textContent = 'A文';
  return wrap;
}

export type PdfStudioViewMode = 'immersive' | 'spotlight' | 'single';

interface RenderedPageModel {
  pageNumber: number;
  width: number;
  height: number;
  sourceCanvas: HTMLCanvasElement;
  blocks: PdfParagraphBlock[];
}

let currentViewMode: PdfStudioViewMode = 'immersive';
let currentTargetLang: TargetLanguage = 'zh-CN';
let currentDocName = '未命名文档.pdf';
let renderedPages: RenderedPageModel[] = [];

/**
 * 调用后台 TRANSLATE_BATCH 翻译网关
 */
async function requestBatchTranslation(texts: string[], toLang: TargetLanguage): Promise<string[]> {
  if (texts.length === 0) return [];
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'TRANSLATE_BATCH',
            texts,
            toLang
          },
          (res: TranslateBatchResponse) => {
            if (chrome.runtime.lastError || !res || !Array.isArray(res.translations)) {
              resolve(texts);
              return;
            }
            resolve(res.translations);
          }
        );
      } catch (_) {
        resolve(texts);
      }
    });
  }
  return texts;
}

/**
 * 将还原后的文本与 {v1} 数学公式片段安全渲染进目标 DOM 节点（零 innerHTML）
 */
function appendRestoredSegmentsToElement(container: HTMLElement, text: string, mathTokens: string[]): void {
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  const segments = restoreMathTokens(text, mathTokens);
  for (const seg of segments) {
    if (seg.type === 'math') {
      const mathSpan = document.createElement('span');
      mathSpan.className = 'tk-math-token';
      mathSpan.textContent = seg.value;
      container.appendChild(mathSpan);
    } else {
      container.appendChild(document.createTextNode(seg.value));
    }
  }
}

/**
 * 从原始 PDF Canvas 按段落 bbox 裁剪高清快照切片（用于独立公式或图表原样还原）
 */
function cropCanvasSnapshot(
  sourceCanvas: HTMLCanvasElement,
  pageWidth: number,
  pageHeight: number,
  bbox: { x: number; y: number; width: number; height: number }
): HTMLCanvasElement | null {
  try {
    const scaleX = sourceCanvas.width / pageWidth;
    const scaleY = sourceCanvas.height / pageHeight;
    const pad = 6;
    const sx = Math.max(0, Math.floor((bbox.x - pad) * scaleX));
    const sy = Math.max(0, Math.floor((bbox.y - pad) * scaleY));
    const sw = Math.min(sourceCanvas.width - sx, Math.ceil((bbox.width + pad * 2) * scaleX));
    const sh = Math.min(sourceCanvas.height - sy, Math.ceil((bbox.height + pad * 2) * scaleY));
    if (sw <= 4 || sh <= 4) return null;

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    out.className = 'tk-stream-snapshot-canvas';
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * 双向聚光灯联动：当用户悬停或点击某一段落 (blockId) 时，同时高亮左栏原稿框、右栏原位覆盖框和右栏精读流卡片
 */
function highlightBlockSpotlight(blockId: string | null, scrollIntoView = false): void {
  const allActive = document.querySelectorAll('.is-spotlight-active');
  allActive.forEach((el) => el.classList.remove('is-spotlight-active'));

  if (!blockId) return;
  const targets = document.querySelectorAll<HTMLElement>(`[data-tk-block-id="${blockId}"]`);
  targets.forEach((el) => {
    el.classList.add('is-spotlight-active');
    if (scrollIntoView && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

/**
 * 渲染所有已解析页面至工作区（同时构建沉浸式原位覆盖层与聚光灯双语流，支持毫秒级无感切换模式）
 */
function renderWorkspacePages(): void {
  const dropzone = document.getElementById('tk-pdf-dropzone');
  const workspace = document.getElementById('tk-pdf-workspace');
  const container = document.getElementById('tk-pdf-pages-container');
  const docNameEl = document.getElementById('tk-pdf-doc-name');

  if (!workspace || !container) return;
  if (dropzone) dropzone.hidden = true;
  workspace.hidden = false;
  workspace.setAttribute('data-view-mode', currentViewMode);
  if (docNameEl) docNameEl.textContent = currentDocName;

  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  for (const page of renderedPages) {
    const row = document.createElement('div');
    row.className = 'tk-pdf-page-row';
    row.id = `tk-pdf-page-${page.pageNumber}`;

    // =========================================================================
    // 1. 左栏：1:1 原版高清 PDF 画布 + 聚光灯交互框
    // =========================================================================
    const leftPane = document.createElement('div');
    leftPane.className = 'tk-pdf-pane-card tk-pdf-left-pane';

    const leftBadge = document.createElement('div');
    leftBadge.className = 'tk-pdf-pane-badge';
    leftBadge.textContent = `原版 PDF · 第 ${page.pageNumber} 页`;
    leftPane.appendChild(leftBadge);

    const leftStage = document.createElement('div');
    leftStage.className = 'tk-pdf-canvas-stage';
    leftStage.appendChild(page.sourceCanvas);

    // 挂载原版 PDF 上的聚光灯热区框
    for (const block of page.blocks) {
      const spotBox = document.createElement('div');
      spotBox.className = 'tk-pdf-spotlight-box';
      spotBox.setAttribute('data-tk-block-id', block.id);
      spotBox.style.left = `${block.normBox.leftPct}%`;
      spotBox.style.top = `${block.normBox.topPct}%`;
      spotBox.style.width = `${block.normBox.widthPct}%`;
      spotBox.style.height = `${block.normBox.heightPct}%`;
      spotBox.title = '点击定位到右侧对应中文译文';

      spotBox.addEventListener('mouseenter', () => highlightBlockSpotlight(block.id, false));
      spotBox.addEventListener('mouseleave', () => highlightBlockSpotlight(null, false));
      spotBox.addEventListener('click', (e) => {
        e.stopPropagation();
        highlightBlockSpotlight(block.id, true);
      });

      leftStage.appendChild(spotBox);
    }

    leftPane.appendChild(leftStage);
    row.appendChild(leftPane);

    // =========================================================================
    // 2. 右栏：同时包含【模式 A：沉浸式原位覆盖画布】与【模式 B：翻译王聚光灯双语卡片流】
    // =========================================================================
    const rightPane = document.createElement('div');
    rightPane.className = 'tk-pdf-pane-card tk-pdf-right-pane';

    const rightBadge = document.createElement('div');
    rightBadge.className = 'tk-pdf-pane-badge';
    rightBadge.textContent = `双语对照 · 第 ${page.pageNumber} 页`;
    rightPane.appendChild(rightBadge);

    // 2A. 沉浸式原位覆盖画布容器 (Immersive In-Place Overlay)
    const rightCanvasWrap = document.createElement('div');
    rightCanvasWrap.className = 'tk-pdf-canvas-stage tk-pdf-right-canvas-wrap';

    const clonedCanvas = document.createElement('canvas');
    clonedCanvas.width = page.sourceCanvas.width;
    clonedCanvas.height = page.sourceCanvas.height;
    const clonedCtx = clonedCanvas.getContext('2d');
    if (clonedCtx) {
      clonedCtx.drawImage(page.sourceCanvas, 0, 0);
    }
    rightCanvasWrap.appendChild(clonedCanvas);

    const overlayLayer = document.createElement('div');
    overlayLayer.className = 'tk-pdf-overlay-layer';

    for (const block of page.blocks) {
      const ovBlock = document.createElement('div');
      ovBlock.className = `tk-pdf-overlay-block is-${block.kind}`;
      ovBlock.setAttribute('data-tk-block-id', block.id);
      ovBlock.setAttribute('data-tk-overlay-text', block.id);
      ovBlock.style.left = `${block.normBox.leftPct}%`;
      ovBlock.style.top = `${block.normBox.topPct}%`;
      ovBlock.style.width = `${block.normBox.widthPct}%`;
      ovBlock.style.height = `${block.normBox.heightPct}%`;
      ovBlock.style.setProperty('--tk-orig-h', `${block.normBox.heightPct}%`);

      // 自适应字号计算：确保中文在原版双栏坐标框内清晰可读且不轻易截断
      const scaledFontPx =
        block.kind === 'heading'
          ? Math.max(12, Math.min(18, Math.round(block.fontSize * 0.95)))
          : Math.max(10.5, Math.min(13.5, Math.round(block.fontSize * 0.88)));
      ovBlock.style.fontSize = `${scaledFontPx}px`;
      ovBlock.title = `原文：${block.originalText}`;

      const displayTrans = block.translatedText || '⏳ 正在翻译...';
      appendRestoredSegmentsToElement(ovBlock, displayTrans, block.mathTokens);

      ovBlock.addEventListener('mouseenter', () => highlightBlockSpotlight(block.id, false));
      ovBlock.addEventListener('mouseleave', () => highlightBlockSpotlight(null, false));
      ovBlock.addEventListener('click', (e) => {
        if (window.getSelection()?.toString().trim()) return;
        e.stopPropagation();
        highlightBlockSpotlight(block.id, false);
      });

      overlayLayer.appendChild(ovBlock);
    }

    rightCanvasWrap.appendChild(overlayLayer);
    rightPane.appendChild(rightCanvasWrap);

    // 2B. 翻译王聚光灯大字号双语卡片流容器 (Spotlight Bilingual Stream)
    const spotlightStream = document.createElement('div');
    spotlightStream.className = 'tk-pdf-spotlight-stream';

    for (const block of page.blocks) {
      const card = document.createElement('div');
      card.className = `tk-stream-card is-${block.kind}`;
      card.setAttribute('data-tk-block-id', block.id);

      const meta = document.createElement('div');
      meta.className = 'tk-stream-meta';
      const kindLabel =
        block.kind === 'heading'
          ? '📑 章节标题'
          : block.kind === 'formula'
          ? '📐 数学公式 (原版保护)'
          : block.kind === 'caption'
          ? '🖼️ 图表图注'
          : `段落 · ${block.column === 'left' ? '左栏' : block.column === 'right' ? '右栏' : '跨栏'}`;
      const metaLeft = document.createElement('span');
      metaLeft.textContent = `P${page.pageNumber} · ${kindLabel}`;
      const metaRight = document.createElement('span');
      metaRight.textContent = block.mathTokens.length > 0 ? `含 ${block.mathTokens.length} 处公式保护` : '点击左栏聚光定位';
      meta.appendChild(metaLeft);
      meta.appendChild(metaRight);
      card.appendChild(meta);

      // 若是独立公式块，直接从原版 PDF Canvas 裁剪原图高清切片嵌入卡片
      if (block.kind === 'formula') {
        const snapshot = cropCanvasSnapshot(page.sourceCanvas, page.width, page.height, block.bbox);
        if (snapshot) {
          card.appendChild(snapshot);
        }
      }

      const origEl = document.createElement('div');
      origEl.className = 'tk-stream-orig';
      origEl.textContent = block.originalText;
      card.appendChild(origEl);

      const transEl = document.createElement('div');
      transEl.className = 'tk-stream-trans';
      transEl.setAttribute('data-tk-stream-text', block.id);
      const displayTrans = block.translatedText || '⏳ 正在翻译...';
      appendRestoredSegmentsToElement(transEl, displayTrans, block.mathTokens);
      card.appendChild(transEl);

      card.addEventListener('mouseenter', () => highlightBlockSpotlight(block.id, false));
      card.addEventListener('mouseleave', () => highlightBlockSpotlight(null, false));
      card.addEventListener('click', () => {
        if (window.getSelection()?.toString().trim()) return;
        const leftSpot = leftStage.querySelector<HTMLElement>(`[data-tk-block-id="${block.id}"]`);
        leftSpot?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlightBlockSpotlight(block.id, false);
      });

      spotlightStream.appendChild(card);
    }

    rightPane.appendChild(spotlightStream);
    row.appendChild(rightPane);
    container.appendChild(row);
  }
}

/**
 * 批量翻译所有页面段落并实时回填到【沉浸式原位覆盖层】与【聚光灯精读流】
 */
async function translateAllPagesBlocks(): Promise<void> {
  const statusEl = document.getElementById('tk-pdf-status-text');
  const allBlocks: PdfParagraphBlock[] = [];
  for (const p of renderedPages) {
    allBlocks.push(...p.blocks);
  }
  if (allBlocks.length === 0) return;

  if (statusEl) {
    statusEl.textContent = `⏳ 正在翻译全篇文档 (共 ${renderedPages.length} 页 / ${allBlocks.length} 个自然段，已启用 {v1} 数学公式保护)...`;
  }

  const batchSize = 12;
  for (let i = 0; i < allBlocks.length; i += batchSize) {
    const chunk = allBlocks.slice(i, i + batchSize);
    const textsToSend = chunk.map((b) => b.protectedText);
    const translations = await requestBatchTranslation(textsToSend, currentTargetLang);

    chunk.forEach((block, idx) => {
      const rawTrans = translations[idx] || block.originalText;
      block.translatedText = rawTrans;

      const ovEl = document.querySelector<HTMLElement>(`[data-tk-overlay-text="${block.id}"]`);
      if (ovEl) {
        appendRestoredSegmentsToElement(ovEl, rawTrans, block.mathTokens);
      }

      const streamEl = document.querySelector<HTMLElement>(`[data-tk-stream-text="${block.id}"]`);
      if (streamEl) {
        appendRestoredSegmentsToElement(streamEl, rawTrans, block.mathTokens);
      }
    });

    if (statusEl) {
      const done = Math.min(allBlocks.length, i + chunk.length);
      statusEl.textContent = `✅ 已完成 ${done} / ${allBlocks.length} 段双语渲染 (${currentDocName})`;
    }
  }

  buildSummaryDrawerCards();
}

/**
 * 生成全文结构化章节总结卡片
 */
function buildSummaryDrawerCards(): void {
  const listEl = document.getElementById('tk-pdf-summary-list');
  if (!listEl) return;
  while (listEl.firstChild) {
    listEl.removeChild(listEl.firstChild);
  }

  for (const page of renderedPages) {
    const headingBlock = page.blocks.find((b) => b.kind === 'heading') || page.blocks[0];
    const bodyBlock = page.blocks.find((b) => b.kind === 'paragraph') || headingBlock;
    if (!bodyBlock) continue;

    const card = document.createElement('div');
    card.className = 'tk-pdf-summary-card';

    const title = document.createElement('div');
    title.style.cssText = 'font-size: 12.5px; font-weight: 700; color: #93c5fd; margin-bottom: 4px;';
    title.textContent = `▶ 第 ${page.pageNumber} 页 · ${(headingBlock?.translatedText || headingBlock?.originalText || '').slice(0, 42)}`;

    const summary = document.createElement('div');
    summary.style.cssText = 'font-size: 12.5px; color: #e2e8f0; line-height: 1.45;';
    appendRestoredSegmentsToElement(
      summary,
      bodyBlock.translatedText || bodyBlock.originalText,
      bodyBlock.mathTokens
    );

    card.appendChild(title);
    card.appendChild(summary);
    card.addEventListener('click', () => {
      const pageEl = document.getElementById(`tk-pdf-page-${page.pageNumber}`);
      pageEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    listEl.appendChild(card);
  }
}

/**
 * 使用本地内置 Mozilla PDF.js (./pdfjs/pdf.min.mjs) 解析并渲染任意二进制 PDF
 */
async function loadPdfFromBuffer(data: ArrayBuffer, fileName: string): Promise<void> {
  const statusEl = document.getElementById('tk-pdf-status-text');
  currentDocName = fileName;
  if (statusEl) statusEl.textContent = `⏳ 正在使用 PDF.js 解析文档：${fileName}...`;

  try {
    const pdfjsUrl =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('pdfjs/pdf.min.mjs')
        : './pdfjs/pdf.min.mjs';
    const workerUrl =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('pdfjs/pdf.worker.min.mjs')
        : './pdfjs/pdf.worker.min.mjs';

    const pdfjsLib: any = await import(/* @vite-ignore */ pdfjsUrl);
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    }

    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    const numPages = Math.min(pdfDoc.numPages || 1, 50);
    renderedPages = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const scale = 1.65;
      const viewport = page.getViewport({ scale });
      const unscaledViewport = page.getViewport({ scale: 1.0 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport }).promise;
      }

      const textContent = await page.getTextContent();
      const rawItems: PdfRawTextItem[] = (textContent?.items || []).map((item: any) => ({
        str: item.str || '',
        transform: item.transform || [12, 0, 0, 12, 0, 0],
        width: item.width || 0,
        height: item.height || 0,
        fontName: item.fontName || '',
        hasEOL: Boolean(item.hasEOL)
      }));

      const blocks = clusterPdfTextItemsToParagraphs(
        rawItems,
        unscaledViewport.width,
        unscaledViewport.height,
        pageNum
      );

      renderedPages.push({
        pageNumber: pageNum,
        width: unscaledViewport.width,
        height: unscaledViewport.height,
        sourceCanvas: canvas,
        blocks
      });
    }

    renderWorkspacePages();
    await translateAllPagesBlocks();
  } catch (err) {
    console.error('[TranslateKing PDF] 解析 PDF 异常:', err);
    if (statusEl) {
      statusEl.textContent = `⚠️ PDF 解析失败 (${err instanceof Error ? err.message : String(err)})，已为您加载学术论文演示页。`;
    }
    await loadAcademicDemoPaper();
  }
}

/**
 * 加载纯文本 / Markdown / SRT 本地文件并以双栏画布+双语流渲染
 */
async function loadPlainTextDocument(text: string, fileName: string): Promise<void> {
  currentDocName = fileName;
  const allBlocks = parsePlainDocumentToBlocks(text, fileName);
  const pageMap = new Map<number, PdfParagraphBlock[]>();
  for (const b of allBlocks) {
    const list = pageMap.get(b.pageNumber) || [];
    list.push(b);
    pageMap.set(b.pageNumber, list);
  }

  renderedPages = [];
  for (const [pageNumber, blocks] of pageMap.entries()) {
    const pageWidth = 600;
    const pageHeight = 840;
    const canvas = document.createElement('canvas');
    canvas.width = pageWidth * 1.5;
    canvas.height = pageHeight * 1.5;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(1.5, 1.5);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pageWidth, pageHeight);
      ctx.fillStyle = '#0f172a';
      for (const b of blocks) {
        ctx.font = `${b.kind === 'heading' ? 'bold 14px' : '11px'} -apple-system, sans-serif`;
        ctx.fillText(b.originalText.slice(0, 85), b.bbox.x, b.bbox.y + 14);
      }
    }
    renderedPages.push({
      pageNumber,
      width: pageWidth,
      height: pageHeight,
      sourceCanvas: canvas,
      blocks
    });
  }

  renderWorkspacePages();
  await translateAllPagesBlocks();
}

/**
 * 内置双栏学术论文演示页（《Attention Is All You Need》经典双栏版面 + 数学公式）
 * 让用户无需找文件即可一键对比【沉浸式原位对照模式】与【翻译王聚光灯精读模式】！
 */
async function loadAcademicDemoPaper(): Promise<void> {
  currentDocName = 'Attention_Is_All_You_Need_arXiv_1706.03762.pdf';
  const pageWidth = 612;
  const pageHeight = 792;

  const canvas = document.createElement('canvas');
  canvas.width = pageWidth * 2;
  canvas.height = pageHeight * 2;
  const ctx = canvas.getContext('2d');

  // 构造真实的双栏学术论文 PDF 坐标碎片（顶栏标题 + 摘要 + 左栏第 1 节 + 右栏第 2 节与 Scaled Dot-Product Attention 数学公式）
  const demoItems: PdfRawTextItem[] = [
    // 跨栏大标题
    {
      str: 'Attention Is All You Need',
      transform: [18, 0, 0, 18, 178, pageHeight - 70],
      width: 256,
      height: 18,
      fontName: 'Times-Bold'
    },
    // 跨栏摘要标题
    {
      str: 'Abstract',
      transform: [12, 0, 0, 12, 280, pageHeight - 115],
      width: 52,
      height: 12,
      fontName: 'Times-Bold'
    },
    // 跨栏摘要正文
    {
      str: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      transform: [10, 0, 0, 10, 72, pageHeight - 140],
      width: 468,
      height: 11,
      fontName: 'Times-Roman'
    },
    {
      str: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
      transform: [10, 0, 0, 10, 72, pageHeight - 156],
      width: 468,
      height: 11,
      fontName: 'Times-Roman'
    },
    // 左栏：1 Introduction
    {
      str: '1 Introduction',
      transform: [12, 0, 0, 12, 54, pageHeight - 210],
      width: 110,
      height: 12,
      fontName: 'Times-Bold'
    },
    {
      str: 'Recurrent neural networks, long short-term memory and gated recurrent neural networks have been firmly established as state of the art approaches in sequence modeling.',
      transform: [9.5, 0, 0, 9.5, 54, pageHeight - 235],
      width: 230,
      height: 10,
      fontName: 'Times-Roman'
    },
    {
      str: 'However, recurrent models typically factor computation along the symbol positions of the input and output sequences, where hidden state h_t is a function of h_{t-1}.',
      transform: [9.5, 0, 0, 9.5, 54, pageHeight - 295],
      width: 230,
      height: 10,
      fontName: 'Times-Roman'
    },
    {
      str: '2 Model Architecture',
      transform: [12, 0, 0, 12, 54, pageHeight - 365],
      width: 140,
      height: 12,
      fontName: 'Times-Bold'
    },
    {
      str: 'The Transformer follows this overall architecture using stacked self-attention and point-wise, fully connected layers for both the encoder and decoder, with d_{model} = 512.',
      transform: [9.5, 0, 0, 9.5, 54, pageHeight - 392],
      width: 230,
      height: 10,
      fontName: 'Times-Roman'
    },
    // 右栏：3.2.1 Scaled Dot-Product Attention + 数学公式
    {
      str: '3.2 Scaled Dot-Product Attention',
      transform: [12, 0, 0, 12, 324, pageHeight - 210],
      width: 195,
      height: 12,
      fontName: 'Times-Bold'
    },
    {
      str: 'We compute the matrix of outputs as:',
      transform: [9.5, 0, 0, 9.5, 324, pageHeight - 235],
      width: 230,
      height: 10,
      fontName: 'Times-Roman'
    },
    {
      str: 'Attention(Q, K, V) = softmax(QK^T / √d_k)V   (1)',
      transform: [11, 0, 0, 11, 332, pageHeight - 270],
      width: 215,
      height: 14,
      fontName: 'CMMI10-Math'
    },
    {
      str: 'Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions:',
      transform: [9.5, 0, 0, 9.5, 324, pageHeight - 315],
      width: 230,
      height: 10,
      fontName: 'Times-Roman'
    },
    {
      str: 'MultiHead(Q, K, V) = Concat(head_1, ..., head_h)W^O   (2)',
      transform: [10.5, 0, 0, 10.5, 328, pageHeight - 375],
      width: 222,
      height: 14,
      fontName: 'CMMI10-Math'
    }
  ];

  const blocks = clusterPdfTextItemsToParagraphs(demoItems, pageWidth, pageHeight, 1);
  // 校准演示段落高度以便在原版 Canvas 上逼真绘制多行学术论文版面
  const demoHeights = [26, 18, 48, 20, 52, 54, 20, 56, 20, 24, 32, 48, 34];
  blocks.forEach((b, idx) => {
    const h = demoHeights[idx] || 36;
    b.bbox.height = h;
    b.normBox.heightPct = Number(((h / pageHeight) * 100).toFixed(2));
  });

  if (ctx) {
    ctx.scale(2, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageWidth, pageHeight);

    // 绘制学术论文顶部分隔线
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(54, 42);
    ctx.lineTo(pageWidth - 54, 42);
    ctx.stroke();

    // 绘制每一个段落到原版 PDF Canvas 上
    for (const b of blocks) {
      ctx.fillStyle = b.kind === 'formula' ? '#1e1b4b' : '#0f172a';
      ctx.font =
        b.kind === 'heading'
          ? `bold ${Math.round(b.fontSize)}px "Times New Roman", Georgia, serif`
          : b.kind === 'formula'
          ? `italic bold ${Math.round(b.fontSize)}px "Times New Roman", Georgia, serif`
          : `${Math.round(b.fontSize)}px "Times New Roman", Georgia, serif`;

      if (b.kind === 'formula') {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(b.bbox.x - 4, b.bbox.y - 2, b.bbox.width + 8, b.bbox.height + 4);
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(b.bbox.x - 4, b.bbox.y - 2, b.bbox.width + 8, b.bbox.height + 4);
        ctx.fillStyle = '#1e1b4b';
      }

      // 自动折行绘制英文原稿
      const words = b.originalText.split(' ');
      let line = '';
      let drawY = b.bbox.y + b.fontSize;
      for (const w of words) {
        const testLine = line ? `${line} ${w}` : w;
        if (ctx.measureText(testLine).width > b.bbox.width && line) {
          ctx.fillText(line, b.bbox.x, drawY);
          line = w;
          drawY += b.fontSize * 1.28;
        } else {
          line = testLine;
        }
      }
      if (line) {
        ctx.fillText(line, b.bbox.x, drawY);
      }
    }
  }

  renderedPages = [
    {
      pageNumber: 1,
      width: pageWidth,
      height: pageHeight,
      sourceCanvas: canvas,
      blocks
    }
  ];

  renderWorkspacePages();
  await translateAllPagesBlocks();
}

/**
 * 切换阅读模式（沉浸式原位对照 / 翻译王聚光灯精读 / 单栏原位译文）
 */
function switchViewMode(mode: PdfStudioViewMode): void {
  currentViewMode = mode;
  const workspace = document.getElementById('tk-pdf-workspace');
  if (workspace) {
    workspace.setAttribute('data-view-mode', mode);
  }
  document.querySelectorAll<HTMLElement>('.tk-mode-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-mode') === mode);
  });
}

/**
 * 导出整篇文档为双语对照 Markdown (.md)
 */
function exportBilingualMarkdown(): void {
  if (renderedPages.length === 0) return;
  const lines: string[] = [
    `# ${currentDocName} - 翻译王双语对照笔记`,
    `> 生成工具：翻译王 (TranslateKing PDF Studio) · 数学公式无损保护`,
    ''
  ];

  for (const page of renderedPages) {
    lines.push(`## 第 ${page.pageNumber} 页`);
    lines.push('');
    for (const block of page.blocks) {
      if (block.kind === 'heading') {
        lines.push(`### ${block.originalText}`);
        if (block.translatedText) {
          lines.push(`**${block.translatedText}**`);
        }
      } else if (block.kind === 'formula') {
        lines.push(`$$${block.originalText}$$`);
      } else {
        lines.push(block.originalText);
        if (block.translatedText) {
          lines.push(`> ${block.translatedText}`);
        }
      }
      lines.push('');
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentDocName.replace(/\.[^.]+$/, '')}-bilingual.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 在 PDF 工作台内启用划词翻译与双音标发音浮窗
 */
function setupPdfSelectionLookup(): void {
  let popupEl: HTMLElement | null = null;

  const ensurePopup = (): HTMLElement => {
    if (popupEl && document.body.contains(popupEl)) return popupEl;
    popupEl = document.createElement('div');
    popupEl.id = 'tk-pdf-selection-card';
    popupEl.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      width: 320px;
      max-width: calc(100vw - 24px);
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid rgba(59, 130, 246, 0.5);
      border-radius: 12px;
      padding: 12px 14px;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.55);
      font-size: 13px;
      line-height: 1.5;
      display: none;
    `;
    document.body.appendChild(popupEl);
    return popupEl;
  };

  document.addEventListener(
    'mousedown',
    (e) => {
      if (popupEl && popupEl.style.display !== 'none' && !popupEl.contains(e.target as Node)) {
        popupEl.style.display = 'none';
      }
    },
    true
  );

  document.addEventListener(
    'mouseup',
    (e) => {
      if (popupEl && popupEl.contains(e.target as Node)) return;

      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const word = selection.toString().replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (!word || word.length > 300) return;

        let rect: DOMRect;
        try {
          rect = selection.getRangeAt(0).getBoundingClientRect();
        } catch (_) {
          return;
        }

        const card = ensurePopup();
        while (card.firstChild) card.removeChild(card.firstChild);

        const left = Math.max(12, Math.min(window.innerWidth - 336, rect.left));
        const top = rect.bottom + 200 > window.innerHeight ? Math.max(12, rect.top - 150) : rect.bottom + 8;
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
        card.style.display = 'block';

        const loading = document.createElement('div');
        loading.style.color = '#93c5fd';
        loading.textContent = `⏳ 正在查询 "${word.slice(0, 36)}"...`;
        card.appendChild(loading);

        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const hasZh = /[\u4e00-\u9fa5]/.test(word);
          const lookupLang: TargetLanguage = hasZh && currentTargetLang.startsWith('zh') ? 'en' : currentTargetLang;
          chrome.runtime.sendMessage(
            {
              type: 'LOOKUP_WORD',
              word,
              sentence: word,
              targetLang: lookupLang
            },
            (res: WordLookupResult) => {
              if (chrome.runtime.lastError || !res) return;
              while (card.firstChild) card.removeChild(card.firstChild);

              const head = document.createElement('div');
              head.style.cssText = 'display: flex; align-items: center; justify-content: space-between; font-weight: 700; color: #eff6ff; margin-bottom: 6px;';
              head.textContent = res.word || word;

              if (res.phonetic) {
                const ph = document.createElement('span');
                ph.style.cssText = 'font-size: 12px; color: #93c5fd; font-weight: 500; margin-left: 8px;';
                ph.textContent = `/${res.phonetic}/`;
                head.appendChild(ph);
              }
              card.appendChild(head);

              const meaning = document.createElement('div');
              meaning.style.cssText = 'color: #fde047; font-weight: 600; margin-bottom: 4px; white-space: pre-wrap;';
              meaning.textContent = res.meaning || res.sentenceTranslation || '';
              card.appendChild(meaning);

              if (res.sentenceTranslation && res.sentenceTranslation !== res.meaning) {
                const sent = document.createElement('div');
                sent.style.cssText = 'color: #cbd5e1; font-size: 12px; border-top: 1px solid rgba(59,130,246,0.2); padding-top: 5px; margin-top: 5px;';
                sent.textContent = res.sentenceTranslation;
                card.appendChild(sent);
              }
            }
          );
        }
      }, 40);
    },
    true
  );
}

/**
 * 初始化 PDF Studio 工作台
 */
async function initPdfStudio(): Promise<void> {
  // 挂载品牌 Logo
  const logoSlot = document.getElementById('tk-pdf-brand-logo');
  if (logoSlot) {
    logoSlot.appendChild(createPdfStudioLogo());
  }

  // 模式切换按钮
  document.querySelectorAll<HTMLElement>('.tk-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn.getAttribute('data-mode') || 'immersive') as PdfStudioViewMode;
      switchViewMode(mode);
    });
  });

  // 目标语言切换
  const langSelect = document.getElementById('tk-pdf-target-lang') as HTMLSelectElement | null;
  if (langSelect) {
    langSelect.addEventListener('change', () => {
      currentTargetLang = (langSelect.value || 'zh-CN') as TargetLanguage;
      if (renderedPages.length > 0) {
        translateAllPagesBlocks();
      }
    });
  }

  // 本地文件选择
  const fileInput = document.getElementById('tk-pdf-file-input') as HTMLInputElement | null;
  const handleFile = async (file: File) => {
    if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
      const buf = await file.arrayBuffer();
      await loadPdfFromBuffer(buf, file.name);
    } else {
      const text = await file.text();
      await loadPlainTextDocument(text, file.name);
    }
  };

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
  });

  // 全屏拖拽上传
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  // 在线链接输入栏
  const urlBar = document.getElementById('tk-pdf-url-bar');
  const urlInput = document.getElementById('tk-pdf-url-input') as HTMLInputElement | null;
  document.getElementById('tk-pdf-url-btn')?.addEventListener('click', () => {
    if (urlBar) urlBar.hidden = !urlBar.hidden;
  });
  document.getElementById('tk-pdf-url-close-btn')?.addEventListener('click', () => {
    if (urlBar) urlBar.hidden = true;
  });
  document.getElementById('tk-pdf-url-load-btn')?.addEventListener('click', async () => {
    const targetUrl = urlInput?.value.trim();
    if (!targetUrl) return;
    if (urlBar) urlBar.hidden = true;
    await loadPdfFromRemoteUrl(targetUrl);
  });

  // 示例论文按钮
  document.getElementById('tk-pdf-demo-btn')?.addEventListener('click', () => loadAcademicDemoPaper());
  document.getElementById('tk-dropzone-demo-btn')?.addEventListener('click', () => loadAcademicDemoPaper());

  // 全文总结抽屉
  const summaryDrawer = document.getElementById('tk-pdf-summary-drawer');
  document.getElementById('tk-pdf-summary-btn')?.addEventListener('click', () => {
    if (!summaryDrawer) return;
    if (renderedPages.length === 0) {
      loadAcademicDemoPaper().then(() => {
        summaryDrawer.hidden = false;
      });
    } else {
      buildSummaryDrawerCards();
      summaryDrawer.hidden = !summaryDrawer.hidden;
    }
  });
  document.getElementById('tk-pdf-summary-close')?.addEventListener('click', () => {
    if (summaryDrawer) summaryDrawer.hidden = true;
  });

  // 导出与打印
  document.getElementById('tk-pdf-export-md-btn')?.addEventListener('click', () => exportBilingualMarkdown());
  document.getElementById('tk-pdf-print-btn')?.addEventListener('click', () => window.print());

  // 启用划词查词
  setupPdfSelectionLookup();

  // 检查 URL 参数 ?file= 是否带有在线 PDF 地址或 ?demo=1
  const params = new URLSearchParams(window.location.search);
  const fileUrl = params.get('file');
  const modeParam = params.get('mode') as PdfStudioViewMode | null;
  if (modeParam && ['immersive', 'spotlight', 'single'].includes(modeParam)) {
    switchViewMode(modeParam);
  }

  if (fileUrl) {
    await loadPdfFromRemoteUrl(fileUrl);
  } else if (params.get('demo') === '1') {
    await loadAcademicDemoPaper();
  }
}

async function loadPdfFromRemoteUrl(url: string): Promise<void> {
  const statusEl = document.getElementById('tk-pdf-status-text');
  if (statusEl) statusEl.textContent = `⏳ 正在下载在线 PDF：${url}...`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'online-paper.pdf');
    await loadPdfFromBuffer(buf, name);
  } catch (err) {
    console.warn('[TranslateKing PDF] 远程加载失败，自动加载演示论文:', err);
    await loadAcademicDemoPaper();
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initPdfStudio());
  } else {
    initPdfStudio();
  }
}
