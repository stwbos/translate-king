/**
 * 翻译王 (TranslateKing) - 旗舰级 Shadow DOM 侧边悬浮球与快捷控制台
 *
 * 视觉体系规范：
 * 1. 全品牌统一「皇家蓝 / 科技蓝 (#2563EB -> #3B82F6)」主色调，与 Popup 面板及网页经典蓝框译文 100% 视觉统一
 * 2. 4 种真正差异化、互不冲突的网页双语样式：
 *    - ▏ 经典蓝框 (default)：左侧皇家蓝竖线 + 5% 淡蓝微底色卡片（翻译王标志性默认样式）
 *    - ✨ 纯净无框 (clean)：去除背景底色与左侧竖线，纯蓝字极简伴读
 *    - 〰️ 蓝色虚线 (underline)：去除背景与左竖线，底部精致蓝色虚线下划线
 *    - 👁️ 模糊遮罩 (mask)：译文默认高斯模糊，鼠标悬停时清晰浮现（背单词/精读训练）
 * 3. Shadow DOM 100% 物理隔离 + 零 .innerHTML（严守 YouTube TrustedTypes CSP）
 */

import { TranslationMode } from '../types';

export type WebTranslationTheme = 'default' | 'clean' | 'underline' | 'mask' | 'quote';

interface FloatingBallCallbacks {
  onToggleTranslate: () => void;
  onChangeMode: (mode: TranslationMode) => void;
  onChangeTheme: (theme: WebTranslationTheme) => void;
  onToggleAutoSite: (hostname: string, enabled: boolean) => void;
  getState: () => {
    isTranslated: boolean;
    mode: TranslationMode;
    theme: WebTranslationTheme;
    isAutoSite: boolean;
    enabled: boolean;
  };
}

let currentCallbacks: FloatingBallCallbacks | null = null;
let shadowRootRef: ShadowRoot | null = null;

/**
 * 应用网页译文主题样式（经典蓝框 / 纯净无框 / 蓝色虚线 / 模糊学习遮罩）
 */
export function applyWebTranslationTheme(theme: WebTranslationTheme): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById('translate-king-theme-style') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'translate-king-theme-style';
    (document.head || document.documentElement).appendChild(styleEl);
  }

  if (theme === 'clean') {
    // 纯净无框：去掉左边框和底色，且字体、字号、颜色 100% 继承原文，呈现原生级无感伴读体验
    styleEl.textContent = `
      .translate-king-wrapper.translate-king-done .translate-king-text {
        background: transparent !important;
        border-left: none !important;
        padding: 1px 0 !important;
        border-radius: 0 !important;
        color: inherit !important;
        font-size: inherit !important;
        font-family: inherit !important;
        font-weight: inherit !important;
        opacity: 0.92 !important;
      }
    `;
  } else if (theme === 'underline') {
    // 蓝色虚线：去掉左边框与底色，改为底部皇家蓝虚线下划线
    styleEl.textContent = `
      .translate-king-wrapper.translate-king-done .translate-king-text {
        background: transparent !important;
        border-left: none !important;
        padding: 1px 0 2px 0 !important;
        border-radius: 0 !important;
        border-bottom: 1.5px dashed rgba(59, 130, 246, 0.7) !important;
      }
    `;
  } else if (theme === 'mask') {
    // 模糊学习遮罩：平时高斯模糊，鼠标悬停清晰显现
    styleEl.textContent = `
      .translate-king-wrapper.translate-king-done .translate-king-text {
        filter: blur(5px) !important;
        transition: filter 0.2s ease !important;
        cursor: pointer !important;
      }
      .translate-king-wrapper.translate-king-done:hover .translate-king-text {
        filter: blur(0px) !important;
      }
    `;
  } else {
    // default ('default' | 'quote')：使用 content.css 原生自带的「经典皇家蓝引用边栏卡片」
    styleEl.textContent = '';
  }
}

/**
 * 纯 DOM API 构建双语翻译 SVG 矢量图标
 */
function createTranslateSvg(size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute(
    'd',
    'M12.87 15.07l-2.54-2.51.03-.08c1.74-1.94 2.98-4.17 3.71-6.49H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z'
  );
  svg.appendChild(path);
  return svg;
}

/**
 * 构建 Shadow DOM 内部独立样式表（统一皇家蓝 #2563EB 品牌视觉语言）
 */
function getShadowCss(): string {
  return `
    :host {
      all: initial;
    }
    .tk-dock-root {
      position: fixed;
      right: 0;
      top: 64%;
      z-index: 2147483640;
      display: flex;
      align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .tk-ball-pill {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      width: 44px;
      height: 40px;
      padding-left: 5px;
      box-sizing: border-box;
      border-radius: 999px 0 0 999px;
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(59, 130, 246, 0.28);
      border-right: none;
      box-shadow: -4px 6px 20px rgba(15, 23, 42, 0.28);
      cursor: pointer;
      transform: translateX(8px);
      transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s ease, box-shadow 0.2s ease;
    }
    .tk-dock-root:hover .tk-ball-pill {
      transform: translateX(0);
      background: rgba(15, 23, 42, 0.96);
      border-color: rgba(59, 130, 246, 0.5);
      box-shadow: -6px 8px 24px rgba(37, 99, 235, 0.32);
    }
    .tk-ball-orb {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #334155 0%, #1E293B 100%);
      color: #E2E8F0;
      box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.18);
      transition: all 0.22s ease;
      position: relative;
    }
    .tk-ball-pill.is-active .tk-ball-orb {
      background: linear-gradient(135deg, #2563EB 0%, #3B82F6 100%);
      color: #FFFFFF;
      box-shadow: 0 2px 10px rgba(37, 99, 235, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.35);
    }
    .tk-status-dot {
      position: absolute;
      left: -2px;
      bottom: -2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #10B981;
      border: 2px solid #0F172A;
      color: #FFFFFF;
      font-size: 9px;
      font-weight: 800;
      display: none;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .tk-ball-pill.is-active .tk-status-dot {
      display: flex;
    }
    .tk-close-mini {
      position: absolute;
      top: -6px;
      left: -4px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #334155;
      color: #CBD5E1;
      border: 1px solid rgba(255,255,255,0.2);
      font-size: 10px;
      line-height: 1;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .tk-ball-pill:hover .tk-close-mini {
      display: flex;
    }
    .tk-close-mini:hover {
      background: #EF4444;
      color: #FFFFFF;
    }
    .tk-popover-card {
      display: none;
      flex-direction: column;
      gap: 10px;
      width: 240px;
      margin-right: 10px;
      padding: 14px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(59, 130, 246, 0.28);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.65);
      color: #F8FAFC;
      font-size: 12px;
    }
    .tk-dock-root.is-open .tk-popover-card {
      display: flex;
    }
    .tk-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 9px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.16);
    }
    .tk-brand-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tk-brand-title {
      font-size: 13px;
      font-weight: 700;
      color: #F8FAFC;
    }
    .tk-kbd {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(59, 130, 246, 0.18);
      color: #93C5FD;
      font-weight: 600;
    }
    .tk-switch {
      position: relative;
      width: 36px;
      height: 20px;
      border-radius: 999px;
      background: #334155;
      cursor: pointer;
      transition: background 0.2s ease;
      border: none;
      padding: 0;
    }
    .tk-switch.is-on {
      background: #2563EB;
    }
    .tk-switch-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #FFFFFF;
      transition: transform 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .tk-switch.is-on .tk-switch-knob {
      transform: translateX(16px);
    }
    .tk-section-label {
      font-size: 11px;
      color: #94A3B8;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .tk-segmented {
      display: flex;
      background: rgba(30, 41, 59, 0.85);
      border-radius: 8px;
      padding: 3px;
      gap: 3px;
    }
    .tk-seg-btn {
      flex: 1;
      border: none;
      padding: 5px 6px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      background: transparent;
      color: #CBD5E1;
      transition: all 0.15s ease;
    }
    .tk-seg-btn.is-active {
      background: #2563EB;
      color: #FFFFFF;
      box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
    }
    .tk-theme-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px;
    }
    .tk-theme-btn {
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(30, 41, 59, 0.65);
      color: #CBD5E1;
      border-radius: 7px;
      padding: 5px 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .tk-theme-btn.is-active {
      border-color: #3B82F6;
      background: rgba(37, 99, 235, 0.22);
      color: #93C5FD;
      font-weight: 700;
    }
    .tk-auto-site-btn {
      width: 100%;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(30, 41, 59, 0.65);
      color: #E2E8F0;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: all 0.15s ease;
    }
    .tk-auto-site-btn.is-active {
      border-color: rgba(16, 185, 129, 0.5);
      background: rgba(6, 78, 59, 0.35);
      color: #6EE7B7;
    }
  `;
}

/**
 * 挂载并初始化页面侧边 Shadow DOM 快捷悬浮球
 */
export function setupFloatingBall(callbacks: FloatingBallCallbacks): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  currentCallbacks = callbacks;

  const state = callbacks.getState();
  if (!state.enabled) {
    removeFloatingBall();
    return;
  }

  if (document.getElementById('translate-king-floating-ball')) {
    refreshFloatingBallVisual();
    return;
  }

  const host = document.createElement('div');
  host.id = 'translate-king-floating-ball';
  host.setAttribute('translate', 'no');
  host.setAttribute('data-tk-ignore', 'true');

  const shadow = host.attachShadow({ mode: 'open' });
  shadowRootRef = shadow;

  const styleEl = document.createElement('style');
  styleEl.textContent = getShadowCss();
  shadow.appendChild(styleEl);

  const dockRoot = document.createElement('div');
  dockRoot.className = 'tk-dock-root';

  const popover = document.createElement('div');
  popover.className = 'tk-popover-card';

  const ballPill = document.createElement('div');
  ballPill.className = 'tk-ball-pill';
  ballPill.setAttribute('title', '左键切换网页双语翻译 (Alt+T) · 按住可上下拖动位置');

  const orb = document.createElement('div');
  orb.className = 'tk-ball-orb';
  orb.appendChild(createTranslateSvg(17));

  const statusDot = document.createElement('span');
  statusDot.className = 'tk-status-dot';
  statusDot.textContent = '✓';
  orb.appendChild(statusDot);

  const closeMini = document.createElement('button');
  closeMini.className = 'tk-close-mini';
  closeMini.setAttribute('title', '本次浏览隐藏悬浮球');
  closeMini.textContent = '×';
  closeMini.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFloatingBall();
  });

  ballPill.appendChild(orb);
  ballPill.appendChild(closeMini);

  // 支持上下平滑拖拽调节悬浮球高度
  let isDragging = false;
  let hasMoved = false;
  let startY = 0;
  let startTop = 0;

  ballPill.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    startY = e.clientY;
    startTop = dockRoot.getBoundingClientRect().top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) {
      hasMoved = true;
      const nextTop = Math.max(64, Math.min(window.innerHeight - 80, startTop + dy));
      dockRoot.style.top = `${nextTop}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  ballPill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hasMoved) return;
    callbacks.onToggleTranslate();
    setTimeout(refreshFloatingBallVisual, 50);
  });

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  dockRoot.addEventListener('mouseenter', () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    rebuildPopoverContents(popover);
    dockRoot.classList.add('is-open');
  });

  dockRoot.addEventListener('mouseleave', () => {
    hoverTimer = setTimeout(() => {
      dockRoot.classList.remove('is-open');
    }, 160);
  });

  dockRoot.appendChild(popover);
  dockRoot.appendChild(ballPill);
  shadow.appendChild(dockRoot);

  (document.body || document.documentElement).appendChild(host);
  refreshFloatingBallVisual();
}

function rebuildPopoverContents(popover: HTMLElement): void {
  if (!currentCallbacks) return;
  while (popover.firstChild) {
    popover.removeChild(popover.firstChild);
  }

  const st = currentCallbacks.getState();
  const normalizedTheme = st.theme === 'quote' ? 'default' : st.theme;

  // 1. 顶部标题与总开关拨杆
  const header = document.createElement('div');
  header.className = 'tk-card-header';

  const brandGroup = document.createElement('div');
  brandGroup.className = 'tk-brand-group';

  const title = document.createElement('span');
  title.className = 'tk-brand-title';
  title.textContent = st.isTranslated ? '网页双语已开启' : '翻译王快捷控制';

  const kbd = document.createElement('span');
  kbd.className = 'tk-kbd';
  kbd.textContent = 'Alt+T';

  brandGroup.appendChild(title);
  brandGroup.appendChild(kbd);

  const toggleSwitch = document.createElement('button');
  toggleSwitch.className = `tk-switch ${st.isTranslated ? 'is-on' : ''}`;
  const knob = document.createElement('span');
  knob.className = 'tk-switch-knob';
  toggleSwitch.appendChild(knob);
  toggleSwitch.addEventListener('click', (e) => {
    e.stopPropagation();
    currentCallbacks?.onToggleTranslate();
    setTimeout(() => {
      refreshFloatingBallVisual();
      rebuildPopoverContents(popover);
    }, 60);
  });

  header.appendChild(brandGroup);
  header.appendChild(toggleSwitch);
  popover.appendChild(header);

  // 2. 翻译显示模式（双语对照 / 仅看译文）
  const modeWrap = document.createElement('div');
  const modeLabel = document.createElement('div');
  modeLabel.className = 'tk-section-label';
  modeLabel.textContent = '显示模式';
  const seg = document.createElement('div');
  seg.className = 'tk-segmented';

  const createSegBtn = (label: string, active: boolean, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = `tk-seg-btn ${active ? 'is-active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      rebuildPopoverContents(popover);
    });
    return btn;
  };

  seg.appendChild(
    createSegBtn('📖 双语对照', st.mode === 'bilingual', () => currentCallbacks?.onChangeMode('bilingual'))
  );
  seg.appendChild(
    createSegBtn('🇨🇳 仅看译文', st.mode === 'replace', () => currentCallbacks?.onChangeMode('replace'))
  );
  modeWrap.appendChild(modeLabel);
  modeWrap.appendChild(seg);
  popover.appendChild(modeWrap);

  // 3. 译文视觉样式 (2x2 网格：经典蓝框 / 纯净无框 / 蓝色虚线 / 模糊遮罩)
  const themeWrap = document.createElement('div');
  const themeLabel = document.createElement('div');
  themeLabel.className = 'tk-section-label';
  themeLabel.textContent = '双语样式主题';
  const grid = document.createElement('div');
  grid.className = 'tk-theme-grid';

  const themes: Array<{ label: string; value: WebTranslationTheme }> = [
    { label: '▏ 经典蓝框', value: 'default' },
    { label: '✨ 纯净无框', value: 'clean' },
    { label: '〰️ 蓝色虚线', value: 'underline' },
    { label: '👁️ 模糊遮罩', value: 'mask' }
  ];

  themes.forEach((t) => {
    const b = document.createElement('button');
    b.className = `tk-theme-btn ${normalizedTheme === t.value ? 'is-active' : ''}`;
    b.textContent = t.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      currentCallbacks?.onChangeTheme(t.value);
      rebuildPopoverContents(popover);
    });
    grid.appendChild(b);
  });

  themeWrap.appendChild(themeLabel);
  themeWrap.appendChild(grid);
  popover.appendChild(themeWrap);

  // 4. 当前域名自动翻译规则
  const host = window.location.hostname;
  if (host) {
    const autoBtn = document.createElement('button');
    autoBtn.className = `tk-auto-site-btn ${st.isAutoSite ? 'is-active' : ''}`;

    const leftSpan = document.createElement('span');
    leftSpan.textContent = st.isAutoSite ? `✓ 自动翻译此站` : `+ 自动翻译此站`;

    const domainSpan = document.createElement('span');
    domainSpan.style.cssText =
      'opacity: 0.75; font-size: 10.5px; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    domainSpan.textContent = host.replace(/^www\./, '');

    autoBtn.appendChild(leftSpan);
    autoBtn.appendChild(domainSpan);

    autoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentCallbacks?.onToggleAutoSite(host, !st.isAutoSite);
      rebuildPopoverContents(popover);
    });
    popover.appendChild(autoBtn);
  }
}

export function refreshFloatingBallVisual(): void {
  if (!currentCallbacks || !shadowRootRef) return;
  const pill = shadowRootRef.querySelector('.tk-ball-pill');
  if (!pill) return;

  const st = currentCallbacks.getState();
  if (st.isTranslated) {
    pill.classList.add('is-active');
  } else {
    pill.classList.remove('is-active');
  }
}

export function removeFloatingBall(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('translate-king-floating-ball');
  if (existing) existing.remove();
  shadowRootRef = null;
}
