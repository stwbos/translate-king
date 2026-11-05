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
let lastMouseX = -1;
let lastMouseY = -1;
let hoverListenersInitialized = false;
let lastCtrlMovedBlock: HTMLElement | null = null;

export function setCtrlHoverTranslateEnabled(enabled: boolean): void {
  ctrlHoverEnabled = enabled;
}

export function isCtrlHoverTranslateEnabled(): boolean {
  return ctrlHoverEnabled;
}

/**
 * 查找鼠标所在位置的最佳可翻译段落容器（支持 p/li/h1-h6 以及现代网页普遍使用的 div/span 文本块）
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

  // 1. 若鼠标正好指在已翻译出来的译文块 (.translate-king-wrapper) 上，向上找到宿主段落以便还原
  const wrapper = target.closest<HTMLElement>('.translate-king-wrapper');
  if (wrapper && wrapper.parentElement) {
    return wrapper.parentElement;
  }

  // 2. 若鼠标指在已标记过 data-tk-translated 的段落内，直接返回该段落
  const translatedHost = target.closest<HTMLElement>('[data-tk-translated], [data-tk-hover-translated]');
  if (translatedHost) {
    return translatedHost;
  }

  // 3. 优先匹配标准语义段落标签
  const semantic = target.closest<HTMLElement>(
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, figcaption, dd, dt, summary, [data-testid="tweetText"], .update-components-text, .feed-shared-inline-show-more-text, .bili-rich-text-content, #content-text'
  );
  if (semantic && (semantic.textContent || '').trim().length >= 2) {
    return semantic;
  }

  // 4. 兜底匹配现代网页常见的 div / span / a / section 独立文本块（向上寻找文本长度适中的叶子容器）
  let curr: HTMLElement | null = target;
  for (let depth = 0; depth < 5 && curr && curr !== document.body && curr !== document.documentElement; depth++) {
    const tag = curr.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') {
      return null;
    }
    const text = (curr.textContent || '').replace(/\s+/g, ' ').trim();
    const blockChildren = curr.querySelectorAll('p, div, li, article, section, table').length;
    if (text.length >= 2 && text.length <= 1600 && blockChildren <= 2) {
      return curr;
    }
    curr = curr.parentElement;
  }

  return null;
}

/**
 * 对单个段落执行即时双语展开或还原（指哪翻哪，支持中英双向自动互译）
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
    el.hasAttribute('data-tk-hover-translated') ||
    el.querySelector('.translate-king-wrapper')
  ) {
    removeTranslation(el);
    el.removeAttribute('data-tk-hover-translated');
    return false;
  }

  // 提取纯净段落原文（剔除内部可能残存的译文容器）
  const clone = el.cloneNode(true) as HTMLElement;
  if (typeof clone.querySelectorAll === 'function') {
    clone.querySelectorAll('.translate-king-wrapper, script, style').forEach((n) => n.remove());
  }
  const rawText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
  if (rawText.length < 2) return false;

  // 智能双向互译：如果用户鼠标指着中文段落按 Ctrl，且目标语言是中文，则自动互译为英文 (en)，确保任何页面按 Ctrl 都有即时双语反馈！
  const cjkCount = (rawText.match(/[\u4e00-\u9fa5]/g) || []).length;
  const isMostlyChinese = cjkCount > rawText.length * 0.25;
  const effectiveTargetLang: TargetLanguage =
    isMostlyChinese && (targetLang === 'zh-CN' || targetLang === 'zh-TW') ? 'en' : targetLang;

  const block = {
    id: `tk-hover-${Date.now()}`,
    element: el,
    originalText: rawText,
    tagName: el.tagName
  };

  // 加上柔和的蓝色脉冲边框提示用户已命中该段落
  const prevOutline = el.style.outline;
  const prevTransition = el.style.transition;
  el.style.transition = 'outline 0.2s ease';
  el.style.outline = '2px solid rgba(59, 130, 246, 0.65)';
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.transition = prevTransition;
  }, 650);

  injectLoadingState(block, mode);

  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'TRANSLATE_BATCH',
          texts: [rawText],
          toLang: effectiveTargetLang
        },
        (res: TranslateBatchResponse) => {
          if (chrome.runtime.lastError || !res || !Array.isArray(res.translations)) {
            removeTranslation(el);
            return;
          }
          const trans = res.translations[0];
          if (trans && trans.trim() && trans.trim() !== rawText.trim()) {
            injectTranslation(block, trans, mode);
            el.setAttribute('data-tk-hover-translated', 'true');
          } else {
            removeTranslation(el);
          }
        }
      );
      return true;
    } catch (_) {
      removeTranslation(el);
    }
  }
  return false;
}

/**
 * 初始化「按住 Ctrl 鼠标悬停单段即时翻译」监听器
 * 同时支持两种直觉操作：
 * 1. 鼠标停在任意段落上，单按一下 Ctrl 键 -> 翻译该段（再按一下 Ctrl 键 -> 还原原文）
 * 2. 按住 Ctrl 键不放，移动鼠标划过某一段落 -> 自动翻译所指段落
 */
export function initCtrlHoverParagraphTranslate(getTargetLang: () => TargetLanguage): void {
  if (typeof document === 'undefined' || hoverListenersInitialized) return;
  hoverListenersInitialized = true;

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['enableHoverTranslate'], (res) => {
      if (typeof res?.enableHoverTranslate === 'boolean') {
        ctrlHoverEnabled = res.enableHoverTranslate;
      }
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.enableHoverTranslate) {
        ctrlHoverEnabled = changes.enableHoverTranslate.newValue !== false;
      }
    });
  }

  // 使用捕获阶段 (true) 监听鼠标位置，绝不被网页内部 stopPropagation 吞掉
  document.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      lastHoveredElement = e.target as HTMLElement | null;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;

      // 模式 2：按住 Ctrl 移动鼠标悬停到段落上直接触发
      if (ctrlHoverEnabled && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const para = findHoverParagraphElement(lastHoveredElement);
        if (para && para !== lastCtrlMovedBlock) {
          lastCtrlMovedBlock = para;
          toggleSingleParagraphTranslation(para, getTargetLang(), 'bilingual');
        }
      } else if (!e.ctrlKey) {
        lastCtrlMovedBlock = null;
      }
    },
    true
  );

  let ctrlPressedAlone = false;
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (!ctrlHoverEnabled) return;
      if (e.key === 'Control' && !e.shiftKey && !e.altKey && !e.metaKey) {
        ctrlPressedAlone = true;
      } else {
        ctrlPressedAlone = false;
      }
    },
    true
  );

  document.addEventListener(
    'keyup',
    (e: KeyboardEvent) => {
      if (!ctrlHoverEnabled) return;
      if (e.key === 'Control' && ctrlPressedAlone) {
        ctrlPressedAlone = false;
        // 如果刚才已经通过「按住 Ctrl 移动鼠标」触发过了当前块，松开 Ctrl 时不再重复冲抵还原
        if (lastCtrlMovedBlock) {
          lastCtrlMovedBlock = null;
          return;
        }
        let targetEl = lastHoveredElement;
        if (
          (!targetEl || !targetEl.isConnected) &&
          lastMouseX >= 0 &&
          lastMouseY >= 0 &&
          typeof document.elementFromPoint === 'function'
        ) {
          targetEl = document.elementFromPoint(lastMouseX, lastMouseY) as HTMLElement | null;
        }
        const para = findHoverParagraphElement(targetEl);
        if (para) {
          toggleSingleParagraphTranslation(para, getTargetLang(), 'bilingual');
        }
      }
    },
    true
  );
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
