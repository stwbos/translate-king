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

  it('能成功查询中文词汇并返回拼音与英文释义及原句英文翻译', async () => {
    const result = await lookupWord('苹果', '每天吃一个苹果有益健康。', 'en');
    expect(result.word).toBe('苹果');
    // 音标字段应包含拼音
    expect(result.phonetic).toContain('píng');
    // 释义中应包含 apple
    expect(/apple/i.test(result.meaning)).toBe(true);
    // 原句翻译应为英文
    expect(/[a-zA-Z]/.test(result.sentenceTranslation)).toBe(true);
  }, 10000);

  it('中文长短语未被词典直接收录时自动降级至翻译网关翻译为英文', async () => {
    const phrase = '人工智能正在改变世界';
    const result = await lookupWord(phrase, `${phrase}，这是不可逆转的趋势。`, 'en');
    expect(result.word).toBe(phrase);
    expect(/[a-zA-Z]/.test(result.meaning)).toBe(true);
    expect(/[a-zA-Z]/.test(result.sentenceTranslation)).toBe(true);
  }, 10000);
});
