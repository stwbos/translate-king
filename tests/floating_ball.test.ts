import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  setupFloatingBall,
  refreshFloatingBallVisual,
  removeFloatingBall,
  applyWebTranslationTheme,
  FloatingBallCallbacks
} from '../src/content/floating-ball';

describe('Floating Ball & Quick Settings Control Panel Suite', () => {
  let dom: JSDOM;
  let mockState: {
    isTranslated: boolean;
    mode: 'bilingual' | 'replace';
    theme: 'default' | 'clean' | 'underline' | 'mask';
    isAutoSite: boolean;
    enabled: boolean;
  };
  let callbacks: FloatingBallCallbacks;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="content">Hello World</div></body></html>', {
      url: 'https://developer.mozilla.org/en-US/docs/Web'
    });
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;
    (global as any).HTMLElement = dom.window.HTMLElement;
    (global as any).MouseEvent = dom.window.MouseEvent;
    (global as any).KeyboardEvent = dom.window.KeyboardEvent;
    (global as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        getURL: (path: string) => `chrome-extension://test-ext-id/${path}`,
        openOptionsPage: vi.fn()
      }
    };

    mockState = {
      isTranslated: false,
      mode: 'bilingual',
      theme: 'default',
      isAutoSite: false,
      enabled: true
    };

    callbacks = {
      onToggleTranslate: vi.fn(() => {
        mockState.isTranslated = !mockState.isTranslated;
      }),
      onChangeMode: vi.fn((m) => {
        mockState.mode = m;
      }),
      onChangeTheme: vi.fn((t) => {
        mockState.theme = t as any;
      }),
      onToggleAutoSite: vi.fn((_host, en) => {
        mockState.isAutoSite = en;
      }),
      getState: () => mockState
    };
  });

  afterEach(() => {
    removeFloatingBall();
  });

  it('成功挂载悬浮球，并包含翻译王官方统一 Logo UI', () => {
    setupFloatingBall(callbacks);

    const host = dom.window.document.getElementById('translate-king-floating-ball');
    expect(host).not.toBeNull();
    expect(host?.getAttribute('translate')).toBe('no');
    expect(host?.getAttribute('data-tk-ignore')).toBe('true');

    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();

    const pill = shadow?.querySelector('.tk-ball-pill');
    expect(pill).not.toBeNull();

    // 验证包含官方 Logo 容器
    const logoWrap = shadow?.querySelector('.translate-king-logo-wrap');
    expect(logoWrap).not.toBeNull();

    // 验证包含 SVG 矢量图形或矢量回退
    const svg = logoWrap?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 48 48');
  });

  it('点击悬浮球直接展开设置面板（而不是默认暴力触发翻译），再次点击收起', () => {
    setupFloatingBall(callbacks);

    const shadow = dom.window.document.getElementById('translate-king-floating-ball')!.shadowRoot!;
    const dockRoot = shadow.querySelector('.tk-dock-root') as HTMLElement;
    const pill = shadow.querySelector('.tk-ball-pill') as HTMLElement;
    const popover = shadow.querySelector('.tk-popover-card') as HTMLElement;

    expect(dockRoot.classList.contains('is-open')).toBe(false);

    // 第一次点击：展开设置面板
    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(dockRoot.classList.contains('is-open')).toBe(true);
    expect(callbacks.onToggleTranslate).not.toHaveBeenCalled();

    // 验证面板顶部 Header
    const brandTitle = popover.querySelector('.tk-brand-title');
    expect(brandTitle?.textContent).toBe('翻译王设置');

    // 第二次点击：收起设置面板
    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(dockRoot.classList.contains('is-open')).toBe(false);
  });

  it('点击设置面板内部的主开关可触发网页翻译切换，且面板与悬浮球同步更新高亮状态', () => {
    setupFloatingBall(callbacks);

    const shadow = dom.window.document.getElementById('translate-king-floating-ball')!.shadowRoot!;
    const pill = shadow.querySelector('.tk-ball-pill') as HTMLElement;
    const popover = shadow.querySelector('.tk-popover-card') as HTMLElement;

    // 点击打开面板
    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    // 找到面板内部的主开关
    const toggleSwitch = popover.querySelector('.tk-switch') as HTMLButtonElement;
    expect(toggleSwitch).not.toBeNull();
    expect(toggleSwitch.classList.contains('is-on')).toBe(false);

    // 点击主开关
    toggleSwitch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(callbacks.onToggleTranslate).toHaveBeenCalledTimes(1);
    expect(mockState.isTranslated).toBe(true);

    // 刷新视觉状态
    refreshFloatingBallVisual();
    expect(pill.classList.contains('is-active')).toBe(true);
  });

  it('设置面板支持切换显示模式 (双语对照 / 仅看译文) 与主题样式', () => {
    setupFloatingBall(callbacks);

    const shadow = dom.window.document.getElementById('translate-king-floating-ball')!.shadowRoot!;
    const pill = shadow.querySelector('.tk-ball-pill') as HTMLElement;
    const popover = shadow.querySelector('.tk-popover-card') as HTMLElement;

    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    // 切换到仅看译文
    const segButtons = popover.querySelectorAll('.tk-seg-btn');
    expect(segButtons.length).toBe(2);
    (segButtons[1] as HTMLButtonElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(callbacks.onChangeMode).toHaveBeenCalledWith('replace');

    // 切换双语主题样式 (例如模糊遮罩)
    const themeButtons = popover.querySelectorAll('.tk-theme-btn');
    expect(themeButtons.length).toBe(4);
    // 最后一个是模糊遮罩
    (themeButtons[3] as HTMLButtonElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(callbacks.onChangeTheme).toHaveBeenCalledWith('mask');
  });

  it('设置面板支持一键设置当前站点自动翻译规则', () => {
    setupFloatingBall(callbacks);

    const shadow = dom.window.document.getElementById('translate-king-floating-ball')!.shadowRoot!;
    const pill = shadow.querySelector('.tk-ball-pill') as HTMLElement;
    const popover = shadow.querySelector('.tk-popover-card') as HTMLElement;

    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const autoBtn = popover.querySelector('.tk-auto-site-btn') as HTMLButtonElement;
    expect(autoBtn).not.toBeNull();
    expect(autoBtn.textContent).toContain('自动翻译此站');

    autoBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(callbacks.onToggleAutoSite).toHaveBeenCalledWith('developer.mozilla.org', true);
  });

  it('按 Escape 键或点击卡片关闭按钮能够快捷收起设置面板', () => {
    setupFloatingBall(callbacks);

    const shadow = dom.window.document.getElementById('translate-king-floating-ball')!.shadowRoot!;
    const dockRoot = shadow.querySelector('.tk-dock-root') as HTMLElement;
    const pill = shadow.querySelector('.tk-ball-pill') as HTMLElement;
    const popover = shadow.querySelector('.tk-popover-card') as HTMLElement;

    // 打开面板
    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(dockRoot.classList.contains('is-open')).toBe(true);

    // 点击右上角关闭按钮
    const closeBtn = popover.querySelector('.tk-card-close-btn') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(dockRoot.classList.contains('is-open')).toBe(false);

    // 再次打开并通过 Escape 键关闭
    pill.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(dockRoot.classList.contains('is-open')).toBe(true);
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dockRoot.classList.contains('is-open')).toBe(false);
  });

  it('applyWebTranslationTheme 能正确注入纯净无框、蓝色虚线与模糊遮罩样式表', () => {
    applyWebTranslationTheme('clean');
    let style = dom.window.document.getElementById('translate-king-theme-style');
    expect(style?.textContent).toContain('border-left: none');

    applyWebTranslationTheme('underline');
    expect(style?.textContent).toContain('dashed');

    applyWebTranslationTheme('mask');
    expect(style?.textContent).toContain('blur(5px)');

    applyWebTranslationTheme('default');
    expect(style?.textContent).toBe('');
  });
});
