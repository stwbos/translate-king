import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubtitleScheduler } from '../src/content/youtube/scheduler';
import { SubtitleCue } from '../src/content/youtube/types';

describe('YouTube 滑动窗口字幕调度器 (SubtitleScheduler)', () => {
  let scheduler: SubtitleScheduler;
  const sampleCues: SubtitleCue[] = [
    { id: 1, startMs: 1000, endMs: 3000, originalText: 'Hello everyone.' },
    { id: 2, startMs: 3500, endMs: 6000, originalText: 'Welcome to this tech talk.' },
    { id: 3, startMs: 7000, endMs: 10000, originalText: 'Today we discuss sliding windows.' },
    { id: 4, startMs: 120000, endMs: 125000, originalText: 'Two minutes later in the video.' }
  ];

  beforeEach(() => {
    scheduler = new SubtitleScheduler('zh-CN');
    scheduler.loadCues(sampleCues);
  });

  it('基于 O(logN) 二分查找应当精确命中播放时间对应的字幕段', () => {
    expect(scheduler.findCueAt(500)).toBeNull(); // 尚未到第一句
    expect(scheduler.findCueAt(1000)?.originalText).toBe('Hello everyone.'); // 刚好首帧
    expect(scheduler.findCueAt(2500)?.originalText).toBe('Hello everyone.'); // 句中
    expect(scheduler.findCueAt(3000)?.originalText).toBe('Hello everyone.'); // 句尾
    expect(scheduler.findCueAt(3200)).toBeNull(); // 两句之间的静音停顿
    expect(scheduler.findCueAt(4000)?.originalText).toBe('Welcome to this tech talk.');
  });

  it('时间更新时应当准确通知外部监听器切换字幕', () => {
    const listener = vi.fn();
    scheduler.subscribe(listener);

    scheduler.onTimeUpdate(1500);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

    // 仍在同一句内，不应频繁重复触发通知
    scheduler.onTimeUpdate(1800);
    expect(listener).toHaveBeenCalledTimes(1);

    // 跨越到第二句，触发切换通知
    scheduler.onTimeUpdate(4500);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2 }));

    // 跳入停顿空白区，通知 null
    scheduler.onTimeUpdate(6500);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(null);
  });

  it('用户拖动进度条 (Seek) 应当立即定位并通知新时间点的字幕', () => {
    const listener = vi.fn();
    scheduler.subscribe(listener);

    scheduler.onSeek(122000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 4, originalText: 'Two minutes later in the video.' }));
  });

  it('已有内存译文在重新加载同名文本时应当 0ms 瞬间直出', () => {
    // 模拟写入第一句译文
    sampleCues[0].translatedText = '大家好。';
    scheduler.loadCues(sampleCues);

    const hit = scheduler.findCueAt(2000);
    expect(hit?.translatedText).toBe('大家好。');
  });
});
