/**
 * 翻译王 (TranslateKing) - 进阶交互套件：
 * 1. 按住 Ctrl 鼠标悬停单段即时翻译（指哪翻哪，再按还原）
 * 2. 在线 PDF / arXiv 论文页面自动检测与双模式（沉浸式原位 vs 聚光灯精读）悬浮打开条
 * 3. 通用网页文章一键总结面板（点击悬浮球『✨ 总结此页』提炼全文结构化双语要点并点击定位段落）
 */

import { TargetLanguage, TranslateBatchResponse, TranslationMode } from '../types';
import { createTranslateKingLogoElement } from './logo';
import { extractTranslatableBlocks } from './dom/extractor';
import { injectLoadingState, injectTranslation, removeTranslation } from './dom/injector';

let ctrlHoverEnabled = true;
let lastHoveredElement: HTMLElement | null = null;
let hoverListenersInitialized = false;

export function setCtrlHoverTranslateEnabled(enabled: boolean): void {
  ctrlHoverEnabled = enabled;
}

export function isCtrlHoverTranslateEnabled(): boolean {
  return ctrlHoverEnabled;
}

/**
 * 查找鼠标所在位置的最佳可翻译段落容器
 */
export function findHoverParagraphElement(target: HTMLElement | null): HTMLElement | null {
  if (!target || typeof target.closest !== 'function') return null;
  if (
    target.closest(
      '#translate-king-floating-ball, #translate-king-bubble-host, #translate-king-yt-summary-panel, #translate-king-webpage-summary-panel, #translate-king-pdf-detector-banner, [data-tk-ignore]'
    )
  ) {
    return null;
  }

  return target.closest<HTMLElement>(
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, figcaption, dd, dt, [data-testid="tweetText"], .update-components-text, .feed-shared-inline-show-more-text, article > div'
  );
}

/**
 * 对单个段落执行即时双语展开或还原（指哪翻哪）
 */
export async function toggleSingleParagraphTranslation(
  el: HTMLElement,
  targetLang: TargetLanguage = 'zh-CN',
  mode: TranslationMode = 'bilingual'
): Promise<boolean> {
  if (!el) return false;

  // 若该段落已处于翻译状态，再次触发则立即还原原文
  if (
    el.hasAttribute('data-tk-translated') ||
    el.hasAttribute('data-tk-replaced') ||
    el.querySelector('.translate-king-wrapper')
  ) {
    removeTranslation(el);
    el.removeAttribute('data-tk-hover-translated');
    return false;
  }

  // 提取该单段（或将其包装为临时容器提取）
  let blocks = extractTranslatableBlocks(el, targetLang);
  if (blocks.length === 0 && el.parentElement) {
    const parentBlocks = extractTranslatableBlocks(el.parentElement, targetLang);
    blocks = parentBlocks.filter((b) => b.element === el || el.contains(b.element));
  }
  if (blocks.length === 0) {
    const rawText = (el.textContent || '').trim();
    if (rawText.length >= 2) {
      blocks = [
        {
          id: `tk-hover-${Date.now()}`,
          element: el,
          originalText: rawText,
          tagName: el.tagName
        }
      ];
    }
  }
  if (blocks.length === 0) return false;

  blocks.forEach((b) => injectLoadingState(b, mode));

  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const texts = blocks.map((b) => b.originalText);
      chrome.runtime.sendMessage(
        {
          type: 'TRANSLATE_BATCH',
          texts,
          toLang: targetLang
        },
        (res: TranslateBatchResponse) => {
          if (chrome.runtime.lastError || !res || !Array.isArray(res.translations)) {
            blocks.forEach((b) => removeTranslation(b.element));
            return;
          }
          blocks.forEach((b, idx) => {
            const trans = res.translations[idx];
            if (trans && trans.trim() && trans.trim() !== b.originalText.trim()) {
              injectTranslation(b, trans, mode);
              b.element.setAttribute('data-tk-hover-translated', 'true');
            } else {
              removeTranslation(b.element);
            }
          });
        }
      );
      return true;
    } catch (_) {
      blocks.forEach((b) => removeTranslation(b.element));
    }
  }
  return false;
}

/**
 * 初始化「按住 Ctrl 鼠标悬停单段即时翻译」监听器
 */
export function initCtrlHoverParagraphTranslate(getTargetLang: () => TargetLanguage): void {
  if (typeof document === 'undefined' || hoverListenersInitialized) return;
  hoverListenersInitialized = true;

  document.addEventListener(
    'mousemove',
    (e) => {
      lastHoveredElement = e.target as HTMLElement | null;
    },
    { passive: true }
  );

  let ctrlPressedAlone = false;
  document.addEventListener('keydown', (e) => {
    if (!ctrlHoverEnabled) return;
    if (e.key === 'Control') {
      ctrlPressedAlone = true;
    } else {
      ctrlPressedAlone = false;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!ctrlHoverEnabled) return;
    if (e.key === 'Control' && ctrlPressedAlone) {
      ctrlPressedAlone = false;
      const para = findHoverParagraphElement(lastHoveredElement);
      if (para) {
        toggleSingleParagraphTranslation(para, getTargetLang(), 'bilingual');
      }
    }
  });
}

/**
 * 检测当前网页是否为在线 PDF 或 arXiv PDF 论文页面
 */
export function isCurrentPagePdfDocument(): { isPdf: boolean; pdfUrl: string; arxivHtmlUrl: string | null } {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { isPdf: false, pdfUrl: '', arxivHtmlUrl: null };
  }

  const href = window.location.href || '';
  const path = window.location.pathname || '';
  const isPdfExt = /\.pdf(?:$|\?|#)/i.test(href) || /\/pdf\/[0-9]{4}\.[0-9]{4,5}/i.test(path);
  const isPdfMime = (document.contentType || '').toLowerCase() === 'application/pdf';
  const hasPdfEmbed = Boolean(document.querySelector('embed[type="application/pdf"], iframe[src*=".pdf"]'));

  const arxivMatch = href.match(/arxiv\.org\/pdf\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i);
  const arxivHtmlUrl = arxivMatch ? `https://arxiv.org/html/${arxivMatch[1]}` : null;

  return {
    isPdf: isPdfExt || isPdfMime || hasPdfEmbed,
    pdfUrl: href,
    arxivHtmlUrl
  };
}

/**
 * 打开翻译王双模式 PDF Studio 阅读器
 */
export function openPdfStudioPage(pdfUrl?: string, mode: 'immersive' | 'spotlight' = 'immersive'): void {
  const baseUrl =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('pdf.html')
      : '/pdf.html';
  const params = new URLSearchParams();
  params.set('mode', mode);
  if (pdfUrl && /^https?:|^file:/i.test(pdfUrl)) {
    params.set('file', pdfUrl);
  }
  const target = `${baseUrl}?${params.toString()}`;
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(target, '_blank');
  }
}

/**
 * 在在线 PDF 或 arXiv 论文页面右上角挂载「双模式 PDF 双语精读」悬浮入口胶囊
 */
export function mountOnlinePdfDetectorBanner(): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  if (document.getElementById('translate-king-pdf-detector-banner')) return true;

  const { isPdf, pdfUrl, arxivHtmlUrl } = isCurrentPagePdfDocument();
  if (!isPdf) return false;

  const banner = document.createElement('div');
  banner.id = 'translate-king-pdf-detector-banner';
  banner.setAttribute('translate', 'no');
  banner.setAttribute('data-tk-ignore', 'true');
  banner.style.cssText = `
    position: fixed !important;
    top: 16px !important;
    right: 20px !important;
    z-index: 2147483646 !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 8px 14px !important;
    border-radius: 999px !important;
    background: linear-gradient(135deg, rgba(15, 29, 58, 0.96), rgba(9, 17, 34, 0.96)) !important;
    border: 1px solid rgba(59, 130, 246, 0.55) !important;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55) !important;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif !important;
    color: #F8FAFC !important;
  `;

  banner.appendChild(createTranslateKingLogoElement(22, 'pdf-banner'));

  const immersiveBtn = document.createElement('button');
  immersiveBtn.id = 'tk-open-pdf-immersive-btn';
  immersiveBtn.textContent = '🖼️ 沉浸式原位对照打开 PDF';
  immersiveBtn.style.cssText = `
    border: 1px solid rgba(59, 130, 246, 0.6) !important;
    background: linear-gradient(135deg, #1E40AF, #2563EB) !important;
    color: #FFFFFF !important;
    font-size: 12px !important;
    font-weight: 700 !important;
    padding: 5px 11px !important;
    border-radius: 999px !important;
    cursor: pointer !important;
  `;
  immersiveBtn.addEventListener('click', () => openPdfStudioPage(pdfUrl, 'immersive'));
  banner.appendChild(immersiveBtn);

  const spotlightBtn = document.createElement('button');
  spotlightBtn.id = 'tk-open-pdf-spotlight-btn';
  spotlightBtn.textContent = '🔦 聚光灯精读打开 PDF';
  spotlightBtn.style.cssText = `
    border: 1px solid rgba(96, 165, 250, 0.45) !important;
    background: rgba(37, 99, 235, 0.25) !important;
    color: #DBEAFE !important;
    font-size: 12px !important;
    font-weight: 600 !important;
    padding: 5px 11px !important;
    border-radius: 999px !important;
    cursor: pointer !important;
  `;
  spotlightBtn.addEventListener('click', () => openPdfStudioPage(pdfUrl, 'spotlight'));
  banner.appendChild(spotlightBtn);

  if (arxivHtmlUrl) {
    const arxivBtn = document.createElement('button');
    arxivBtn.id = 'tk-open-arxiv-html-btn';
    arxivBtn.textContent = '⚡ arXiv 原生 HTML 双语版';
    arxivBtn.style.cssText = `
      border: 1px solid rgba(251, 191, 36, 0.55) !important;
      background: rgba(217, 119, 6, 0.28) !important;
      color: #FDE047 !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      padding: 5px 11px !important;
      border-radius: 999px !important;
      cursor: pointer !important;
    `;
    arxivBtn.addEventListener('click', () => {
      window.location.href = arxivHtmlUrl;
    });
    banner.appendChild(arxivBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    border: none !important;
    background: transparent !important;
    color: #94A3B8 !important;
    font-size: 13px !important;
    cursor: pointer !important;
    padding: 2px 5px !important;
  `;
  closeBtn.addEventListener('click', () => banner.remove());
  banner.appendChild(closeBtn);

  document.body.appendChild(banner);
  return true;
}

/**
 * 通用网页一键总结面板：提取任意长文网页的核心段落生成宝石蓝主题结构化双语总结，点击可平滑滚动定位原文段落
 */
export function toggleWebpageSummaryPanel(targetLang: TargetLanguage = 'zh-CN'): void {
  if (typeof document === 'undefined' || !document.body) return;

  // 若当前页已存在视频总结按钮，直接优先唤醒视频总结面板
  const videoSummaryBtn = document.querySelector<HTMLElement>(
    '#translate-king-yt-summary-btn, #translate-king-bili-summary-btn, #translate-king-universal-summary-btn'
  );
  if (videoSummaryBtn) {
    videoSummaryBtn.click();
    return;
  }

  const existing = document.getElementById('translate-king-webpage-summary-panel');
  if (existing) {
    existing.remove();
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'translate-king-webpage-summary-panel';
  panel.setAttribute('translate', 'no');
  panel.setAttribute('data-tk-ignore', 'true');
  panel.style.cssText = `
    position: fixed !important;
    top: 72px !important;
    right: 22px !important;
    width: 380px !important;
    max-width: calc(100vw - 32px) !important;
    max-height: 540px !important;
    display: flex !important;
    flex-direction: column !important;
    background: linear-gradient(180deg, #0f1d3a 0%, #091122 100%) !important;
    color: #f8fafc !important;
    border: 1px solid rgba(59, 130, 246, 0.48) !important;
    border-radius: 14px !important;
    box-shadow: 0 16px 40px rgba(2, 6, 23, 0.72) !important;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif !important;
    z-index: 2147483642 !important;
    overflow: hidden !important;
    user-select: text !important;
    -webkit-user-select: text !important;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 12px 14px !important;
    background: linear-gradient(135deg, rgba(30, 64, 175, 0.55) 0%, rgba(37, 99, 235, 0.28) 60%, rgba(15, 23, 42, 0.95) 100%) !important;
    border-bottom: 1px solid rgba(59, 130, 246, 0.3) !important;
  `;

  const titleGroup = document.createElement('div');
  titleGroup.style.cssText = 'display: flex !important; align-items: center !important; gap: 7px !important; font-weight: 700 !important; font-size: 13.5px !important; color: #EFF6FF !important;';
  titleGroup.appendChild(createTranslateKingLogoElement(18, 'web-summary'));
  const titleSpan = document.createElement('span');
  titleSpan.textContent = '网页核心要点总结';
  titleGroup.appendChild(titleSpan);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background: transparent !important; border: none !important; color: #93C5FD !important; font-size: 15px !important; cursor: pointer !important; padding: 2px 6px !important;';
  closeBtn.addEventListener('click', () => panel.remove());

  header.appendChild(titleGroup);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = `
    padding: 12px 14px !important;
    overflow-y: auto !important;
    max-height: 450px !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 10px !important;
    font-size: 13px !important;
    line-height: 1.55 !important;
    user-select: text !important;
  `;

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('article h1, article h2, article h3, article p, main h1, main h2, main p, h1, h2, h3, p')
  ).filter((el) => {
    if (el.closest('#translate-king-webpage-summary-panel, nav, footer, header')) return false;
    const t = (el.textContent || '').trim();
    return t.length >= 25;
  });

  const selectedEls = candidates.slice(0, 12);
  if (selectedEls.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding: 18px !important; text-align: center !important; color: #94a3b8 !important;';
    empty.textContent = '当前页面未检测到足够长的文章段落。';
    body.appendChild(empty);
  } else {
    const items: Array<{ el: HTMLElement; orig: string; zhNode: HTMLElement }> = [];
    selectedEls.forEach((el, idx) => {
      const orig = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      const card = document.createElement('div');
      card.style.cssText = `
        padding: 10px 12px !important;
        background: linear-gradient(135deg, rgba(30, 58, 138, 0.28), rgba(15, 23, 42, 0.85)) !important;
        border: 1px solid rgba(59, 130, 246, 0.24) !important;
        border-radius: 10px !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 5px !important;
      `;

      const badge = document.createElement('button');
      badge.style.cssText = `
        align-self: flex-start !important;
        background: rgba(37, 99, 235, 0.25) !important;
        color: #93C5FD !important;
        border: 1px solid rgba(59, 130, 246, 0.45) !important;
        border-radius: 6px !important;
        padding: 2px 7px !important;
        font-size: 11.5px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
      `;
      badge.textContent = `📌 要点 #${idx + 1} · 点击定位原文`;
      badge.addEventListener('click', () => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      const zhNode = document.createElement('div');
      zhNode.style.cssText = 'color: #f8fafc !important; font-weight: 600 !important; font-size: 13px !important;';
      zhNode.textContent = orig;

      const origNode = document.createElement('div');
      origNode.style.cssText = 'color: #94a3b8 !important; font-size: 12px !important;';
      origNode.textContent = orig;

      card.appendChild(badge);
      card.appendChild(zhNode);
      card.appendChild(origNode);
      body.appendChild(card);
      items.push({ el, orig, zhNode });
    });

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'TRANSLATE_BATCH',
            texts: items.map((it) => it.orig),
            toLang: targetLang
          },
          (res: TranslateBatchResponse) => {
            if (chrome.runtime.lastError || !res || !Array.isArray(res.translations)) return;
            items.forEach((it, i) => {
              if (res.translations[i]) {
                it.zhNode.textContent = res.translations[i];
              }
            });
          }
        );
      } catch (_) {}
    }
  }

  panel.appendChild(body);
  document.body.appendChild(panel);
}
