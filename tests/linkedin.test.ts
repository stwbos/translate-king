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
});
