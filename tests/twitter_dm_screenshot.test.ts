import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractTranslatableBlocks } from '../src/content/dom/extractor';
import { injectTranslation } from '../src/content/dom/injector';

describe('Screenshot DOM Reproduction', () => {
  it('extracts all elements visible in the screenshot', () => {
    const html = `
      <!-- Left sidebar -->
      <header role="banner">
        <nav aria-label="Primary">
          <a href="/home" aria-label="Home"></a>
          <a href="/explore" aria-label="Explore"></a>
          <a href="/notifications" aria-label="Notifications"></a>
          <a href="/messages" aria-label="Direct Messages" aria-selected="true"></a>
        </nav>
      </header>

      <!-- Middle column: Conversation list -->
      <section aria-label="Direct Messages" role="region">
        <div data-testid="DMInbox">
          <h1 role="heading">Chat</h1>
          <div data-testid="conversation" role="row">
            <div data-testid="User-Name"><span>Elon</span></div>
            <div dir="auto"><span>Is this really</span></div>
            <time>6d</time>
          </div>
          <div data-testid="conversation" role="row">
            <div data-testid="User-Name"><span>Viora</span></div>
            <div dir="auto"><span>Hey, did aliens take you away?</span></div>
            <time>1w</time>
          </div>
          <div data-testid="conversation" role="row">
            <div data-testid="User-Name"><span>Vladimir Ivanovich Voronkov</span></div>
            <div dir="auto"><span>What is your name and where are you ...</span></div>
            <time>1w</time>
          </div>
        </div>
      </section>

      <!-- Right column: Active Chat Thread -->
      <div data-testid="DMChatTranscript">
        <div data-testid="cellInnerDiv">
          <!-- Profile Card -->
          <div class="profile-card">
            <div data-testid="User-Name"><span>Vladimir Ivanovich Voronkov</span></div>
            <div dir="ltr"><span>Joined January 2024</span></div>
            <div dir="ltr"><span>895 Followers</span></div>
            <button role="button"><span>View Profile</span></button>
          </div>
        </div>

        <div data-testid="cellInnerDiv">
          <div dir="auto"><span>Thu, Oct 15 at 12:14 AM</span></div>
        </div>

        <!-- Incoming Message 1 -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-in css-175oi2r" role="button" tabindex="0">
              <div dir="auto" class="bubble-text">
                <span>Hello, nice to meet you</span>
              </div>
              <time datetime="2026-10-15T00:14:00Z">12:14 AM</time>
            </div>
          </div>
        </div>

        <!-- Outgoing Message 1 (Blue) -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-out css-175oi2r" style="background-color: rgb(29, 155, 240);">
              <div dir="auto" class="bubble-text" style="color: rgb(255, 255, 255);">
                <span>Hello</span>
              </div>
              <time datetime="2026-10-15T00:15:00Z">12:15 AM</time>
            </div>
          </div>
        </div>

        <!-- Incoming Message 2 -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-in css-175oi2r" role="button">
              <div dir="auto" class="bubble-text">
                <span>Welcome</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Incoming Message 3 -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-in css-175oi2r" role="button">
              <div dir="auto" class="bubble-text">
                <span>How are you doing?</span>
              </div>
              <time datetime="2026-10-15T00:15:00Z">12:15 AM</time>
            </div>
          </div>
        </div>

        <!-- Outgoing Message 2 (Blue) -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-out css-175oi2r" style="background-color: rgb(29, 155, 240);">
              <div dir="auto" class="bubble-text">
                <span>Pretty good, thanks. You?</span>
              </div>
              <time datetime="2026-10-15T00:17:00Z">12:17 AM</time>
            </div>
          </div>
        </div>

        <!-- Incoming Message 4 -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-in css-175oi2r">
              <div dir="auto" class="bubble-text">
                <span>I am fine</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Incoming Message 5 -->
        <div data-testid="cellInnerDiv">
          <div data-testid="messageEntry" role="row">
            <div class="bubble-in css-175oi2r">
              <div dir="auto" class="bubble-text">
                <span>What is your name and where are you from?</span>
              </div>
              <time datetime="2026-10-15T00:24:00Z">12:24 AM</time>
            </div>
          </div>
        </div>
      </div>
    `;

    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const blocks = extractTranslatableBlocks(doc);

    console.log("ALL EXTRACTED BLOCKS:");
    blocks.forEach(b => console.log(`- [${b.element.tagName}] "${b.originalText}"`));

    // Verify chat messages
    const texts = blocks.map(b => b.originalText);
    expect(texts).toContain('Hello, nice to meet you');
    expect(texts).toContain('Hello');
    expect(texts).toContain('Welcome');
    expect(texts).toContain('How are you doing?');
    expect(texts).toContain('Pretty good, thanks. You?');
    expect(texts).toContain('I am fine');
    expect(texts).toContain('What is your name and where are you from?');

    // Verify conversation list
    expect(texts).toContain('Hey, did aliens take you away?');
    expect(texts).toContain('What is your name and where are you ...');
  });
});
