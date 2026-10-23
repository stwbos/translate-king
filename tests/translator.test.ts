import { describe, it, expect } from 'vitest';
import { translateBatch, getGatewayHealthStatus } from '../src/background/translator';

describe('高可用降级翻译网关 (Resilient Translation Gateway)', () => {
  it('传入空数组时应立即返回空数组', async () => {
    const res = await translateBatch([], 'zh-CN');
    expect(res.translations).toEqual([]);
  });

  it('Tier 1: Microsoft 专线能极速完成批量双语翻译', async () => {
    const texts = [
      'TranslateKing provides immersive bilingual reading experience.',
      'Designed with resilience and multi-tier fallback gateway.'
    ];

    const res = await translateBatch(texts, 'zh-CN');
    expect(res.translations.length).toBe(2);
    // 译文中应包含中文字符
    expect(/[\u4e00-\u9fa5]/.test(res.translations[0])).toBe(true);
    expect(/[\u4e00-\u9fa5]/.test(res.translations[1])).toBe(true);

    const health = getGatewayHealthStatus();
    const anySuccess = health.microsoft.totalSuccess + health.google.totalSuccess + health.mymemory.totalSuccess;
    expect(anySuccess).toBeGreaterThan(0);
  }, 10000);

  it('L1 内存缓存秒级命中测试 (< 5ms)', async () => {
    const texts = ['Continuous learning makes human stronger.'];
    const start1 = performance.now();
    const res1 = await translateBatch(texts, 'zh-CN');
    const cost1 = performance.now() - start1;

    const start2 = performance.now();
    const res2 = await translateBatch(texts, 'zh-CN');
    const cost2 = performance.now() - start2;

    expect(res1.translations).toEqual(res2.translations);
    expect(cost2).toBeLessThan(5); // 缓存命中 < 5ms
  });

  it('网关健康监控应正确返回各通道指标', () => {
    const health = getGatewayHealthStatus();
    expect(health).toHaveProperty('microsoft');
    expect(health).toHaveProperty('google');
    expect(health).toHaveProperty('mymemory');
    expect(typeof health.cacheSize).toBe('number');
  });
});
