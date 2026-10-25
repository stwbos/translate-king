import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectTranslation, removeTranslation } from '../src/content/dom/injector';
import { isElementEffectivelyTranslated } from '../src/content/dom/filter';
import { translateBatch } from '../src/background/translator';

describe('X / Twitter SPA 路由切换与侧边栏自愈专项测试 (Twitter SPA Navigation & Left Sidebar Healing)', () => {
  it('1. UI_GLOSSARY 应当秒级命中 X / Twitter 侧边栏所有核心导航选项', async () => {
    const terms = [
      'Home',
      'Explore',
      'Notifications',
      'Messages',
      'Bookmarks',
      'Communities',
      'Premium',
      'Profile',
      'More',
      'Post'
    ];
    const res = await translateBatch(terms, 'zh-CN');
    expect(res.translations[0]).toBe('主页');
    expect(res.translations[1]).toBe('探索');
    expect(res.translations[2]).toBe('通知');
    expect(res.translations[3]).toBe('私信');
    expect(res.translations[4]).toBe('书签');
    expect(res.translations[5]).toBe('社群');
    expect(res.translations[6]).toBe('Premium 会员');
    expect(res.translations[7]).toBe('个人资料');
    expect(res.translations[8]).toBe('更多');
    expect(res.translations[9]).toBe('发帖');
  });

  it('2. 在直接替换模式下，模拟 X 切到聊天 (/messages) 侧栏紧凑化后再切回探索 (/explore) 文本重挂载，扩展应自愈并重新翻译', () => {
    const html = `
      <header role="banner">
        <nav aria-label="Primary" role="navigation">
          <a href="/explore" data-testid="AppTabBar_Explore_Link" role="link" aria-label="Explore">
            <div class="nav-inner">
              <div class="icon-box"><svg></svg></div>
              <div dir="ltr" class="text-box">
                <span class="label">Explore</span>
              </div>
            </div>
          </a>
          <a href="/home" data-testid="AppTabBar_Home_Link" role="link" aria-label="Home">
            <div class="nav-inner">
              <div class="icon-box"><svg></svg></div>
              <div dir="ltr" class="text-box">
                <span class="label">Home</span>
              </div>
            </div>
          </a>
        </nav>
      </header>
    `;
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // 步骤一：初次进入探索页，提取侧边栏文本块并完成翻译替换
    const blocks1 = extractTranslatableBlocks(doc);
    expect(blocks1.length).toBe(2);
    expect(blocks1[0].originalText).toBe('Explore');
    expect(blocks1[1].originalText).toBe('Home');

    injectTranslation(blocks1[0], '探索', 'replace');
    injectTranslation(blocks1[1], '主页', 'replace');

    const exploreLink = doc.querySelector('a[href="/explore"]') as HTMLElement;
    expect(exploreLink.textContent).toContain('探索');
    expect(exploreLink.getAttribute('data-tk-replaced')).toBe('true');
    expect(exploreLink.getAttribute('aria-label')).toBe('探索');

    // 步骤二：模拟用户在 X 上点击“聊天 (/messages)”
    // Twitter 响应式/三栏布局将左侧栏紧凑化为纯图标模式（React 从 a 标签内部移除了文字 span，仅保留 SVG）
    const exploreTextBox = exploreLink.querySelector('.text-box') as HTMLElement;
    exploreTextBox.remove();

    // 验证在聊天纯 UI 模式下，textContent 为空，isElementEffectivelyTranslated 自动清理过期替换标记
    expect(exploreLink.textContent?.trim()).toBe('');
    expect(isElementEffectivelyTranslated(exploreLink)).toBe(false);
    expect(exploreLink.hasAttribute('data-tk-replaced')).toBe(false);

    // 步骤三：模拟用户在 X 上从聊天点回“探索 (/explore)”
    // Twitter React 重新向 a 标签插入全新的英文标签节点 <span>Explore</span>
    const newTextBox = doc.createElement('div');
    newTextBox.className = 'text-box';
    newTextBox.setAttribute('dir', 'ltr');
    newTextBox.innerHTML = '<span class="label">Explore</span>';
    exploreLink.querySelector('.nav-inner')?.appendChild(newTextBox);

    // 核心断言：重新挂载为纯英文后，isElementEffectivelyTranslated 准确识别未翻译状态
    expect(isElementEffectivelyTranslated(exploreLink)).toBe(false);

    // 步骤四：重新执行 DOM 提取，验证 Explore 能够被 100% 重新捕获并成功翻译为中文！
    const blocks2 = extractTranslatableBlocks(doc);
    const reExtractedExplore = blocks2.find((b) => b.element === exploreLink);
    expect(reExtractedExplore).toBeDefined();
    expect(reExtractedExplore?.originalText).toBe('Explore');

    // 注入新翻译
    injectTranslation(reExtractedExplore!, '探索', 'replace');
    expect(exploreLink.textContent).toContain('探索');
    expect(exploreLink.getAttribute('data-tk-replaced')).toBe('true');
  });

  it('3. 在双语对照模式下，模拟 React 销毁并重建侧栏文本节点后，仍能自愈提取', () => {
    const html = `
      <nav aria-label="Primary">
        <a href="/messages" role="link">
          <div dir="ltr"><span>Messages</span></div>
        </a>
      </nav>
    `;
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('Messages');

    injectTranslation(blocks[0], '私信', 'bilingual');
    const link = doc.querySelector('a[href="/messages"]') as HTMLElement;
    expect(link.querySelector('.translate-king-wrapper')).not.toBeNull();

    // 模拟 React 组件重刷，删除了扩展注入的 .translate-king-wrapper
    link.querySelector('.translate-king-wrapper')?.remove();

    // 核心断言：由于 wrapper 丢失，isElementEffectivelyTranslated 判定该节点需要重新翻译
    expect(isElementEffectivelyTranslated(link)).toBe(false);

    const reBlocks = extractTranslatableBlocks(doc);
    expect(reBlocks.length).toBe(1);
    expect(reBlocks[0].originalText).toBe('Messages');
  });
});
