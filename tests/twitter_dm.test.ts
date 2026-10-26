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
    expect(ATOMIC_BLOCK_SELECTORS).toContain('div[aria-label="Timeline: Messages"] div[dir="auto"]');
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
});
