/**
 * 翻译王 (TranslateKing) - 视口优先判定与段落分级调度器
 */

import { TranslatableBlock } from './extractor';

/**
 * 视口碰撞检测：判断元素是否在当前屏幕可视区域（支持上下预加载缓冲带）
 */
export function isBlockInViewport(el: HTMLElement, verticalBuffer = 250): boolean {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  const windowHeight = (typeof window !== 'undefined' ? window.innerHeight : 0) || 800;

  return (
    rect.bottom >= -verticalBuffer &&
    rect.top <= windowHeight + verticalBuffer &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * 将整页所有段落划分为「首屏视口高优队列」与「屏外渐进队列」
 */
export function partitionBlocksByViewport(
  blocks: TranslatableBlock[],
  verticalBuffer = 200
): { visibleBlocks: TranslatableBlock[]; offscreenBlocks: TranslatableBlock[] } {
  const visibleBlocks: TranslatableBlock[] = [];
  const offscreenBlocks: TranslatableBlock[] = [];

  for (const block of blocks) {
    if (isBlockInViewport(block.element, verticalBuffer)) {
      visibleBlocks.push(block);
    } else {
      offscreenBlocks.push(block);
    }
  }

  return { visibleBlocks, offscreenBlocks };
}
