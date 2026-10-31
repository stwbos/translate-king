import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectTranslation, removeTranslation } from '../src/content/dom/injector';

describe('LinkedIn Feed DOM Translation Test', () => {
  let doc: Document;

  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
    doc = dom.window.document;
    (global as any).document = doc;
    (global as any).window = dom.window;
  });

  it('1. LinkedIn 动态帖子正文 (包含 ...see more 按钮)', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="occludable-update feed-shared-update-v2 ember-view">
        <div class="feed-shared-update-v2__description-wrapper">
          <div class="feed-shared-inline-show-more-text feed-shared-update-v2__description">
            <div class="update-components-text relative">
              <span dir="ltr">
                <span class="break-words">
                  <span>I am thrilled to announce that we are launching a new AI model today. This model delivers state-of-the-art performance across reasoning benchmarks.</span>
                </span>
              </span>
              <button class="feed-shared-inline-show-more-text__see-more-less-toggle" type="button">
                <span class="feed-shared-inline-show-more-text__see-more-less-toggle-text">...see more</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    console.log('Extracted blocks for Post:', blocks.map(b => ({
      tagName: b.element.tagName,
      className: b.element.className,
      text: b.originalText
    })));

    // Does it extract the post body?
    const postBlock = blocks.find(b => b.originalText.includes('thrilled to announce'));
    expect(postBlock).toBeDefined();
    // Does it accidentally include "...see more" in the post body?
    expect(postBlock?.originalText).not.toContain('...see more');
  });

  it('1.1 LinkedIn 动态帖子正文 (无 span.break-words，直接使用 span[dir])', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="occludable-update feed-shared-update-v2 ember-view">
        <div class="feed-shared-update-v2__description-wrapper">
          <div class="feed-shared-inline-show-more-text feed-shared-update-v2__description">
            <div class="update-components-text relative">
              <span dir="ltr">
                <span>This is a direct post text without break-words class on LinkedIn feed.</span>
              </span>
              <button class="feed-shared-inline-show-more-text__see-more-less-toggle" type="button">
                <span>...see more</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    console.log('Extracted blocks for Post without break-words:', blocks.map(b => ({
      tagName: b.element.tagName,
      className: b.element.className,
      text: b.originalText
    })));

    const postBlock = blocks.find(b => b.originalText.includes('direct post text'));
    expect(postBlock).toBeDefined();
    expect(postBlock?.originalText).not.toContain('...see more');
  });

  it('2. LinkedIn 用户头衔与姓名 (包含 visually-hidden 和 aria-hidden 重复文本)', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="update-components-actor__container">
        <div class="update-components-actor__meta">
          <span class="update-components-actor__title">
            <span dir="ltr">
              <span aria-hidden="true">Satya Nadella</span>
              <span class="visually-hidden">View Satya Nadella’s profile</span>
            </span>
          </span>
          <span class="update-components-actor__description">
            <span dir="ltr">
              <span aria-hidden="true">Chairman and CEO at Microsoft</span>
              <span class="visually-hidden">Chairman and CEO at Microsoft</span>
            </span>
          </span>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    console.log('Extracted blocks for Actor:', blocks.map(b => ({
      tagName: b.element.tagName,
      className: b.element.className,
      text: b.originalText
    })));

    const descBlock = blocks.find(b => b.originalText.includes('Chairman and CEO'));
    expect(descBlock).toBeDefined();
    // Crucial: text should NOT be duplicated ("Chairman and CEO at Microsoft Chairman and CEO at Microsoft")
    expect(descBlock?.originalText).toBe('Chairman and CEO at Microsoft');
  });

  it('4. LinkedIn 带有多个段落、话题标签、链接的复杂帖子正文', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="occludable-update feed-shared-update-v2 ember-view">
        <div class="feed-shared-update-v2__description-wrapper">
          <div class="feed-shared-inline-show-more-text feed-shared-update-v2__description">
            <div class="update-components-text relative">
              <span dir="ltr">
                <span class="break-words">
                  <span>Excited to join </span>
                  <a class="ember-view" href="/company/anthropic">Anthropic</a>
                  <span> as a research scientist! Here is what we are working on:</span>
                  <br>
                  <span>1. Scalable oversight and reasoning benchmarks</span>
                  <br>
                  <span>2. Autonomous coding agents</span>
                  <br>
                  <span>Check out our research paper at </span>
                  <a class="ember-view" href="https://example.com/paper">https://example.com/paper</a>
                </span>
              </span>
              <button class="feed-shared-inline-show-more-text__see-more-less-toggle" type="button">
                <span class="feed-shared-inline-show-more-text__see-more-less-toggle-text">...see more</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const postBlock = blocks.find(b => b.originalText.includes('Excited to join'));
    expect(postBlock).toBeDefined();
    expect(postBlock?.inlineElements?.length).toBe(2);
    expect(postBlock?.originalText).toContain('<x0>Anthropic</x0>');
    expect(postBlock?.originalText).toContain('<x1>https://example.com/paper</x1>');

    // 验证注入翻译保留内联结构
    injectTranslation(
      postBlock!,
      '很高兴作为研究科学家加入 <x0>Anthropic</x0>！我们正在研发的项目：\n1. 可扩展监督与推理基准\n2. 自主编程智能体\n欢迎阅读我们的论文：<x1>https://example.com/paper</x1>',
      'bilingual'
    );

    const wrapper = postBlock!.element.querySelector('.translate-king-wrapper');
    expect(wrapper).not.toBeNull();
    const anchors = wrapper?.querySelectorAll('a');
    expect(anchors?.length).toBe(2);
    expect(anchors?.[0].getAttribute('href')).toBe('/company/anthropic');
    expect(anchors?.[1].getAttribute('href')).toBe('https://example.com/paper');
  });

  it('5. LinkedIn 评论区正文 (comments-comment-item)', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="comments-comments-list">
        <article class="comments-comment-item">
          <div class="comments-comment-item-content-body">
            <div class="feed-shared-inline-show-more-text">
              <div class="update-components-text relative">
                <span dir="ltr">
                  <span class="break-words">
                    <span>Congratulations on the huge milestone! Truly well deserved.</span>
                  </span>
                </span>
              </div>
            </div>
          </div>
        </article>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const commentBlock = blocks.find(b => b.originalText.includes('Congratulations on the huge milestone'));
    expect(commentBlock).toBeDefined();
    expect(commentBlock?.originalText).toBe('Congratulations on the huge milestone! Truly well deserved.');
  });

  it('6. LinkedIn 核心导航与交互术语应当命中 UI_GLOSSARY 极速翻译', async () => {
    const { translateBatch } = await import('../src/background/translator');
    const terms = ['My Network', 'Jobs', 'Messaging', 'For you', 'Following', 'Connect', 'Comment', 'Repost'];
    const res = await translateBatch(terms, 'zh-CN');
    expect(res.translations[0]).toBe('人脉');
    expect(res.translations[1]).toBe('职位');
    expect(res.translations[2]).toBe('消息');
    expect(res.translations[3]).toBe('为你推荐');
    expect(res.translations[4]).toBe('正在关注');
    expect(res.translations[5]).toBe('建立人脉');
    expect(res.translations[6]).toBe('评论');
    expect(res.translations[7]).toBe('转发');
  });

  it('7. LinkedIn /feed/foryou/ 推荐流卡片 (data-view-name="feed-full-update" 与 data-id)', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div data-view-name="feed-full-update" data-id="urn:li:activity:7251234567890">
        <div class="update-components-actor">
          <div class="update-components-actor__container">
            <span class="update-components-actor__title">
              <span dir="ltr">Sam Altman</span>
            </span>
            <span class="update-components-actor__description">
              <span dir="ltr">CEO at OpenAI</span>
            </span>
          </div>
        </div>
        <div class="update-components-text relative">
          <span dir="ltr">
            <span>Here is our latest update on the frontier model developments and upcoming features for developers.</span>
          </span>
          <button class="feed-shared-inline-show-more-text__see-more-less-toggle" type="button">
            <span>...see more</span>
          </button>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const authorBlock = blocks.find(b => b.originalText.includes('Sam Altman'));
    const descBlock = blocks.find(b => b.originalText.includes('CEO at OpenAI'));
    const contentBlock = blocks.find(b => b.originalText.includes('frontier model developments'));

    expect(authorBlock).toBeDefined();
    expect(descBlock).toBeDefined();
    expect(contentBlock).toBeDefined();
    expect(contentBlock?.originalText).not.toContain('...see more');
  });

  it('8. LinkedIn 极简正文结构 (无 span[dir]，直接为 update-components-text + see-more 按钮)', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-inline-show-more-text">
          <div class="update-components-text">
            Just published our new comprehensive benchmark analysis comparing reasoning models.
            <button class="feed-shared-inline-show-more-text__see-more-less-toggle" type="button">
              <span>...see more</span>
            </button>
          </div>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const contentBlock = blocks.find(b => b.originalText.includes('comprehensive benchmark analysis'));
    expect(contentBlock).toBeDefined();
    expect(contentBlock?.originalText).not.toContain('...see more');
  });

  it('9. 突破 LinkedIn 防御：当 <html translate="no"> 时，仍能穿透并成功提取翻译正文', () => {
    // 模拟 LinkedIn 线上真实 DOM：LinkedIn 在 <html> 上挂载 translate="no"，导致大部分翻译插件全站失效
    doc.documentElement.setAttribute('translate', 'no');

    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="occludable-update feed-shared-update-v2 ember-view">
        <div class="feed-shared-update-v2__description-wrapper">
          <div class="feed-shared-inline-show-more-text feed-shared-update-v2__description">
            <div class="update-components-text relative">
              <span dir="ltr">
                <span class="break-words">
                  <span>Breaking through LinkedIn anti-translation defense successfully!</span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const targetBlock = blocks.find(b => b.originalText.includes('Breaking through LinkedIn'));
    expect(targetBlock).toBeDefined();
    expect(targetBlock?.originalText).toBe('Breaking through LinkedIn anti-translation defense successfully!');

    // 恢复
    doc.documentElement.removeAttribute('translate');
  });

  it('10. 严格保护 LinkedIn 原生交互按钮与 See translation 按钮，严禁篡改其 DOM 结构', async () => {
    const { shouldIgnoreElement } = await import('../src/content/dom/filter');
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="feed-shared-update-v2">
        <div class="feed-shared-see-translation">
          <button class="feed-shared-see-translation-button artdeco-button artdeco-button--muted artdeco-button--tertiary">
            <span class="artdeco-button__text">See translation</span>
          </button>
        </div>
        <div class="feed-shared-social-actions">
          <button class="artdeco-button artdeco-button--muted feed-shared-social-action-bar__action-button">
            <svg class="artdeco-button__icon"><path d="..."></path></svg>
            <span class="artdeco-button__text">Like</span>
          </button>
          <button class="artdeco-button artdeco-button--muted feed-shared-social-action-bar__action-button">
            <span class="artdeco-button__text">Comment</span>
          </button>
        </div>
      </div>
    `;

    const seeTransBtn = app.querySelector('.feed-shared-see-translation-button')!;
    const seeTransText = seeTransBtn.querySelector('.artdeco-button__text')!;
    const likeBtn = app.querySelector('.feed-shared-social-action-bar__action-button')!;
    const likeText = likeBtn.querySelector('.artdeco-button__text')!;

    expect(shouldIgnoreElement(seeTransBtn)).toBe(true);
    expect(shouldIgnoreElement(seeTransText)).toBe(true);
    expect(shouldIgnoreElement(likeBtn)).toBe(true);
    expect(shouldIgnoreElement(likeText)).toBe(true);

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const buttonBlock = blocks.find(b => b.originalText === 'See translation' || b.originalText === 'Like');
    expect(buttonBlock).toBeUndefined();
  });

  it('11. LinkedIn 私信聊天 (Messaging) 与查看信息对话框内容提取', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <div class="msg-overlay-conversation-bubble">
        <header class="msg-overlay-bubble-header">
          <h2 class="msg-overlay-bubble-header__title">
            <a href="/in/alex-smith">Alex Smith</a>
          </h2>
        </header>
        <div class="msg-s-message-list-container">
          <ul class="msg-s-message-list">
            <li class="msg-s-event-listitem">
              <div class="msg-s-event-listitem__message-bubble">
                <p class="msg-s-event-listitem__body">
                  Hi, thanks for reaching out! Let me know if you are free for a quick call tomorrow.
                </p>
              </div>
            </li>
          </ul>
        </div>
      </div>
    `;

    const blocks = extractTranslatableBlocks(doc, 'zh-CN');
    const msgBlock = blocks.find(b => b.originalText.includes('thanks for reaching out'));
    expect(msgBlock).toBeDefined();
    expect(msgBlock?.originalText).toBe('Hi, thanks for reaching out! Let me know if you are free for a quick call tomorrow.');
  });

  it('12. LinkedIn 下滑动态加载新贴 (Infinite Scroll) 能增量提取并注入译文', () => {
    const app = doc.getElementById('app')!;
    // 模拟首屏已翻译 1 贴
    app.innerHTML = `
      <div class="scaffold-finite-scroll__content">
        <div class="occludable-update feed-shared-update-v2" id="post-1">
          <div class="update-components-text relative">
            <span dir="ltr">
              <span>First post already translated.</span>
            </span>
          </div>
        </div>
      </div>
    `;

    const initialBlocks = extractTranslatableBlocks(doc, 'zh-CN');
    expect(initialBlocks.length).toBe(1);
    injectTranslation(initialBlocks[0], '第一条已翻译帖子。', 'bilingual');

    // 模拟用户下滑，滚动加载出新贴 (post-2)
    const container = app.querySelector('.scaffold-finite-scroll__content')!;
    const newPost = doc.createElement('div');
    newPost.className = 'occludable-update feed-shared-update-v2';
    newPost.id = 'post-2';
    newPost.innerHTML = `
      <div class="update-components-text relative">
        <span dir="ltr">
          <span class="break-words">
            <span>Second post loaded dynamically via infinite scroll!</span>
          </span>
        </span>
      </div>
    `;
    container.appendChild(newPost);

    // 增量提取：只应当提取新贴，首贴已被接管不再提取
    const secondPassBlocks = extractTranslatableBlocks(doc, 'zh-CN');
    expect(secondPassBlocks.length).toBe(1);
    expect(secondPassBlocks[0].originalText).toBe('Second post loaded dynamically via infinite scroll!');
  });

  it('13. 导航操作按钮翻译时必须安全保留内联 SVG 图标，严禁整体破坏 DOM', () => {
    const app = doc.getElementById('app')!;
    app.innerHTML = `
      <button class="global-nav__primary-link">
        <svg class="global-nav__icon"><path d="M10 20..."></path></svg>
        <span class="global-nav__primary-link-text">Messaging</span>
      </button>
    `;

    const btn = app.querySelector('button')!;
    injectTranslation(
      {
        id: 'test-btn',
        element: btn,
        originalText: 'Messaging'
      },
      '消息',
      'bilingual'
    );

    // 验证 SVG 依旧完好保留在 DOM 树中
    const svg = btn.querySelector('svg');
    expect(svg).not.toBeNull();
    // 验证文本节点已更新
    expect(btn.textContent).toContain('消息');
  });
});
