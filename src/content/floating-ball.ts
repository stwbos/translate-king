/**
 * 翻译王 (TranslateKing) - 官方统一品牌 Shadow DOM 悬浮球与快捷设置面板
 *
 * 核心升级规范：
 * 1. 品牌视觉统一：全面升级为翻译王官方品牌 Logo（皇家蓝渐变背景 + 金黄色皇冠 + 白气泡 A文）
 * 2. 交互逻辑重构：
 *    - 点击悬浮球直接展开/收起快捷设置面板（不再默认暴力触发整页翻译），完美支持自动翻译用户免干扰配置
 *    - 移除鼠标划过侧边误触弹窗，采用纯净点击触发 + 点击空白区域/按 Esc 自动关闭
 *    - 面板内集成：网页双语翻译主开关 (Alt+T)、显示模式 (双语对照/仅看译文)、双语样式主题、域名自动翻译白名单、完整选项入口
 * 3. Shadow DOM 100% 物理隔离 + 严格遵守 TrustedTypes CSP 规范（零 innerHTML，纯 DOM API）
 */

import { TranslationMode } from '../types';
import { createTranslateKingLogoElement } from './logo';

export type WebTranslationTheme = 'default' | 'clean' | 'underline' | 'mask' | 'quote';

export interface FloatingBallCallbacks {
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
let cleanupGlobalListeners: (() => void) | null = null;

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
    // 纯净无框：去掉左边框和底色，字体颜色继承原文，极简纯净
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
    // 蓝色虚线：精致底部蓝色虚线下划线
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
    // default ('default' | 'quote')：经典皇家蓝引用边栏卡片
    styleEl.textContent = '';
  }
}

/**
 * 构建 Shadow DOM 内部独立样式表（高保真深色玻璃拟态 + 翻译王品牌蓝体系）
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
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    .tk-ball-pill {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      width: 44px;
      height: 42px;
      padding-left: 6px;
      box-sizing: border-box;
      border-radius: 999px 0 0 999px;
      background: rgba(15, 23, 42, 0.90);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(59, 130, 246, 0.32);
      border-right: none;
      box-shadow: -4px 6px 20px rgba(15, 23, 42, 0.35);
      cursor: pointer;
      transform: translateX(8px);
      transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), background 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
    }
    .tk-dock-root:hover .tk-ball-pill,
    .tk-dock-root.is-open .tk-ball-pill {
      transform: translateX(0);
      background: rgba(15, 23, 42, 0.98);
      border-color: rgba(59, 130, 246, 0.65);
      box-shadow: -6px 8px 24px rgba(37, 99, 235, 0.4);
    }
    .tk-ball-pill.is-active {
      border-color: rgba(59, 130, 246, 0.75);
    }
    .tk-ball-orb {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      transition: transform 0.2s ease, filter 0.2s ease;
    }
    .tk-ball-pill:hover .tk-ball-orb {
      transform: scale(1.06);
    }
    .tk-ball-pill.is-active .tk-ball-orb {
      filter: drop-shadow(0 0 8px rgba(37, 99, 235, 0.7));
    }
    .tk-status-dot {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10B981;
      border: 1.5px solid #0F172A;
      box-shadow: 0 0 6px rgba(16, 185, 129, 0.9);
      display: none;
    }
    .tk-ball-pill.is-active .tk-status-dot {
      display: block;
    }
    .tk-close-mini {
      position: absolute;
      top: -5px;
      left: -4px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #334155;
      color: #CBD5E1;
      border: 1px solid rgba(255,255,255,0.2);
      font-size: 11px;
      line-height: 1;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: all 0.15s ease;
    }
    .tk-dock-root:hover .tk-close-mini {
      display: flex;
    }
    .tk-close-mini:hover {
      background: #EF4444;
      color: #FFFFFF;
      transform: scale(1.1);
    }
    .tk-popover-card {
      display: none;
      flex-direction: column;
      gap: 12px;
      width: 252px;
      margin-right: 10px;
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.96);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(59, 130, 246, 0.32);
      box-shadow: 0 20px 48px -10px rgba(0, 0, 0, 0.7), 0 0 1px 1px rgba(59, 130, 246, 0.2);
      color: #F8FAFC;
      font-size: 12px;
      animation: tk-card-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes tk-card-fade-in {
      from {
        opacity: 0;
        transform: translateX(10px) scale(0.96);
      }
      to {
        opacity: 1;
        transform: translateX(0) scale(1);
      }
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
      gap: 7px;
    }
    .tk-brand-title {
      font-size: 13px;
      font-weight: 700;
      color: #F8FAFC;
      letter-spacing: -0.01em;
    }
    .tk-status-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.18);
      color: #94A3B8;
    }
    .tk-status-badge.is-active {
      background: rgba(16, 185, 129, 0.2);
      color: #34D399;
    }
    .tk-card-close-btn {
      background: transparent;
      border: none;
      color: #94A3B8;
      font-size: 13px;
      cursor: pointer;
      padding: 2px 5px;
      line-height: 1;
      border-radius: 4px;
      transition: color 0.15s ease, background 0.15s ease;
    }
    .tk-card-close-btn:hover {
      color: #FFFFFF;
      background: rgba(255, 255, 255, 0.12);
    }
    .tk-setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 9px;
      background: rgba(30, 41, 59, 0.55);
      border-radius: 9px;
      border: 1px solid rgba(148, 163, 184, 0.12);
    }
    .tk-toggle-info {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tk-toggle-title {
      font-size: 12px;
      font-weight: 600;
      color: #F1F5F9;
    }
    .tk-kbd {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(59, 130, 246, 0.18);
      color: #93C5FD;
      font-weight: 600;
    }
    .tk-switch {
      position: relative;
      width: 38px;
      height: 22px;
      border-radius: 999px;
      background: #334155;
      cursor: pointer;
      transition: background 0.2s ease, box-shadow 0.2s ease;
      border: none;
      padding: 0;
      flex-shrink: 0;
    }
    .tk-switch.is-on {
      background: #2563EB;
      box-shadow: 0 0 8px rgba(37, 99, 235, 0.5);
    }
    .tk-switch-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #FFFFFF;
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .tk-switch.is-on .tk-switch-knob {
      transform: translateX(16px);
    }
    .tk-section-label {
      font-size: 11px;
      color: #94A3B8;
      font-weight: 600;
      margin-bottom: 5px;
    }
    .tk-segmented {
      display: flex;
      background: rgba(30, 41, 59, 0.85);
      border-radius: 8px;
      padding: 3px;
      gap: 3px;
      border: 1px solid rgba(148, 163, 184, 0.1);
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
    .tk-seg-btn:hover {
      color: #FFFFFF;
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
      padding: 6px 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .tk-theme-btn:hover {
      border-color: rgba(59, 130, 246, 0.4);
      color: #FFFFFF;
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
    .tk-auto-site-btn:hover {
      border-color: rgba(16, 185, 129, 0.4);
    }
    .tk-auto-site-btn.is-active {
      border-color: rgba(16, 185, 129, 0.5);
      background: rgba(6, 78, 59, 0.35);
      color: #6EE7B7;
    }
    .tk-card-footer {
      padding-top: 6px;
      border-top: 1px solid rgba(148, 163, 184, 0.12);
      display: flex;
      justify-content: center;
    }
    .tk-more-settings-btn {
      background: transparent;
      border: none;
      color: #94A3B8;
      font-size: 11px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: color 0.15s ease;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .tk-more-settings-btn:hover {
      color: #3B82F6;
      text-decoration: underline;
    }
  `;
}

/**
 * 挂载并初始化页面侧边 Shadow DOM 快捷悬浮球与快捷设置面板
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
  popover.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const ballPill = document.createElement('div');
  ballPill.className = 'tk-ball-pill';
  ballPill.setAttribute('title', '翻译王快捷设置 (Alt+T 开关翻译) · 可上下拖动位置');

  const orb = document.createElement('div');
  orb.className = 'tk-ball-orb';
  // 注入官方品牌 Logo 图标 (24px 高清/矢量)
  const logo = createTranslateKingLogoElement(24, 'floating-ball');
  orb.appendChild(logo);

  const statusDot = document.createElement('span');
  statusDot.className = 'tk-status-dot';
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

  // 1. 拖拽逻辑：支持上下平滑调节高度
  let isDragging = false;
  let hasMoved = false;
  let startY = 0;
  let startTop = 0;

  ballPill.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    startY = e.clientY;
    startTop = dockRoot.getBoundingClientRect?.().top || 0;
    e.preventDefault();
  });

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 8) {
      hasMoved = true;
      const nextTop = Math.max(64, Math.min(window.innerHeight - 80, startTop + dy));
      dockRoot.style.top = `${nextTop}px`;
    }
  };

  const onMouseUp = () => {
    if (isDragging) {
      setTimeout(() => {
        isDragging = false;
      }, 50);
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // 2. 点击悬浮球：直接展开/收起设置面板
  ballPill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hasMoved) {
      hasMoved = false;
      return;
    }
    const willOpen = !dockRoot.classList.contains('is-open');
    if (willOpen) {
      rebuildPopoverContents(popover);
      dockRoot.classList.add('is-open');
    } else {
      dockRoot.classList.remove('is-open');
    }
  });

  // 3. 点击外部空白区域自动收起设置面板
  const onOutsideClick = (e: MouseEvent) => {
    if (!dockRoot.classList.contains('is-open')) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (!path.includes(dockRoot) && !path.includes(host)) {
      dockRoot.classList.remove('is-open');
    }
  };
  window.addEventListener('click', onOutsideClick, true);

  // 4. 按 Escape 键快速关闭面板
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dockRoot.classList.contains('is-open')) {
      dockRoot.classList.remove('is-open');
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  cleanupGlobalListeners = () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('click', onOutsideClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
  };

  dockRoot.appendChild(popover);
  dockRoot.appendChild(ballPill);
  shadow.appendChild(dockRoot);

  (document.body || document.documentElement).appendChild(host);
  refreshFloatingBallVisual();
}

/**
 * 动态渲染快捷设置面板内部组件
 */
function rebuildPopoverContents(popover: HTMLElement): void {
  if (!currentCallbacks) return;
  while (popover.firstChild) {
    popover.removeChild(popover.firstChild);
  }

  const st = currentCallbacks.getState();
  const normalizedTheme = st.theme === 'quote' ? 'default' : st.theme;

  // 1. 顶部 Header：Logo + "翻译王设置" + 状态徽标 + 关闭按钮
  const header = document.createElement('div');
  header.className = 'tk-card-header';

  const brandGroup = document.createElement('div');
  brandGroup.className = 'tk-brand-group';

  const headerLogo = createTranslateKingLogoElement(20, 'card-header');
  const title = document.createElement('span');
  title.className = 'tk-brand-title';
  title.textContent = '翻译王设置';

  const statusBadge = document.createElement('span');
  statusBadge.className = `tk-status-badge ${st.isTranslated ? 'is-active' : ''}`;
  statusBadge.textContent = st.isTranslated ? '双语已开启' : '未开启';

  brandGroup.appendChild(headerLogo);
  brandGroup.appendChild(title);
  brandGroup.appendChild(statusBadge);

  const cardCloseBtn = document.createElement('button');
  cardCloseBtn.className = 'tk-card-close-btn';
  cardCloseBtn.setAttribute('title', '关闭设置 (Esc)');
  cardCloseBtn.textContent = '✕';
  cardCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const dock = popover.closest('.tk-dock-root');
    if (dock) dock.classList.remove('is-open');
  });

  header.appendChild(brandGroup);
  header.appendChild(cardCloseBtn);
  popover.appendChild(header);

  // 2. 网页翻译主开关 (开关行)
  const toggleRow = document.createElement('div');
  toggleRow.className = 'tk-setting-row';

  const toggleInfo = document.createElement('div');
  toggleInfo.className = 'tk-toggle-info';

  const toggleTitle = document.createElement('span');
  toggleTitle.className = 'tk-toggle-title';
  toggleTitle.textContent = '网页双语翻译';

  const kbd = document.createElement('span');
  kbd.className = 'tk-kbd';
  kbd.textContent = 'Alt+T';

  toggleInfo.appendChild(toggleTitle);
  toggleInfo.appendChild(kbd);

  const toggleSwitch = document.createElement('button');
  toggleSwitch.className = `tk-switch ${st.isTranslated ? 'is-on' : ''}`;
  toggleSwitch.setAttribute('role', 'switch');
  toggleSwitch.setAttribute('aria-checked', String(st.isTranslated));
  toggleSwitch.setAttribute('title', st.isTranslated ? '点击关闭翻译' : '点击开启双语翻译');

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

  toggleRow.appendChild(toggleInfo);
  toggleRow.appendChild(toggleSwitch);
  popover.appendChild(toggleRow);

  // 3. 翻译显示模式（双语对照 / 仅看译文）
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

  // 4. 译文视觉样式 (2x2 网格：经典蓝框 / 纯净无框 / 蓝色虚线 / 模糊遮罩)
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

  // 5. 当前域名自动翻译快捷设置
  const host = window.location.hostname;
  if (host) {
    const autoBtn = document.createElement('button');
    autoBtn.className = `tk-auto-site-btn ${st.isAutoSite ? 'is-active' : ''}`;

    const leftSpan = document.createElement('span');
    leftSpan.textContent = st.isAutoSite ? `✓ 已设为自动翻译此站` : `+ 总是自动翻译此站`;

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

  // 6. 底部完整设置入口
  const footer = document.createElement('div');
  footer.className = 'tk-card-footer';

  const optionsLink = document.createElement('button');
  optionsLink.className = 'tk-more-settings-btn';
  optionsLink.textContent = '⚙️ 打开完整设置面板';
  optionsLink.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });

  footer.appendChild(optionsLink);
  popover.appendChild(footer);
}

/**
 * 刷新悬浮球与卡片的激活态和视觉效果
 */
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

  // 若设置面板正处于展开状态，同步更新内部状态与开关
  const dockRoot = shadowRootRef.querySelector('.tk-dock-root');
  if (dockRoot && dockRoot.classList.contains('is-open')) {
    const popover = shadowRootRef.querySelector('.tk-popover-card') as HTMLElement | null;
    if (popover) {
      rebuildPopoverContents(popover);
    }
  }
}

/**
 * 移除侧边悬浮球并释放全局事件监听
 */
export function removeFloatingBall(): void {
  if (typeof document === 'undefined') return;
  if (cleanupGlobalListeners) {
    cleanupGlobalListeners();
    cleanupGlobalListeners = null;
  }
  const existing = document.getElementById('translate-king-floating-ball');
  if (existing) existing.remove();
  shadowRootRef = null;
}
