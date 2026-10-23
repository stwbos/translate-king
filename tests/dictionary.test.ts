import { describe, it, expect } from 'vitest';
import { lookupWord } from '../src/background/dictionary';

describe('词典与语境服务 (Dictionary Service)', () => {
  it('能成功查询英文单词的音标与有道词典中文释义', async () => {
    const result = await lookupWord('resilience', 'Resilience is crucial for distributed systems.');
    expect(result.word).toBe('resilience');
    expect(result.phonetic.length).toBeGreaterThan(0);
    // 包含中文字符释义
    expect(/[\u4e00-\u9fa5]/.test(result.meaning)).toBe(true);
    // 包含原句与原句翻译
    expect(result.sentence).toBe('Resilience is crucial for distributed systems.');
    expect(result.sentenceTranslation.length).toBeGreaterThan(0);
    expect(/[\u4e00-\u9fa5]/.test(result.sentenceTranslation)).toBe(true);
  }, 10000);

  it('相同单词连续查询应秒级命中内存缓存', async () => {
    const start1 = performance.now();
    const res1 = await lookupWord('breakthrough', 'This is a scientific breakthrough.');
    const cost1 = performance.now() - start1;

    const start2 = performance.now();
    const res2 = await lookupWord('breakthrough', 'This is a scientific breakthrough.');
    const cost2 = performance.now() - start2;

    expect(res1.meaning).toBe(res2.meaning);
    expect(cost2).toBeLessThan(5); // 缓存读取 < 5ms
  });
});
