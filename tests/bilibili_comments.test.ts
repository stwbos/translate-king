import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks, collectAllRoots } from '../src/content/dom/extractor';
import { injectTranslation, clearAllTranslations } from '../src/content/dom/injector';

describe('Bilibili Comments & Nested Shadow DOM Extraction', () => {
  let doc: Document;

  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
    doc = dom.window.document;
    (global as any).document = doc;
    (global as any).window = dom.window;
  });

  it('能穿透4层嵌套 Web Components Shadow DOM 成功提取 Bilibili 评论区正文', () => {
    const app = doc.getElementById('app')!;
    const biliComments = doc.createElement('bili-comments');
    app.appendChild(biliComments);

    const s1 = biliComments.attachShadow({ mode: 'open' });
    const thread = doc.createElement('bili-comment-thread-renderer');
    s1.appendChild(thread);

    const s2 = thread.attachShadow({ mode: 'open' });
    const commentRenderer = doc.createElement('bili-comment-renderer');
    commentRenderer.id = 'comment';
    s2.appendChild(commentRenderer);

    const s3 = commentRenderer.attachShadow({ mode: 'open' });
    const richText = doc.createElement('bili-rich-text');
    s3.appendChild(richText);

    const s4 = richText.attachShadow({ mode: 'open' });
    const contentsDiv = doc.createElement('div');
    contentsDiv.id = 'contents';
    contentsDiv.className = 'bili-rich-text__content';
    contentsDiv.innerHTML = '<span>博主牛，讲得特别浅显易懂。你用的可视化工具是啥呀，就是视频中演示的那种</span>';
    s4.appendChild(contentsDiv);

    // 验证 collectAllRoots 发现所有 5 个根节点 (1 个 document + 4 个 shadowRoot)
    const roots = collectAllRoots(doc);
    expect(roots.length).toBe(5);

    // 验证提取韩语翻译目标下的待翻译块
    const blocks = extractTranslatableBlocks(doc, 'ko');
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('博主牛，讲得特别浅显易懂。你用的可视化工具是啥呀，就是视频中演示的那种');

    // 验证在 Shadow DOM 内部注入韩文双语译文
    injectTranslation(blocks[0], '블로거님 대단해요, 아주 알기 쉽게 설명해 주시네요.', 'bilingual');

    const wrapper = s4.querySelector('.translate-king-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.textContent).toContain('블로거님 대단해요');

    // 验证 Shadow DOM 内部已挂载专用隔离样式
    const styleTag = s4.getElementById('translate-king-shadow-styles');
    expect(styleTag).not.toBeNull();

    // 验证还原原文时彻底清除 Shadow DOM 内的译文与样式
    clearAllTranslations(doc);
    expect(s4.querySelector('.translate-king-wrapper')).toBeNull();
    expect(s4.getElementById('translate-king-shadow-styles')).toBeNull();
  });

  it('能精准保留 Bilibili 评论中的专属表情 alt 文本 (如 [脱单doge])', () => {
    const app = doc.getElementById('app')!;
    const biliComments = doc.createElement('bili-comments');
    app.appendChild(biliComments);

    const s1 = biliComments.attachShadow({ mode: 'open' });
    const richText = doc.createElement('bili-rich-text');
    s1.appendChild(richText);

    const s2 = richText.attachShadow({ mode: 'open' });
    const contentsDiv = doc.createElement('div');
    contentsDiv.id = 'contents';
    contentsDiv.className = 'bili-rich-text__content';
    contentsDiv.innerHTML = '<span>太强了</span><img class="bili-rich-text-emoji" src="https://i0.hdslb.com/bfs/emote/123.png" alt="[脱单doge]">';
    s2.appendChild(contentsDiv);

    const blocks = extractTranslatableBlocks(doc, 'ko');
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('太强了[脱单doge]');
  });

  it('能同时提取 Bilibili 楼层根评论和楼中楼回复评论', () => {
    const app = doc.getElementById('app')!;
    const biliComments = doc.createElement('bili-comments');
    app.appendChild(biliComments);

    const s1 = biliComments.attachShadow({ mode: 'open' });
    const thread = doc.createElement('bili-comment-thread-renderer');
    s1.appendChild(thread);

    const s2 = thread.attachShadow({ mode: 'open' });

    // 根评论
    const rootComment = doc.createElement('bili-comment-renderer');
    s2.appendChild(rootComment);
    const sRoot = rootComment.attachShadow({ mode: 'open' });
    const richRoot = doc.createElement('bili-rich-text');
    sRoot.appendChild(richRoot);
    const sRichRoot = richRoot.attachShadow({ mode: 'open' });
    const rootDiv = doc.createElement('div');
    rootDiv.id = 'contents';
    rootDiv.className = 'bili-rich-text__content';
    rootDiv.innerHTML = '<span>这个视频解释了为什么学编程需要高数</span>';
    sRichRoot.appendChild(rootDiv);

    // 楼中楼回复
    const repliesRenderer = doc.createElement('bili-comment-replies-renderer');
    s2.appendChild(repliesRenderer);
    const sReplies = repliesRenderer.attachShadow({ mode: 'open' });
    const replyItem = doc.createElement('bili-comment-reply-renderer');
    sReplies.appendChild(replyItem);
    const sReplyItem = replyItem.attachShadow({ mode: 'open' });
    const richReply = doc.createElement('bili-rich-text');
    sReplyItem.appendChild(richReply);
    const sRichReply = richReply.attachShadow({ mode: 'open' });
    const replyDiv = doc.createElement('div');
    replyDiv.id = 'contents';
    replyDiv.className = 'bili-rich-text__content';
    replyDiv.innerHTML = '<span>确实，线性代数也很重要</span>';
    sRichReply.appendChild(replyDiv);

    const blocks = extractTranslatableBlocks(doc, 'ko');
    expect(blocks.length).toBe(2);
    expect(blocks[0].originalText).toBe('这个视频解释了为什么学编程需要高数');
    expect(blocks[1].originalText).toBe('确实，线性代数也很重要');
  });
});
