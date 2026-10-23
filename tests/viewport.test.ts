import { describe, it, expect } from 'vitest';
import { isBlockInViewport, partitionBlocksByViewport } from '../src/content/dom/viewport';
import { TranslatableBlock } from '../src/content/dom/extractor';

function createMockElementWithRect(rect: { top: number; bottom: number; width: number; height: number }): HTMLElement {
  return {
    getBoundingClientRect: () => ({
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      left: 0,
      right: rect.width,
      x: 0,
      y: rect.top,
      toJSON: () => {}
    })
  } as unknown as HTMLElement;
}

describe('视口优先探测引擎 (Viewport-First Engine)', () => {
  it('屏幕可视区域内的段落应当被判定为可见', () => {
    // 假设 window.innerHeight 为 800
    const inScreen = createMockElementWithRect({ top: 100, bottom: 250, width: 600, height: 150 });
    expect(isBlockInViewport(inScreen, 200)).toBe(true);
  });

  it('位于视口上方过远的段落应当被判定为屏外', () => {
    const farAbove = createMockElementWithRect({ top: -1000, bottom: -800, width: 600, height: 200 });
    expect(isBlockInViewport(farAbove, 200)).toBe(false);
  });

  it('位于视口下方很远的段落应当被判定为屏外，供第二阶段渐进加载', () => {
    const farBelow = createMockElementWithRect({ top: 3000, bottom: 3200, width: 600, height: 200 });
    expect(isBlockInViewport(farBelow, 200)).toBe(false);
  });

  it('接近屏幕边缘但处于预加载缓冲带 (Buffer) 内的段落应当被优先纳入首屏', () => {
    // 假设视口高度为 800，元素在 850 (距离底部 50px，在 buffer 200 范围内)
    const nearBottom = createMockElementWithRect({ top: 750, bottom: 850, width: 600, height: 100 });
    expect(isBlockInViewport(nearBottom, 200)).toBe(true);
  });

  it('partitionBlocksByViewport 能够准确将混合段落拆分为可见队列与屏外队列', () => {
    const b1: TranslatableBlock = {
      id: 'b1',
      element: createMockElementWithRect({ top: 100, bottom: 200, width: 500, height: 100 }),
      originalText: 'Visible block'
    };
    const b2: TranslatableBlock = {
      id: 'b2',
      element: createMockElementWithRect({ top: 4000, bottom: 4100, width: 500, height: 100 }),
      originalText: 'Offscreen block'
    };
    const b3: TranslatableBlock = {
      id: 'b3',
      element: createMockElementWithRect({ top: 300, bottom: 400, width: 500, height: 100 }),
      originalText: 'Another visible block'
    };

    const { visibleBlocks, offscreenBlocks } = partitionBlocksByViewport([b1, b2, b3], 200);

    expect(visibleBlocks.map(b => b.id)).toEqual(['b1', 'b3']);
    expect(offscreenBlocks.map(b => b.id)).toEqual(['b2']);
  });
});
