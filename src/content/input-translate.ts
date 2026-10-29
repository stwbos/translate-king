/**
 * 翻译王 (TranslateKing) - 输入框连按 3 次空格翻译 & 按住 Alt 鼠标悬停单段翻译
 * (全面对标沉浸式翻译 Input Box Translation & Mouse Hover Paragraph Translation)
 *
 * 核心能力：
 * 1. 输入框连按 3 次空格 (Space × 3)：
 *    - 在任意网页 <input>、<textarea> 或 [contenteditable="true"]（如 X 发推框、YouTube 评论框、Google 搜索框）输入中文后，
 *      快速连按 3 下空格，瞬间将输入框内容翻译并替换为地道英文（若原内容为外文则互译为中文）！
 * 2. 按住 Alt 键鼠标悬停单段翻译 (Alt + Hover)：
 *    - 无需开启全页翻译，按住 Alt (Mac 下为 Option) 键将鼠标指针悬停在任意网页段落上，即刻单段双语翻译或还原！
 */

import { TargetLanguage, TranslateBatchResponse } from '../types';
import { injectTranslation, removeTranslation } from './dom/injector';

let spacePressCount = 0;
let lastSpaceTime = 0;
let isInputTranslating = false;
let lastHoveredBlock: HTMLElement | null = null;
let currentHoverTarget: HTMLElement | null = null;

/**
 * 提取输入框或富文本编辑区的纯文本
 */
function getEditableText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value || '';
  }
  if (el.isContentEditable) {
    return el.innerText || el.textContent || '';
  }
  return '';
}

/**
 * 将翻译后的文本写回输入框或富文本编辑区，并派发 input 事件通知 React/Vue 等前端框架
 */
function setEditableText(el: HTMLElement, newText: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, newText);
    } else {
      el.value = newText;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (el.isContentEditable) {
    el.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      // 优先使用 execCommand('insertText') 以兼容 Draft.js / Slate / ProseMirror (X/Twitter 发推框)
      const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, newText);
      if (!inserted) {
        el.textContent = newText;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: newText }));
      }
    }
  }
}

/**
 * 初始化「连按三下空格输入框翻译」与「按住 Alt 鼠标悬停单段翻译」
 */
export function setupInteractiveShortcuts(getTargetLang: () => TargetLanguage): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // 1. 监听连按 3 次空格触发输入框原位互译
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.code !== 'Space') {
        spacePressCount = 0;
        return;
      }

      const activeEl = document.activeElement as HTMLElement | null;
      if (!activeEl) return;

      const isEditable =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl.isContentEditable;

      if (!isEditable) {
        spacePressCount = 0;
        return;
      }

      const now = Date.now();
      if (now - lastSpaceTime < 450) {
        spacePressCount++;
      } else {
        spacePressCount = 1;
      }
      lastSpaceTime = now;

      if (spacePressCount >= 3 && !isInputTranslating) {
        spacePressCount = 0;
        const rawText = getEditableText(activeEl).trim();
        if (!rawText || rawText.length < 2) return;

        e.preventDefault();
        isInputTranslating = true;

        // 智能决定输入框互译方向：若输入含中文则译为英文 (en)，否则译为用户设定的目标语言
        const hasChinese = /[\u4e00-\u9fa5]/.test(rawText);
        const toLang: TargetLanguage = hasChinese ? 'en' : getTargetLang();

        const origBorder = activeEl.style.outline;
        activeEl.style.outline = '2px solid #F59E0B';

        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(
            {
              type: 'TRANSLATE_BATCH',
              texts: [rawText],
              toLang
            },
            (res: TranslateBatchResponse) => {
              isInputTranslating = false;
              activeEl.style.outline = origBorder;
              if (!chrome.runtime.lastError && res?.translations?.[0]) {
                setEditableText(activeEl, res.translations[0].trim());
              }
            }
          );
        } else {
          isInputTranslating = false;
          activeEl.style.outline = origBorder;
        }
      }
    },
    true
  );

  // 2. 跟踪鼠标悬停节点，支持按住 Alt 键悬停单段即时翻译
  document.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      currentHoverTarget = target;

      if (e.altKey) {
        triggerHoverParagraphTranslate(target, getTargetLang());
      } else {
        lastHoveredBlock = null;
      }
    },
    { passive: true }
  );
}

function triggerHoverParagraphTranslate(target: HTMLElement, targetLang: TargetLanguage): void {
  const blockEl = target.closest('p, li, h1, h2, h3, h4, blockquote, [data-testid="tweetText"]') as HTMLElement | null;
  if (!blockEl || blockEl === lastHoveredBlock) return;
  if (blockEl.closest('#translate-king-yt-summary-panel, #translate-king-yt-subtitle-menu')) return;

  lastHoveredBlock = blockEl;

  // 若该段已有双语译文，再按 Alt 悬停则还原
  if (blockEl.querySelector('.translate-king-wrapper')) {
    removeTranslation(blockEl);
    return;
  }

  const text = (blockEl.innerText || blockEl.textContent || '').trim();
  if (!text || text.length < 4) return;

  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_BATCH',
        texts: [text],
        toLang: targetLang
      },
      (res: TranslateBatchResponse) => {
        if (!chrome.runtime.lastError && res?.translations?.[0]) {
          injectTranslation(
            {
              id: `hover-${Date.now()}`,
              element: blockEl,
              originalText: text
            },
            res.translations[0],
            'bilingual'
          );
        }
      }
    );
  }
}
