import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks, ATOMIC_BLOCK_SELECTORS } from '../src/content/dom/extractor';
import { injectTranslation, removeTranslation } from '../src/content/dom/injector';
import { isElementEffectivelyTranslated, shouldIgnoreElement } from '../src/content/dom/filter';
import { translateBatch } from '../src/background/translator';

describe('X / Twitter 私信与聊天消息即时翻译专项测试 (Twitter DM & Chat Immediate Translation)', () => {
  it('1. ATOMIC_BLOCK_SELECTORS 应当包含 X 私信聊天气泡与对话列表专用选择器', () => {
    expect(ATOMIC_BLOCK_SELECTORS).toContain('[data-testid="messageEntry"] [dir="auto"]');
    expect(ATOMIC_BLOCK_SELECTORS).toContain('[data-testid="conversation"] [dir="auto"]');
    expect(ATOMIC_BLOCK_SELECTORS).toContain('[data-testid="messageEntry"] [data-testid="tweetText"]');
  });

  it('2. UI_GLOSSARY 应当包含 X 私信常用动作与系统词汇', async () => {
    const dmTerms = [
      'Messages',
      'Direct Messages',
      'Send a message',
      'New message',
      'Start a conversation',
      'Reply',
      'Delete message'
    ];
    const res = await translateBatch(dmTerms, 'zh-CN');
    expect(res.translations[0]).toBe('私信');
    expect(res.translations[1]).toBe('私信');
    expect(res.translations[2]).toBe('发送私信');
    expect(res.translations[3]).toBe('新私信');
    expect(res.translations[4]).toBe('发起对话');
    expect(res.translations[5]).toBe('回复');
    expect(res.translations[6]).toBe('删除消息');
  });

  it('3. 能够高精度从 X 聊天消息 DOM 中提取气泡文本并彻底排除发信输入框', () => {
    const html = `
      <div data-testid="DMConversationBody">
        <!-- 聊天消息列表容器 -->
        <div aria-label="Timeline: Messages" role="region">
          <!-- 消息 1: 对方发送的消息 -->
          <div data-testid="messageEntry" role="row">
            <div class="msg-wrapper">
              <div role="group" aria-label="Message actions">
                <button aria-label="Add reaction"><svg></svg></button>
                <button aria-label="Reply"><svg></svg></button>
                <button aria-label="More"><svg></svg></button>
              </div>
              <div data-testid="message-bubble" class="bubble-in">
                <div dir="auto" class="bubble-text">
                  <span>Hey! Are you free for a quick call regarding the project?</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 消息 2: 我方发送的消息 -->
          <div data-testid="messageEntry" role="row">
            <div class="msg-wrapper">
              <div data-testid="message-bubble" class="bubble-out">
                <div dir="auto" class="bubble-text">
                  <span>Yes, I am available in 10 minutes.</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部发信输入框与工具栏 (必须 100% 绝对保护与忽略) -->
        <div data-testid="DMComposer">
          <div data-testid="DMComposerTextInput" contenteditable="true" role="textbox">
            Type a message...
          </div>
          <button data-testid="dmComposerSendButton" aria-label="Send">
            <svg></svg>
          </button>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // 验证输入框被严格忽略
    const composer = doc.querySelector('[data-testid="DMComposerTextInput"]') as HTMLElement;
    expect(shouldIgnoreElement(composer)).toBe(true);

    // 验证消息气泡成功提取
    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(2);
    expect(blocks[0].originalText).toContain('Hey! Are you free for a quick call regarding the project?');
    expect(blocks[1].originalText).toContain('Yes, I am available in 10 minutes.');

    // 验证双语翻译正确挂载在气泡内部
    injectTranslation(blocks[0], '嘿！你现在有空就这个项目简单通个话吗？', 'bilingual');
    expect(blocks[0].element.querySelector('.translate-king-text')?.textContent).toBe('嘿！你现在有空就这个项目简单通个话吗？');
    expect(blocks[0].element.textContent).toContain('Hey! Are you free');
    expect(blocks[0].element.textContent).toContain('嘿！你现在有空就这个项目简单通个话吗？');
  });

  it('4. 能够从 X 聊天会话列表 (Conversations) 中正确提取联系人对话摘要', () => {
    const html = `
      <section aria-label="Direct Messages" role="region">
        <div data-testid="conversation" role="row">
          <div class="conv-inner">
            <div data-testid="User-Name">
              <span dir="ltr">Alex Rivera</span>
            </div>
            <div dir="auto" class="conv-snippet">
              <span>Let us sync up tomorrow morning.</span>
            </div>
          </div>
        </div>
      </section>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    const snippetBlock = blocks.find((b) => b.originalText.includes('Let us sync up tomorrow morning'));
    expect(snippetBlock).toBeDefined();
    expect(snippetBlock?.originalText).toBe('Let us sync up tomorrow morning.');
  });

  it('5. 能够提取完全无 dir 属性的 React Native Web 原生聊天气泡，并彻底排除动作按钮与时间戳', () => {
    const html = `
      <div data-testid="DMConversationBody">
        <div data-testid="messageEntry" role="row">
          <div class="css-175oi2r r-1iusvr4">
            <!-- 动作按钮区 -->
            <div role="group" aria-label="Message actions">
              <button aria-label="Add reaction"><svg></svg></button>
              <button aria-label="Reply"><svg></svg></button>
            </div>
            <!-- 原生 React Native 气泡容器 (无 dir 属性) -->
            <div class="css-175oi2r r-1pi2tsx">
              <div class="css-14cqt7a r-3pj75a">
                <span class="css-1j6292g">Could you send over the updated design files today?</span>
              </div>
              <div class="css-time">
                <time datetime="2026-10-26T07:00:00Z">3:15 PM</time>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('Could you send over the updated design files today?');

    // 验证能够成功注入翻译
    injectTranslation(blocks[0], '你今天能把更新后的设计文件发过来吗？', 'bilingual');
    expect(blocks[0].element.textContent).toContain('你今天能把更新后的设计文件发过来吗？');
  });

  it('6. 对话列表 (Conversations) 无 dir 属性时仍能提取联系人姓名与最后消息摘要', () => {
    const html = `
      <div data-testid="conversation" role="row">
        <div class="conv-inner">
          <div data-testid="User-Name">
            <div class="name-box">
              <span>Sarah Connor</span>
            </div>
          </div>
          <div class="snippet-box">
            <span>I will be back in 5 minutes.</span>
          </div>
          <time datetime="2026-10-26T07:10:00Z">5m</time>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(2);
    const nameBlock = blocks.find((b) => b.originalText === 'Sarah Connor');
    const snippetBlock = blocks.find((b) => b.originalText === 'I will be back in 5 minutes.');
    expect(nameBlock).toBeDefined();
    expect(snippetBlock).toBeDefined();
  });

  it('7. 能够从无 messageEntry 属性的 cellInnerDiv 容器 (DMConversation / DMChatTranscript) 中提取气泡文本', () => {
    const html = `
      <div data-testid="DMConversation">
        <div data-testid="cellInnerDiv">
          <div class="css-175oi2r r-1iusvr4">
            <div class="bubble css-175oi2r">
              <div dir="auto" class="css-14cqt7a">
                <span class="css-1j6292g">Are we still meeting at 3 PM today?</span>
              </div>
              <time datetime="2026-10-26T07:15:00Z">3:15 PM</time>
            </div>
            <div class="actions">
              <button aria-label="Reply"></button>
            </div>
          </div>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('Are we still meeting at 3 PM today?');
  });

  it('8. 当整个消息行包裹在 role="group" 或 role="row" 时，不被误杀并正常提取', () => {
    const html = `
      <div role="group" aria-label="Message group from Alice">
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble css-175oi2r">
              <div dir="auto" class="css-14cqt7a">
                <span class="css-1j6292g">Please review the attached contract before signing.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('Please review the attached contract before signing.');
  });

  it('9. 即使气泡容器带 Touchable/Pressable 的 role="button" 且字数超过 50 字，也能正常提取和双语挂载', () => {
    const html = `
      <div data-testid="DMConversation">
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry">
            <!-- React Native Web 给整个气泡加上 role="button" 供点击复制/查看时间 -->
            <div class="bubble css-175oi2r" role="button" tabindex="0">
              <div dir="auto" class="css-14cqt7a">
                <span>The quick brown fox jumps over the lazy dog repeatedly and provides an exceptionally long message in chat.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toContain('The quick brown fox jumps over the lazy dog');

    // 验证双语模式不会将带有 role="button" 的聊天气泡当成 UI 小按钮拒绝挂载
    injectTranslation(blocks[0], '敏捷的棕色狐狸一次又一次跳过懒狗，在私信聊天中提供了一条格外长的文本消息。', 'bilingual');
    const wrapper = blocks[0].element.querySelector('.translate-king-wrapper');
    expect(wrapper).not.toBeNull();
    expect(blocks[0].element.textContent).toContain('敏捷的棕色狐狸');
  });

  it('10. 能够从发出的蓝色气泡 (bubble-out / 包含背景色) 中正确提取并成功注入双语', () => {
    const html = `
      <div data-testid="DMConversation">
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry">
            <div class="bubble-out css-175oi2r" style="background-color: rgb(29, 155, 240);">
              <div dir="auto" class="css-14cqt7a" style="color: rgb(255, 255, 255);">
                <span>I have finished uploading the presentation slides.</span>
              </div>
              <time datetime="2026-10-26T07:20:00Z">3:20 PM</time>
            </div>
          </div>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const blocks = extractTranslatableBlocks(doc);
    expect(blocks.length).toBe(1);
    expect(blocks[0].originalText).toBe('I have finished uploading the presentation slides.');

    injectTranslation(blocks[0], '我已经完成了演讲幻灯片的上传。', 'bilingual');
    expect(blocks[0].element.textContent).toContain('我已经完成了演讲幻灯片的上传。');
  });
});
