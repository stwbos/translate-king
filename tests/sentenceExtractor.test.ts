import { describe, it, expect } from 'vitest';
import { cleanWord, extractSentenceFromText } from '../src/content/selection/sentence-extractor';

describe('原句语境提取引擎 (SentenceExtractor)', () => {
  it('cleanWord 应当去除生词边缘标点与空格', () => {
    expect(cleanWord('  "resilience,"  ')).toBe('resilience');
    expect(cleanWord('(breakthrough!)')).toBe('breakthrough');
    expect(cleanWord('AI-driven')).toBe('AI-driven');
  });

  it('能从复合段落中精准截取当前词所在的句子', () => {
    const text = 'First, we setup the environment. Second, resilience is crucial when dealing with distributed systems! Finally, we verify everything.';
    const sentence = extractSentenceFromText(text, 'resilience');
    expect(sentence).toBe('Second, resilience is crucial when dealing with distributed systems!');
  });

  it('遇到问号、感叹号与中英文标点时能正确识别句子边界', () => {
    const text = 'Do you understand? Artificial intelligence will change the world! That is undeniable.';
    const sentence = extractSentenceFromText(text, 'intelligence');
    expect(sentence).toBe('Artificial intelligence will change the world!');
  });

  it('不应将小数点或缩写如 e.g. 误判为句子结束', () => {
    const text = 'Consider e.g. the network latency of 12.5ms. This represents the average ping.';
    const sentence = extractSentenceFromText(text, 'latency');
    expect(sentence).toBe('Consider e.g. the network latency of 12.5ms.');
  });
});
