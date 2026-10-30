/**
 * 翻译王 (TranslateKing) - YouTube 滑动窗口按需翻译调度器 (Sliding Window Subtitle Scheduler)
 *
 * 核心机制：
 * 1. 本地毫秒级时间轴二分快查 (Binary Search O(logN))：根据当前播放时间精确匹配对应字幕
 * 2. 滑动窗口按需预读 (Sliding Window Pre-translation)：
 *    - 开播与 Seek 跳跃时，只优先翻译当前播放点后 2 分钟 (120s) 的字幕段，100ms 瞬间上屏
 *    - 播放中当预读缓冲不足 45 秒时，后台流水线静默预取下一批 (30 句)
 *    - 彻底告别整片上千句并发请求导致的 HTTP 429 限流封锁
 * 3. 进度条跳跃抢占 (Seek Preemption)：用户拖拽进度条时，立即打断并优先加载新时间点附近的字幕
 */

import { SubtitleCue } from './types';
import { TargetLanguage, TranslateBatchResponse } from '../../types';

// 滑动窗口超前预读视野：当前时间点往后 120 秒 (2 分钟)
const WINDOW_AHEAD_MS = 120_000;
// 触发下一批后台静默预取的剩余时间阈值：低于 45 秒立即续订
const BUFFER_TRIGGER_THRESHOLD_MS = 45_000;
// 批次发送大小：每次发送 30 句，兼顾网络效率与请求频次
const BATCH_SIZE = 30;

export type SubtitleChangeListener = (activeCue: SubtitleCue | null) => void;

export class SubtitleScheduler {
  private cues: SubtitleCue[] = [];
  private targetLang: TargetLanguage = 'zh-CN';
  private isTranslating = false;
  private pendingWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCue: SubtitleCue | null = null;
  private listeners: Set<SubtitleChangeListener> = new Set();
  private translationCache = new Map<string, string>(); // originalText -> translatedText
  private currentEpoch = 0;

  constructor(targetLang: TargetLanguage = 'zh-CN') {
    this.targetLang = targetLang;
  }

  /**
   * 载入新解析的字幕列表，初始化时间轴
   */
  public loadCues(cues: SubtitleCue[], targetLang?: TargetLanguage): void {
    this.currentEpoch++;
    this.cues = cues.sort((a, b) => a.startMs - b.startMs);
    if (targetLang) {
      if (this.targetLang !== targetLang) {
        this.translationCache.clear();
        for (const cue of this.cues) {
          delete cue.translatedText;
        }
      }
      this.targetLang = targetLang;
    }
    this.activeCue = null;
    this.isTranslating = false;

    // 预填已有内存缓存
    for (const cue of this.cues) {
      if (this.translationCache.has(cue.originalText)) {
        cue.translatedText = this.translationCache.get(cue.originalText);
      }
    }
  }

  /**
   * 是否已载入有效字幕轨道
   */
  public hasCues(): boolean {
    return this.cues.length > 0;
  }

  /**
   * 获取当前字幕条目总数
   */
  public getCueCount(): number {
    return this.cues.length;
  }

  /**
   * 获取已载入的完整句子字幕列表
   */
  public getCues(): SubtitleCue[] {
    return this.cues;
  }

  /**
   * 注册字幕变动监听器（当时间推进或新译文返回时通知 Overlay 重新渲染）
   */
  public subscribe(listener: SubtitleChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(cue: SubtitleCue | null): void {
    this.listeners.forEach((fn) => {
      try {
        fn(cue);
      } catch (err) {
        console.error('[TranslateKing Subtitle] 监听器回调异常:', err);
      }
    });
  }

  /**
   * 基于二分查找在 O(logN) 时间内检索给定播放时间点所落入的 SubtitleCue
   */
  public findCueAt(timeMs: number): SubtitleCue | null {
    if (this.cues.length === 0) return null;

    let low = 0;
    let high = this.cues.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = this.cues[mid];

      if (timeMs >= cue.startMs && timeMs <= cue.endMs) {
        return cue;
      } else if (timeMs < cue.startMs) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return null;
  }

  /**
   * 视频播放高频时间更新入口 (timeupdate / rAF)
   */
  public onTimeUpdate(currentTimeMs: number): void {
    const matched = this.findCueAt(currentTimeMs);

    if (matched !== this.activeCue) {
      this.activeCue = matched;
      this.notify(this.activeCue);
    }

    // 检查滑动窗口是否需要预取
    this.checkAndScheduleWindow(currentTimeMs);
  }

  /**
   * 用户拖动进度条 (Seek) 跳转
   */
  public onSeek(newTimeMs: number): void {
    this.currentEpoch++;
    this.activeCue = this.findCueAt(newTimeMs);
    this.notify(this.activeCue);

    // 立即发起新时间点附近的高优插队预翻译
    this.triggerWindowTranslation(newTimeMs, true);
  }

  /**
   * 检查当前播放点后方的已翻译库存，按需触发滑动窗口预翻译
   */
  private checkAndScheduleWindow(currentTimeMs: number): void {
    if (this.isTranslating) return;

    // 寻找在 [currentTimeMs, currentTimeMs + WINDOW_AHEAD_MS] 范围内第一个尚未翻译的 cue
    const windowEndMs = currentTimeMs + WINDOW_AHEAD_MS;
    let needTranslation = false;

    for (const cue of this.cues) {
      if (cue.startMs > windowEndMs) break;
      if (cue.endMs >= currentTimeMs && !cue.translatedText) {
        needTranslation = true;
        break;
      }
    }

    if (needTranslation) {
      if (this.pendingWindowTimer) clearTimeout(this.pendingWindowTimer);
      this.pendingWindowTimer = setTimeout(() => {
        this.triggerWindowTranslation(currentTimeMs, false);
      }, 50);
    }
  }

  /**
   * 触发滑动窗口批次翻译
   */
  private async triggerWindowTranslation(startTimeMs: number, isPreempt = false): Promise<void> {
    if (this.isTranslating && !isPreempt) return;

    const epoch = this.currentEpoch;
    const windowEndMs = startTimeMs + WINDOW_AHEAD_MS;

    // 筛选当前时间窗口内未翻译的 cues (最多取 BATCH_SIZE 句)
    const uncachedCues: SubtitleCue[] = [];
    for (const cue of this.cues) {
      if (cue.startMs > windowEndMs) break;
      if (cue.endMs >= startTimeMs && !cue.translatedText) {
        uncachedCues.push(cue);
        if (uncachedCues.length >= BATCH_SIZE) break;
      }
    }

    if (uncachedCues.length === 0) return;

    this.isTranslating = true;
    const texts = uncachedCues.map((c) => c.originalText);

    try {
      const response = await this.sendBatchToGateway(texts, this.targetLang);

      // 若在请求返回期间发生 Seek 切歌或切换视频，丢弃过期批次
      if (this.currentEpoch !== epoch) return;

      if (response && response.translations) {
        response.translations.forEach((trans, idx) => {
          const cue = uncachedCues[idx];
          if (cue && trans && trans.trim() !== '') {
            cue.translatedText = trans;
            this.translationCache.set(cue.originalText, trans);
          }
        });

        // 若当前正处于视野内的 activeCue 刚被翻译回来，立即刷新上屏
        if (this.activeCue && uncachedCues.includes(this.activeCue)) {
          this.notify(this.activeCue);
        }
      }
    } catch (err) {
      console.warn('[TranslateKing Subtitle] 滑动窗口字幕翻译异常:', err);
    } finally {
      this.isTranslating = false;
    }
  }

  /**
   * 与后台翻译网关通信
   */
  private sendBatchToGateway(texts: string[], toLang: TargetLanguage): Promise<TranslateBatchResponse> {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        return resolve({ translations: texts });
      }

      chrome.runtime.sendMessage(
        {
          type: 'TRANSLATE_BATCH',
          texts,
          toLang
        },
        (res: TranslateBatchResponse) => {
          if (chrome.runtime.lastError) {
            resolve({ translations: texts });
          } else {
            resolve(res || { translations: texts });
          }
        }
      );
    });
  }

  /**
   * 清理状态与缓存
   */
  public destroy(): void {
    this.currentEpoch++;
    if (this.pendingWindowTimer) clearTimeout(this.pendingWindowTimer);
    this.listeners.clear();
    this.cues = [];
    this.activeCue = null;
    this.isTranslating = false;
  }
}
