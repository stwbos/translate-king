/**
 * 翻译王 (TranslateKing) - Shadow DOM 划词精读悬浮卡片
 * 特性：
 * 1. 原生 Shadow DOM 物理隔离，0 样式污染
 * 2. 视口越界碰撞检测 (自动向上/向左智能翻转防遮挡)
 * 3. 双轨高清发音系统：优先真人高清美音 MP3 原声流，彻底解决沙哑机械音；离线时降级自然高品质 TTS (排除 Fred 等沙哑音色)
 * 4. 一键收藏到语境生词本 (含原句语境与来源网页)
 */

import { WordLookupResult } from '../../background/dictionary';
import { SavedVocabularyItem } from '../../types';

export class SelectionFloatingCard {
  private static instance: SelectionFloatingCard;
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private currentResult: WordLookupResult | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private isSaved = false;

  private constructor() {
    this.host = document.createElement('div');
    this.host.id = 'translate-king-bubble-host';
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483647';
    this.host.style.pointerEvents = 'auto';
    this.host.style.display = 'none';

    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.renderInitialStyles();

    this.ensureHostMounted();

    // 预热浏览器 TTS 音色列表
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      if ('onvoiceschanged' in window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.getVoices();
        };
      }
    }

    // 鼠标点击网页其他区域自动隐藏浮窗
    document.addEventListener('mousedown', (e) => {
      if (this.host.style.display === 'none') return;
      const target = e.target as Node;
      if (!this.host.contains(target)) {
        this.hide();
      }
    });

    // 按 Escape 键关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  /**
   * 确保卡片宿主元素正确挂载至当前文档树（兼容 SPA 动态重建或 body 晚就绪场景）
   */
  private ensureHostMounted(): void {
    if (typeof document === 'undefined') return;
    const root = document.body || document.documentElement;
    if (root && !root.contains(this.host)) {
      root.appendChild(this.host);
    }
  }

  public static getInstance(): SelectionFloatingCard {
    if (!SelectionFloatingCard.instance) {
      SelectionFloatingCard.instance = new SelectionFloatingCard();
    }
    return SelectionFloatingCard.instance;
  }

  private renderInitialStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
        color: #0f172a;
        font-size: 13px;
        line-height: 1.5;
      }
      .card {
        width: 320px;
        max-width: 90vw;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.12), 0 8px 10px -6px rgba(0, 0, 0, 0.08);
        padding: 14px;
        box-sizing: border-box;
        animation: tk-fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: text;
      }
      @keyframes tk-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .word-title {
        font-size: 17px;
        font-weight: 700;
        color: #1e40af;
        margin-right: 6px;
      }
      .phonetic {
        font-size: 12px;
        color: #64748b;
        font-family: "Lucida Sans Unicode", "DejaVu Sans", sans-serif;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .icon-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        color: #64748b;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
      }
      .icon-btn:hover {
        background: #f1f5f9;
        color: #1e40af;
      }
      .icon-btn.saved {
        color: #f59e0b;
      }
      .meaning-box {
        margin-bottom: 10px;
        background: #f8fafc;
        border-radius: 8px;
        padding: 8px 10px;
        border-left: 3px solid #3b82f6;
      }
      .meaning-text {
        font-size: 13px;
        font-weight: 600;
        color: #1e293b;
        line-height: 1.5;
      }
      .sentence-box {
        font-size: 12px;
        border-top: 1px dashed #e2e8f0;
        padding-top: 8px;
        margin-bottom: 8px;
      }
      .sentence-source, .sentence-en {
        color: #334155;
        margin-bottom: 4px;
        font-style: italic;
      }
      .sentence-target, .sentence-zh {
        color: #64748b;
      }
      .footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 10px;
        color: #94a3b8;
        margin-top: 6px;
      }
      .tag {
        background: #dbeafe;
        color: #1e40af;
        padding: 1px 6px;
        border-radius: 4px;
        font-weight: 600;
      }
      .loading {
        text-align: center;
        padding: 20px 0;
        color: #64748b;
      }
    `;
    this.shadow.appendChild(style);
  }

  /**
   * 在鼠标选区位置显示加载中
   */
  public showLoading(range: Range, word: string): void {
    this.isSaved = false;
    this.currentResult = null;
    this.positionNearRange(range);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'card';
    contentDiv.innerHTML = `
      <div class="header">
        <span class="word-title">${word}</span>
        <button class="icon-btn close-btn">✕</button>
      </div>
      <div class="loading">正在极速查询释义与语境...</div>
    `;

    contentDiv.querySelector('.close-btn')?.addEventListener('click', () => this.hide());

    this.updateCardContent(contentDiv);
    this.host.style.display = 'block';
  }

  /**
   * 填充查词解析结果
   */
  public showResult(range: Range, result: WordLookupResult): void {
    this.currentResult = result;
    this.positionNearRange(range);

    const card = document.createElement('div');
    card.className = 'card';

    const hasSentence = result.sentence && result.sentence !== result.word;

    card.innerHTML = `
      <div class="header">
        <div>
          <span class="word-title">${result.word}</span>
          ${result.phonetic ? `<span class="phonetic">${result.phonetic}</span>` : ''}
        </div>
        <div class="actions">
          <button class="icon-btn speak-btn" title="朗读真人原声">🔊</button>
          <button class="icon-btn star-btn ${this.isSaved ? 'saved' : ''}" title="收藏到生词本">★</button>
          <button class="icon-btn close-btn" title="关闭">✕</button>
        </div>
      </div>

      <div class="meaning-box">
        <div class="meaning-text">${result.meaning}</div>
      </div>

      ${hasSentence ? `
        <div class="sentence-box">
          <div class="sentence-source">“${result.sentence}”</div>
          ${result.sentenceTranslation ? `<div class="sentence-target">${result.sentenceTranslation}</div>` : ''}
        </div>
      ` : ''}

      <div class="footer">
        <span class="tag">⚡ 极速语境词典</span>
        <span>翻译王 TranslateKing</span>
      </div>
    `;

    // 绑定发音
    card.querySelector('.speak-btn')?.addEventListener('click', () => {
      this.speakWord(result.word);
    });

    // 绑定生词收藏
    const starBtn = card.querySelector('.star-btn') as HTMLElement;
    starBtn?.addEventListener('click', () => {
      this.toggleSaveVocabulary(result, starBtn);
    });

    // 绑定关闭
    card.querySelector('.close-btn')?.addEventListener('click', () => this.hide());

    this.updateCardContent(card);
    this.host.style.display = 'block';
  }

  private updateCardContent(newContent: HTMLElement): void {
    const existingCard = this.shadow.querySelector('.card');
    if (existingCard) {
      existingCard.remove();
    }
    this.shadow.appendChild(newContent);
  }

  /**
   * 智能定位与视口碰撞检测（基于 Viewport 纯视口固定坐标体系，彻底免受 body/html scroll 坐标漂移与容器溢出裁剪影响）
   */
  private positionNearRange(range: Range): void {
    this.ensureHostMounted();

    let rect = range.getBoundingClientRect();
    // 兼容 Blink/WebKit 在复杂嵌套 Flex/Grid 或行内块元素中偶尔返回空矩形的问题
    if ((rect.width === 0 || rect.height === 0) && typeof range.getClientRects === 'function') {
      const clientRects = range.getClientRects();
      if (clientRects.length > 0) {
        rect = clientRects[0];
      }
    }

    // 若 Range 仍无法计算出尺寸，降级获取包含节点的矩形
    if (rect.width === 0 && rect.height === 0 && range.startContainer) {
      const containerEl = range.startContainer instanceof HTMLElement
        ? range.startContainer
        : range.startContainer.parentElement;
      if (containerEl && typeof containerEl.getBoundingClientRect === 'function') {
        rect = containerEl.getBoundingClientRect();
      }
    }

    const CARD_WIDTH = 320;
    const CARD_HEIGHT = 180;
    const PADDING = 12;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;

    let left = rect.left;
    let top = rect.bottom + 8;

    // 水平右侧越界反弹检测
    if (left + CARD_WIDTH > viewportWidth - PADDING) {
      left = Math.max(PADDING, viewportWidth - CARD_WIDTH - PADDING);
    }
    if (left < PADDING) {
      left = PADDING;
    }

    // 垂直下方越界向上翻转
    if (top + CARD_HEIGHT > viewportHeight - PADDING) {
      top = Math.max(PADDING, rect.top - CARD_HEIGHT - 8);
    }
    if (top < PADDING) {
      top = PADDING;
    }

    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483647';
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  }

  /**
   * 双轨发音核心：优先原生高清真人原声流，告别沙哑机械音；离线时降级自然高品质人声
   * 支持中英文自动识别与配对音色
   */
  private speakWord(text: string): void {
    const cleanWord = text.trim();
    if (!cleanWord) return;

    const isChinese = /[\u4e00-\u9fa5]/.test(cleanWord);

    // 1. 优先尝试真人原生音频流（录音棚原声，发音清晰饱满，彻底告别沙哑机械音）
    if (typeof Audio !== 'undefined') {
      try {
        if (this.currentAudio) {
          try {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
          } catch (_) {}
          this.currentAudio = null;
        }

        const audioUrl = isChinese
          ? `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(cleanWord)}&le=zh`
          : `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(cleanWord)}&type=2`;

        const audio = new Audio(audioUrl);
        this.currentAudio = audio;
        let fallbackTriggered = false;

        const triggerFallback = () => {
          if (!fallbackTriggered) {
            fallbackTriggered = true;
            this.fallbackSpeechSynthesis(cleanWord, isChinese);
          }
        };

        audio.onerror = () => triggerFallback();
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => triggerFallback());
        }
        return;
      } catch (_) {
        // 出错直接进入降级
      }
    }

    // 2. 降级使用高质量系统语音合成 (智能优选自然音色)
    this.fallbackSpeechSynthesis(cleanWord, isChinese);
  }

  /**
   * 挑选高质量自然音色，严格排除所有沙哑陈旧机械音
   */
  private pickPreferredVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
    if (!voices || voices.length === 0) return null;

    const preferredUs = [
      'Google US English', 'Samantha', 'Ava', 'Allison', 'Victoria', 'Eddy', 'Flo', 'Alex'
    ];
    const preferredOther = [
      'Daniel', 'Karen', 'Zoe', 'Tom', 'Oliver', 'Serena'
    ];

    // 1. 优先匹配美音高品质自然音色
    const usMatch = voices.find((v) =>
      v && v.lang && v.lang.startsWith('en') && preferredUs.some((p) => v.name && v.name.includes(p))
    );
    if (usMatch) return usMatch;

    // 2. 匹配英音/澳音高品质自然音色
    const otherMatch = voices.find((v) =>
      v && v.lang && v.lang.startsWith('en') && preferredOther.some((p) => v.name && v.name.includes(p))
    );
    if (otherMatch) return otherMatch;

    // 3. 严格排除所有已知机械沙哑音色 (Fred, Zarvox, Whisper, Albert 等)
    const roboticRegex = /fred|zarvox|whisper|cellos|bad\s*news|albert|boing|bells|bahh|bubbles|good\s*news|jester|junior|organ|ralph|trinoids|wobble/i;
    const naturalUs = voices.find((v) =>
      v && v.lang && (v.lang === 'en-US' || v.lang === 'en_US') && !roboticRegex.test(v.name || '')
    );
    if (naturalUs) return naturalUs;

    const naturalEn = voices.find((v) =>
      v && v.lang && v.lang.startsWith('en') && !roboticRegex.test(v.name || '')
    );
    if (naturalEn) return naturalEn;

    return voices.find((v) => !roboticRegex.test(v.name || '')) || null;
  }

  /**
   * 系统语音合成兜底方案，确保自然人声
   */
  private fallbackSpeechSynthesis(text: string, isChinese = false): void {
    if (!text || typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1.0;

      const voices = window.speechSynthesis.getVoices() || [];
      if (isChinese) {
        utterance.lang = 'zh-CN';
        const zhVoice = voices.find((v) =>
          v && v.lang && (v.lang.startsWith('zh') || v.lang === 'cmn-Hans-CN')
        );
        if (zhVoice) utterance.voice = zhVoice;
      } else {
        utterance.lang = 'en-US';
        if (voices.length > 0) {
          const selected = this.pickPreferredVoice(voices);
          if (selected) {
            utterance.voice = selected;
          }
        }
      }

      window.speechSynthesis.speak(utterance);
    } catch (_) {}
  }

  /**
   * 收藏到生词本
   */
  private toggleSaveVocabulary(result: WordLookupResult, btn: HTMLElement): void {
    const item: SavedVocabularyItem = {
      id: `vocab-${Date.now()}`,
      word: result.word,
      phonetic: result.phonetic,
      meaning: result.meaning,
      sentence: result.sentence,
      sentenceTranslation: result.sentenceTranslation,
      url: window.location.href,
      title: document.title,
      timestamp: Date.now()
    };

    chrome.runtime.sendMessage({ type: 'SAVE_VOCABULARY', item }, () => {
      this.isSaved = true;
      btn.classList.add('saved');
      btn.textContent = '★ 已收藏';
    });
  }

  public hide(): void {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch (_) {}
      this.currentAudio = null;
    }
    this.host.style.display = 'none';
  }
}
