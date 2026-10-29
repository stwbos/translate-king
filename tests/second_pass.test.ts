import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectLoadingState, injectTranslation } from '../src/content/dom/injector';
import { isValidTranslatableText, isAlreadyInTargetLanguage } from '../src/content/dom/filter';

describe('Second Pass (MutationObserver) Double Extraction Bug', () => {
  it('checks if parent containers are extracted in second pass after children are translated', () => {
    const pageHtml = `
    <nav id="mw-panel-toc" class="vector-toc-landmark">
      <ul class="vector-toc-contents" id="mw-panel-toc-list">
        <li id="toc-mw-content-text" class="vector-toc-list-item vector-toc-level-1">
          <a href="#" class="vector-toc-link">
            <div class="vector-toc-text">(Top)</div>
          </a>
        </li>
        <li id="toc-Structure" class="vector-toc-list-item vector-toc-level-1">
          <a class="vector-toc-link" href="#Structure">
            <div class="vector-toc-text">
              <span class="vector-toc-numb">1</span>
              <span>Structure</span>
            </div>
          </a>
          <button class="cdx-button vector-toc-toggle"><span>Toggle Structure</span></button>
        </li>
        <li id="toc-Installation" class="vector-toc-list-item vector-toc-level-1">
          <a class="vector-toc-link" href="#Installation">
            <div class="vector-toc-text">
              <span class="vector-toc-numb">2</span>
              <span>Installation</span>
            </div>
          </a>
        </li>
      </ul>
    </nav>
    `;
    const dom = new JSDOM(pageHtml);
    const doc = dom.window.document;

    // PASS 1
    const blocks1 = extractTranslatableBlocks(doc.body);
    expect(blocks1.length).toBeGreaterThan(0);

    // Inject Pass 1
    blocks1.forEach(b => injectTranslation(b, '【译】' + b.originalText, 'replace'));

    // PASS 2 (simulating MutationObserver)
    const blocks2 = extractTranslatableBlocks(doc.body);

    // blocks2 must NOT contain any elements that enclose elements from blocks1
    let foundDisaster = false;
    for (const b2 of blocks2) {
      for (const b1 of blocks1) {
        if (b2.element.contains(b1.element)) {
          foundDisaster = true;
        }
      }
    }

    expect(foundDisaster).toBe(false);
    expect(blocks2.length).toBe(0);
  });

  it('YouTube 评论区 (#content-text) 与右侧推荐列表标题在双语模式及加载中绝不发生子 span 拆碎或二次重复翻译', () => {
    const ytHtml = `
      <div id="page">
        <div id="comments">
          <h2>10,803 条评论</h2>
          <div>排序方式</div>
          <div>添加评论...</div>
          <div>已由@programmingwithmosh置顶</div>
          <div>4年前（修改过）</div>
          <div id="content-text">
            <span class="yt-core-attributed-string">
              <span>🔥</span>
              <span>Want to master SQL? Get the full SQL course: </span>
              <a href="https://mosh.link/sql-course">https://mosh.link/sql-course</a>
              <span>📔</span>
              <span>Get my FREE SQL cheatsheet: </span>
              <a href="https://mosh.link/sql-cheatsheet">https://mosh.link/sql-cheatsheet</a>
            </span>
          </div>
          <div>回复</div>
          <div>145 条回复</div>
        </div>
        <div id="secondary">
          <h3 class="yt-lockup-metadata-view-model__heading-reset">
            <a class="yt-lockup-metadata-view-model__title" href="/watch?v=123">
              <span class="yt-core-attributed-string">5 AI Agent Terms You Need to Know</span>
            </a>
          </h3>
          <div>411万</div>
          <div>3年前</div>
          <h3>JavaScript初学者教程：1小时学会JavaScript</h3>
        </div>
        <div id="translate-king-floating-ball" data-tk-ignore="true">
          <span>✓译</span>
        </div>
      </div>
    `;
    const dom = new JSDOM(ytHtml);
    const doc = dom.window.document;

    // 1. 纯中文界面词、播放量、相对时间、纯 Emoji 应当直接被过滤，绝不进入翻译队列
    expect(isValidTranslatableText('10,803 条评论')).toBe(false);
    expect(isAlreadyInTargetLanguage('排序方式', 'zh-CN')).toBe(true);
    expect(isAlreadyInTargetLanguage('添加评论...', 'zh-CN')).toBe(true);
    expect(isAlreadyInTargetLanguage('已由@programmingwithmosh置顶', 'zh-CN')).toBe(true);
    expect(isValidTranslatableText('4年前（修改过）')).toBe(false);
    expect(isValidTranslatableText('411万')).toBe(false);
    expect(isValidTranslatableText('3年前')).toBe(false);
    expect(isAlreadyInTargetLanguage('JavaScript初学者教程：1小时学会JavaScript', 'zh-CN')).toBe(true);
    expect(isValidTranslatableText('🔥')).toBe(false);

    // 2. 第一轮提取：只应提取真正的英文评论 #content-text 和英文视频标题 h3（绝不提取中文 UI 和悬浮球）
    const pass1 = extractTranslatableBlocks(doc.body, 'zh-CN');
    expect(pass1.length).toBe(2);

    // 模拟第一轮处于 Loading 态时，MutationObserver 立刻发起第二轮扫描
    pass1.forEach((b) => injectLoadingState(b, 'bilingual'));
    const passDuringLoading = extractTranslatableBlocks(doc.body, 'zh-CN');
    expect(passDuringLoading.length).toBe(0);

    // 模拟第一轮完成双语注入后，MutationObserver 再次发起扫描
    pass1.forEach((b) => injectTranslation(b, '【双语译文】' + b.originalText, 'bilingual'));
    const passAfterDone = extractTranslatableBlocks(doc.body, 'zh-CN');
    expect(passAfterDone.length).toBe(0);

    // 验证全页没有任何残留的 .translate-king-loading ("翻译中...")，且每个块只有唯一一条译文
    expect(doc.querySelectorAll('.translate-king-loading').length).toBe(0);
    expect(doc.querySelectorAll('.translate-king-done').length).toBe(2);
  });

  it('在仅看译文 (replace) 模式下，多行评论 (含 \\n 换行、<br> 标签、时间戳 <a> 链接) 应 100% 保留原始换行排版与外层 span 容器', () => {
    const commentHtml = `
      <div>
        <yt-attributed-string id="content-text">
          <span class="yt-core-attributed-string yt-core-attributed-string--white-space-pre-wrap"><a href="/watch?v=123&t=60s">01:00</a> Introduction
<a href="/watch?v=123&t=180s">03:00</a> Deep Dive

Great explanation!</span>
        </yt-attributed-string>
        <div class="forum-comment">First line of review.<br><br>1. Fast speed<br>2. Clean UI</div>
      </div>
    `;
    const dom = new JSDOM(commentHtml);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc.body, 'zh-CN');
    expect(blocks.length).toBe(2);

    // 1. 验证提取阶段完整保留了 \n 与 <br> 换行
    expect(blocks[0].originalText).toBe('<x0>01:00</x0> Introduction\n<x1>03:00</x1> Deep Dive\n\nGreat explanation!');
    expect(blocks[1].originalText).toBe('First line of review.\n\n1. Fast speed\n2. Clean UI');

    // 2. 验证 replace (仅看译文) 注入后保留了换行符、data-tk-multiline 属性及 YouTube 外层 pre-wrap span
    injectTranslation(
      blocks[0],
      '<x0>01:00</x0> 简介\n<x1>03:00</x1> 深入解析\n\n非常棒的讲解！',
      'replace'
    );
    injectTranslation(blocks[1], '第一行评价。\n\n1. 速度极快\n2. 界面清爽', 'replace');

    const ytComment = doc.getElementById('content-text')!;
    expect(ytComment.getAttribute('data-tk-multiline')).toBe('true');
    expect(ytComment.querySelector('.yt-core-attributed-string--white-space-pre-wrap')).not.toBeNull();
    expect(ytComment.querySelectorAll('a').length).toBe(2);
    expect(ytComment.textContent).toBe('01:00 简介\n03:00 深入解析\n\n非常棒的讲解！');

    const forumComment = doc.querySelector('.forum-comment')!;
    expect(forumComment.getAttribute('data-tk-multiline')).toBe('true');
    expect(forumComment.textContent).toBe('第一行评价。\n\n1. 速度极快\n2. 界面清爽');
  });
});
