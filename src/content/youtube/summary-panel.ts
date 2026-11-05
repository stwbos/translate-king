/**
 * 翻译王 (TranslateKing) - YouTube 视频总结与带时间戳双语文字稿面板
 *
 * 核心特性：
 * 1. 100% 纯原生 DOM API 构建 (零 .innerHTML)，完美兼容 YouTube TrustedTypes CSP 安全策略
 * 2. 全时长覆盖算法 (适配 5 分钟短视频至 3+ 小时超长视频)：
 *    - 动态计算视频总跨度 (00:00 至结尾)，自动均分为 ~24 个时间轴章节要点，绝不因前几分钟字数达标而提前截断！
 *    - 完整双语文字稿自动聚合为连贯可读的 ~18 秒时间轴段落，100% 展示从 00:00 到 3 小时结尾的全部内容，并支持滚动视口优先翻译与后台全量渐进翻译
 * 3. 时间戳双向联动：点击任意 [MM:SS] / [H:MM:SS] 时间戳徽章直接跳转到对应视频秒数并播放
 * 4. 一键复制完整带时间戳双语/原文文字稿
 */

import { TargetLanguage } from '../../types';
import { SubtitleCue, YouTubeCaptionTrack } from './types';
import {
  extractCaptionTracksFromDom,
  selectBestEnglishTrack,
  fetchAndParseSubtitles,
  parseSubtitlePayload,
  cleanRawText
} from './extractor';
import { createTranslateKingLogoElement } from '../logo';

export interface SummarySection {
  startMs: number;
  endMs: number;
  timestampStr: string;
  originalSummary: string;
  translatedSummary: string;
}

// 缓存完整视频字幕流，并与当前 videoId 强绑定，杜绝 SPA 切视频时串台显示旧视频总结！
let cachedInterceptedCues: SubtitleCue[] = [];
let cachedInterceptedVideoId: string | null = null;
let cachedFetchedCues: SubtitleCue[] = [];
let cachedVideoId: string | null = null;
let liveObservedCues: SubtitleCue[] = [];
let liveObservedVideoId: string | null = null;
const latestBridgeTracks = new Map<string, YouTubeCaptionTrack[]>();

export function getLiveVideoIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('v');
    if (v) return v;

    const ytMatch = window.location.pathname.match(/\/(?:shorts|live|embed|v)\/([a-zA-Z0-9_-]+)/);
    if (ytMatch) return ytMatch[1];

    const host = window.location.hostname || '';
    if (host.includes('bilibili.com')) {
      const bvidMatch = window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+|av\d+)/i);
      const p = params.get('p') || '1';
      return bvidMatch ? `${bvidMatch[1]}_p${p}` : null;
    }

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      return null;
    }

    // 针对通用视频平台（Coursera / Udemy / TED / Vimeo 等），仅在具有明确非根路径且非 YouTube 播放器环境时返回路径标识
    if (window.location.pathname && window.location.pathname !== '/') {
      return `${host}${window.location.pathname}${window.location.search}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 实时记录播放过程中由各平台字幕观察器捕获的字幕行（供无独立字幕轨接口的平台生成时间轴总结与导出 SRT）
 */
export function recordObservedVideoCue(
  originalText: string,
  translatedText?: string,
  currentTimeSec?: number
): void {
  const cleaned = cleanRawText(originalText);
  if (!cleaned) return;
  const vid = getLiveVideoIdFromUrl();
  if (vid && liveObservedVideoId && vid !== liveObservedVideoId) {
    liveObservedCues = [];
  }
  liveObservedVideoId = vid;

  if (liveObservedCues.length > 0 && liveObservedCues[liveObservedCues.length - 1].originalText === cleaned) {
    if (translatedText && !liveObservedCues[liveObservedCues.length - 1].translatedText) {
      liveObservedCues[liveObservedCues.length - 1].translatedText = translatedText;
    }
    return;
  }

  let startMs = 0;
  if (typeof currentTimeSec === 'number' && !isNaN(currentTimeSec)) {
    startMs = Math.max(0, Math.round(currentTimeSec * 1000));
  } else if (typeof document !== 'undefined') {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (video && typeof video.currentTime === 'number' && !isNaN(video.currentTime) && video.currentTime > 0) {
      startMs = Math.max(0, Math.round(video.currentTime * 1000));
    } else if (liveObservedCues.length > 0) {
      startMs = liveObservedCues[liveObservedCues.length - 1].endMs;
    }
  }

  if (liveObservedCues.length > 0) {
    const prev = liveObservedCues[liveObservedCues.length - 1];
    if (startMs > prev.startMs && startMs < prev.endMs) {
      prev.endMs = startMs;
    }
  }

  liveObservedCues.push({
    id: liveObservedCues.length + 1,
    startMs,
    endMs: startMs + 4000,
    originalText: cleaned,
    translatedText
  });
}

function extractVideoIdFromTimedTextUrl(rawUrl?: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const m = rawUrl.match(/[?&]v=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * 识别并拦截 B站未签名接口 (/x/player/v2) 返回的反爬蜜罐假字幕（固定为“我的名字是亚历克斯 我二十二岁 现在我必须独自抚养孩子”故事）
 */
export function isBiliHoneyPotRawText(text: string): boolean {
  if (!text) return false;
  return /亚历克斯|独自抚养孩子|我二十二岁.*抚养|大学教授有了外遇/.test(text);
}

export function isBiliHoneyPotCues(cues: SubtitleCue[]): boolean {
  if (!cues || cues.length === 0) return false;
  const sample = cues
    .slice(0, 8)
    .map((c) => c.originalText)
    .join(' ');
  return isBiliHoneyPotRawText(sample);
}

/**
 * 判断文本是否已经以中文为主（用于在目标语言为 zh-CN/zh-TW 时避免将中文字幕二次重复机翻并展示两遍相同中文）
 */
function isPredominantlyChinese(text: string): boolean {
  if (!text) return false;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (cjk < 4) return false;
  const foreignWords = (text.match(/[a-zA-Z]{2,}/g) || []).length;
  return cjk >= foreignWords * 2;
}

function isNearDuplicateText(a: string, b: string): boolean {
  const cleanA = a.replace(/[\s\p{P}]/gu, '').toLowerCase();
  const cleanB = b.replace(/[\s\p{P}]/gu, '').toLowerCase();
  if (!cleanA || !cleanB) return true;
  if (cleanA === cleanB) return true;
  if (isPredominantlyChinese(a) && isPredominantlyChinese(b)) {
    return true;
  }
  return false;
}

const interceptedListeners = new Set<(cues: SubtitleCue[]) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (!e.data) return;

    if (e.data.type === 'TK_YT_CAPTIONS_READY' && Array.isArray(e.data.tracks)) {
      const vid = e.data.videoId || getLiveVideoIdFromUrl();
      if (vid) {
        latestBridgeTracks.set(vid, e.data.tracks);
      }
      return;
    }

    if (e.data.type === 'TK_YT_INTERCEPTED_TIMEDTEXT' && typeof e.data.body === 'string') {
      if (isBiliHoneyPotRawText(e.data.body)) {
        return;
      }
      const liveVid = getLiveVideoIdFromUrl();
      const payloadVid = e.data.videoId || extractVideoIdFromTimedTextUrl(e.data.url) || liveVid;
      // 严格拦截非当前视频的延迟返回字幕包，彻底消灭切视频串台 Bug
      if (liveVid && payloadVid && payloadVid !== liveVid) {
        return;
      }
      const isAsr = typeof e.data.url === 'string' && e.data.url.includes('kind=asr');
      const parsed = parseSubtitlePayload(e.data.body, isAsr);
      if (parsed.length > 0 && !isBiliHoneyPotCues(parsed)) {
        cachedInterceptedCues = parsed;
        cachedInterceptedVideoId = payloadVid;
        interceptedListeners.forEach((cb) => cb(parsed));
      }
    }
  });
}

export function getSharedVideoCues(): SubtitleCue[] {
  const liveVid = getLiveVideoIdFromUrl();
  if (
    cachedInterceptedCues.length > 0 &&
    (!liveVid || !cachedInterceptedVideoId || cachedInterceptedVideoId === liveVid)
  ) {
    return cachedInterceptedCues;
  }
  if (cachedFetchedCues.length > 0 && (!liveVid || !cachedVideoId || cachedVideoId === liveVid)) {
    return cachedFetchedCues;
  }
  if (liveObservedCues.length > 0 && (!liveVid || !liveObservedVideoId || liveObservedVideoId === liveVid)) {
    return liveObservedCues;
  }
  return [];
}

/**
 * 语言切换时彻底清空字幕共享缓存中的旧语言译文，防止串台或无法更新到新语言
 */
export function clearSharedCueTranslations(): void {
  for (const c of cachedInterceptedCues) {
    delete c.translatedText;
  }
  for (const c of cachedFetchedCues) {
    delete c.translatedText;
  }
  for (const c of liveObservedCues) {
    delete c.translatedText;
  }
}

/**
 * 彻底重置共享字幕缓存（主要用于切视频或单测环境清理）
 */
export function clearAllSharedVideoCues(): void {
  cachedInterceptedCues = [];
  cachedInterceptedVideoId = null;
  cachedFetchedCues = [];
  cachedVideoId = null;
  liveObservedCues = [];
  liveObservedVideoId = null;
}

export async function preloadSharedVideoCues(videoId: string | null): Promise<SubtitleCue[]> {
  const targetVid = videoId || getLiveVideoIdFromUrl();
  if (targetVid !== cachedVideoId) {
    cachedVideoId = targetVid;
    cachedFetchedCues = [];
    if (cachedInterceptedVideoId !== targetVid) {
      cachedInterceptedCues = [];
      cachedInterceptedVideoId = null;
    }
  }
  if (cachedInterceptedCues.length > 0 && (!targetVid || cachedInterceptedVideoId === targetVid)) {
    return cachedInterceptedCues;
  }
  if (cachedFetchedCues.length > 0 && (!targetVid || cachedVideoId === targetVid)) {
    return cachedFetchedCues;
  }

  // 优先使用 yt-bridge 从 MAIN 世界 movie_player.getPlayerResponse() 实时同步的当前视频 tracks
  let tracks: YouTubeCaptionTrack[] | null = targetVid ? latestBridgeTracks.get(targetVid) || null : null;
  if (!tracks && typeof document !== 'undefined') {
    tracks = extractCaptionTracksFromDom(document, targetVid);
  }

  if (tracks && tracks.length > 0) {
    const best = selectBestEnglishTrack(tracks);
    if (best) {
      const fetched = await fetchAndParseSubtitles(best);
      if (fetched.length > 0) {
        cachedFetchedCues = fetched;
        cachedVideoId = targetVid;
        return fetched;
      }
    }
  }
  return [];
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function parseTimestampToMs(str: string): number {
  const parts = str
    .trim()
    .split(':')
    .map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 3) {
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }
  if (parts.length === 2) {
    return (parts[0] * 60 + parts[1]) * 1000;
  }
  return 0;
}

/**
 * 将细碎的 SubtitleCue 列表按视频全长动态切分为完整覆盖 00:00 ~ 结尾的结构化章节要点
 * 彻底修复 3 小时视频只显示前 4 分钟总结的问题！
 */
export function groupCuesIntoSections(cues: SubtitleCue[], targetSectionCount = 24): SummarySection[] {
  if (!cues || cues.length === 0) return [];

  // 若输入已经是预划分好的结构化时间轴章节 (如 B站简介知识点大纲、YouTube 章节看点，段数 <= targetSectionCount 且每段跨度 >= 10s)，直接保留 1:1 章节
  if (cues.length <= targetSectionCount && cues.every((c) => c.endMs - c.startMs >= 10000)) {
    return cues.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      timestampStr: formatTimestamp(c.startMs),
      originalSummary: c.originalText,
      translatedSummary: c.translatedText || ''
    }));
  }

  const firstStartMs = cues[0].startMs;
  const lastEndMs = Math.max(cues[cues.length - 1].endMs, cues[cues.length - 1].startMs + 5000);
  const totalDurationMs = Math.max(1, lastEndMs - firstStartMs);

  // 动态计算每个章节覆盖的时间窗口：最短 60 秒，长视频（如 3 小时 = 10800 秒）自动按 ~24 段均分（每段约 7.5 分钟），100% 覆盖到最后一分钟
  const dynamicWindowMs = Math.max(60000, Math.ceil(totalDurationMs / targetSectionCount));

  const sections: SummarySection[] = [];
  let bucketStartMs = cues[0].startMs;
  let bucketEndMs = cues[0].endMs;
  let bucketTexts: string[] = [];

  const flushBucket = () => {
    if (bucketTexts.length === 0) return;
    const joined = bucketTexts.join(' ').replace(/\s+/g, ' ').trim();
    // 从该时间窗口（如 7 分钟）内均匀抽取核心代表句，保证摘要涵盖该段首中尾重点且单段长度适中可极速翻译
    let concise = joined;
    if (joined.length > 320) {
      const sentences = joined.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
      if (sentences.length >= 3) {
        const first = sentences[0];
        const mid = sentences[Math.floor(sentences.length / 2)];
        const last = sentences[sentences.length - 1];
        concise = `${first} ${mid} ${last}`.slice(0, 340);
      } else {
        concise = `${joined.slice(0, 330)}...`;
      }
    }

    sections.push({
      startMs: bucketStartMs,
      endMs: bucketEndMs,
      timestampStr: formatTimestamp(bucketStartMs),
      originalSummary: concise,
      translatedSummary: ''
    });
    bucketTexts = [];
  };

  for (const cue of cues) {
    if (bucketTexts.length === 0) {
      bucketStartMs = cue.startMs;
    }
    bucketEndMs = Math.max(bucketEndMs, cue.endMs);
    bucketTexts.push(cue.originalText);

    // 严格依据时间跨度切分，绝不因为字符满 240 字就提前断章导致长视频被截断
    if (cue.endMs - bucketStartMs >= dynamicWindowMs) {
      flushBucket();
    }
  }
  flushBucket();

  return sections;
}

/**
 * 将细碎的逐句 SubtitleCue 聚合为 ~18 秒一段的连贯文字稿段落，
 * 既能让 3 小时视频的完整文字稿 100% 流畅渲染到底（无 8 分钟截断），又让上下文翻译更准确！
 */
export function mergeCuesIntoTranscriptParagraphs(cues: SubtitleCue[], paragraphWindowMs = 18000): SubtitleCue[] {
  if (!cues || cues.length === 0) return [];
  if (cues.length <= 80) return cues.map((c) => ({ ...c }));

  const merged: SubtitleCue[] = [];
  let startMs = cues[0].startMs;
  let endMs = cues[0].endMs;
  let texts: string[] = [];
  let id = 1;

  const flush = () => {
    if (texts.length === 0) return;
    merged.push({
      id: id++,
      startMs,
      endMs,
      originalText: texts.join(' ').replace(/\s+/g, ' ').trim()
    });
    texts = [];
  };

  for (const cue of cues) {
    if (texts.length === 0) {
      startMs = cue.startMs;
    }
    endMs = Math.max(endMs, cue.endMs);
    texts.push(cue.originalText);

    if (cue.endMs - startMs >= paragraphWindowMs || texts.join(' ').length >= 260) {
      flush();
    }
  }
  flush();

  return merged;
}

/**
 * 从文本描述或章节列表中解析带时间戳 (如 00:00 章节名、05:38 知识点) 的章节为 SubtitleCue 列表
 */
export function parseTimestampChaptersFromText(text: string, totalDurationMs = 600000): SubtitleCue[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const rawChapters: Array<{ startMs: number; text: string }> = [];
  const seenStarts = new Set<number>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(?:[-*•]\s*)?(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/);
    if (m) {
      const startMs = parseTimestampToMs(m[1]);
      const content = m[2].trim();
      if (content && !seenStarts.has(startMs)) {
        seenStarts.add(startMs);
        rawChapters.push({ startMs, text: content });
      }
    }
  }

  if (rawChapters.length === 0) return [];
  rawChapters.sort((a, b) => a.startMs - b.startMs);

  return rawChapters.map((ch, idx) => {
    const nextStart =
      idx + 1 < rawChapters.length
        ? rawChapters[idx + 1].startMs
        : Math.max(ch.startMs + 60000, totalDurationMs);
    return {
      id: idx + 1,
      startMs: ch.startMs,
      endMs: Math.max(ch.startMs + 5000, nextStart),
      originalText: ch.text
    };
  });
}

export class YouTubeSummaryPanel {
  private panelEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private activeTab: 'summary' | 'transcript' = 'summary';
  private rawCues: SubtitleCue[] = [];
  private transcriptParagraphs: SubtitleCue[] = [];
  private sections: SummarySection[] = [];
  private isLoading = false;
  private currentVideoId: string | null = null;
  private targetLang: TargetLanguage;
  private translationEpoch = 0;

  constructor(targetLang: TargetLanguage = 'zh-CN') {
    this.targetLang = targetLang;
    interceptedListeners.add((newCues) => {
      if (
        this.panelEl &&
        document.body.contains(this.panelEl) &&
        this.panelEl.style.display !== 'none' &&
        !this.isLoading &&
        newCues.length > this.rawCues.length
      ) {
        this.rawCues = [];
        this.sections = [];
        this.transcriptParagraphs = [];
        this.loadAndSummarize();
      }
    });
  }

  public setTargetLang(lang: TargetLanguage): void {
    if (this.targetLang !== lang) {
      this.targetLang = lang;
      this.translationEpoch++;
      this.transcriptParagraphs = [];
      this.sections = [];
      clearSharedCueTranslations();
    }
  }

  public resetForNewVideo(videoId: string | null): void {
    if (videoId !== this.currentVideoId) {
      this.currentVideoId = videoId;
      this.translationEpoch++;
      this.rawCues = [];
      this.transcriptParagraphs = [];
      this.sections = [];
      if (cachedInterceptedVideoId !== videoId) {
        cachedInterceptedCues = [];
        cachedInterceptedVideoId = null;
      }
      if (cachedVideoId !== videoId) {
        cachedFetchedCues = [];
        cachedVideoId = videoId;
      }
      this.isLoading = false;
      if (this.panelEl) {
        this.panelEl.remove();
        this.panelEl = null;
      }
      const existingDomPanel = typeof document !== 'undefined' ? document.getElementById('translate-king-yt-summary-panel') : null;
      if (existingDomPanel) {
        existingDomPanel.remove();
      }
    }
  }

  public togglePanel(): void {
    const liveVid = getLiveVideoIdFromUrl();
    if (liveVid !== this.currentVideoId) {
      this.resetForNewVideo(liveVid);
    }

    if (this.panelEl && document.body.contains(this.panelEl)) {
      if (this.panelEl.style.display === 'none') {
        this.panelEl.style.display = 'flex';
        if (this.sections.length === 0 && !this.isLoading) {
          this.loadAndSummarize();
        }
      } else {
        this.panelEl.style.display = 'none';
      }
      return;
    }

    this.mountPanel();
    this.loadAndSummarize();
  }

  private mountPanel(): void {
    const existing = document.getElementById('translate-king-yt-summary-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'translate-king-yt-summary-panel';
    panel.setAttribute('translate', 'no');
    panel.setAttribute('data-tk-ignore', 'true');
    panel.style.cssText = `
      position: relative !important;
      display: flex !important;
      flex-direction: column !important;
      width: 100% !important;
      max-height: 560px !important;
      margin: 0 0 16px 0 !important;
      background: linear-gradient(180deg, #0f1d3a 0%, #091122 100%) !important;
      color: #f8fafc !important;
      border: 1px solid rgba(59, 130, 246, 0.45) !important;
      border-radius: 14px !important;
      box-shadow: 0 12px 32px rgba(2, 6, 23, 0.65), 0 0 0 1px rgba(59, 130, 246, 0.15) !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
      z-index: 2147483640 !important;
      pointer-events: auto !important;
    `;

    // 阻止宿主页面（如 B站右栏或通用播放器外层）吞噬点击与滚轮事件，保证总结面板 100% 可交互
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('mouseup', (e) => e.stopPropagation());
    panel.addEventListener('dblclick', (e) => e.stopPropagation());
    panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    const isBili = typeof window !== 'undefined' && (window.location.hostname || '').includes('bilibili.com');
    const biliDanmakuBox = isBili
      ? (document.querySelector('#danmukuBox') || document.querySelector('.danmaku-box'))
      : null;
    const biliUpPanel = isBili
      ? (document.querySelector('.up-panel-container') || document.querySelector('.right-container-inner > .up-info-container'))
      : null;

    const secondaryInner =
      document.querySelector('#secondary #secondary-inner') ||
      document.querySelector('ytd-watch-flexy #secondary') ||
      document.querySelector('.right-container-inner') ||
      document.querySelector('.right-container') ||
      document.querySelector('#below') ||
      document.querySelector('#primary-inner');

    if (biliDanmakuBox && biliDanmakuBox.parentElement) {
      // 在 B站挂载于弹幕列表正上方（UP主信息卡片下方），与视频播放器顶边平齐，彻底避开顶部固定导航栏遮挡
      biliDanmakuBox.parentElement.insertBefore(panel, biliDanmakuBox);
    } else if (biliUpPanel && biliUpPanel.parentElement) {
      biliUpPanel.parentElement.insertBefore(panel, biliUpPanel.nextSibling);
    } else if (secondaryInner && secondaryInner.firstChild) {
      secondaryInner.insertBefore(panel, secondaryInner.firstChild);
    } else if (secondaryInner) {
      secondaryInner.appendChild(panel);
    } else {
      panel.style.position = 'fixed';
      panel.style.right = '20px';
      panel.style.top = '72px';
      panel.style.width = '400px';
      panel.style.zIndex = '2147483645';
      document.body.appendChild(panel);
    }

    this.panelEl = panel;
    this.renderPanel();
  }

  private clearElement(el: HTMLElement): void {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  private seekToMs(ms: number): void {
    const sec = Math.max(0, ms / 1000);
    if (typeof window !== 'undefined') {
      try {
        window.postMessage({ type: 'TK_SEEK_TO_SECONDS', seconds: sec }, '*');
      } catch (_) {}
    }
    const video = document.querySelector(
      '#movie_player video, video.html5-main-video, .bpx-player-video-wrap video, .bpx-player-video-wrap bwp-video, .bilibili-player-video video, video, bwp-video'
    ) as HTMLVideoElement | null;
    if (video) {
      try {
        video.currentTime = sec;
        if (typeof video.play === 'function') {
          video.play().catch(() => {});
        }
      } catch (_) {}
    }
  }

  private closeNativeEngagementPanels(): void {
    try {
      const panels = document.querySelectorAll(
        'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'
      );
      panels.forEach((panel) => {
        const targetId = panel.getAttribute('target-id') || '';
        if (targetId.includes('transcript') || targetId.includes('macro-markers')) {
          const closeBtn = panel.querySelector('#visibility-button button, button[aria-label*="关闭"], button[aria-label*="Close" i]') as HTMLElement | null;
          if (closeBtn) {
            closeBtn.click();
          } else {
            panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
          }
        }
      });
    } catch (_) {}
  }

  private parseTimestampChaptersFromText(text: string, totalDurationMs = 600000): SubtitleCue[] {
    return parseTimestampChaptersFromText(text, totalDurationMs);
  }

  /**
   * 从浏览器 Performance Resource Timing 中直接查找 B站播放器已加载的真实 AI/CC 字幕 URL 或带合法 WBI 签名的 player/wbi/v2 接口
   */
  private async tryRecoverBiliSubtitleFromPerformance(targetVid: string | null): Promise<SubtitleCue[]> {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function' || typeof fetch !== 'function') {
      return [];
    }
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      // 1. 直接匹配 B站播放器已请求的 aisubtitle.hdslb.com / bfs/subtitle JSON URL
      for (let i = entries.length - 1; i >= 0; i--) {
        const entryUrl = entries[i]?.name || '';
        if (
          entryUrl.includes('aisubtitle.hdslb.com') ||
          entryUrl.includes('/bfs/subtitle/') ||
          entryUrl.includes('/bfs/ai_subtitle/')
        ) {
          try {
            const subRes = await fetch(entryUrl);
            if (subRes.ok) {
              const subText = await subRes.text();
              if (!isBiliHoneyPotRawText(subText)) {
                const parsed = parseSubtitlePayload(subText, false);
                if (parsed.length > 0 && !isBiliHoneyPotCues(parsed)) {
                  cachedFetchedCues = parsed;
                  cachedVideoId = targetVid;
                  return parsed;
                }
              }
            }
          } catch (_) {}
        }
      }

      // 2. 匹配 B站前端自身已带 w_rid 签名的 /x/player/wbi/v2 请求
      for (let i = entries.length - 1; i >= 0; i--) {
        const entryUrl = entries[i]?.name || '';
        if (entryUrl.includes('/x/player/wbi/v2') && entryUrl.includes('w_rid=')) {
          try {
            const wbiRes = await fetch(entryUrl, { credentials: 'include' });
            if (wbiRes.ok) {
              const wbiJson = await wbiRes.json();
              const subs = wbiJson?.data?.subtitle?.subtitles;
              if (Array.isArray(subs) && subs.length > 0) {
                for (const sub of subs) {
                  if (!sub?.subtitle_url) continue;
                  const subUrl = sub.subtitle_url.startsWith('//')
                    ? `https:${sub.subtitle_url}`
                    : sub.subtitle_url.replace(/^http:\/\//i, 'https://');
                  try {
                    const subRes = await fetch(subUrl);
                    if (subRes.ok) {
                      const subText = await subRes.text();
                      if (!isBiliHoneyPotRawText(subText)) {
                        const parsed = parseSubtitlePayload(subText, false);
                        if (parsed.length > 0 && !isBiliHoneyPotCues(parsed)) {
                          cachedFetchedCues = parsed;
                          cachedVideoId = targetVid;
                          return parsed;
                        }
                      }
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    return [];
  }

  /**
   * 哔哩哔哩 (Bilibili) 专属多通道字幕与时间轴章节提取引擎：
   * 1. 优先读取 yt-bridge 或 Performance Resource Timing 中 B站播放器自身携带合法签名加载的 aisubtitle / wbi 字幕轨（彻底杜绝未签名 /x/player/v2 的反爬假字幕蜜罐！）
   * 2. B站官方 view 接口公開 CC 字幕与高能看点分段 (view_points)
   * 3. UP主视频简介 (desc) 中的时间轴知识点大纲 (如 00:00 🔨简单雕刻入门...)
   * 4. 实时播放已捕获字幕 (liveObservedCues) 与视频简介段落保底
   */
  private async extractBilibiliVideoCues(): Promise<SubtitleCue[]> {
    const targetVid = getLiveVideoIdFromUrl() || this.currentVideoId;
    if (
      cachedInterceptedCues.length > 0 &&
      (!targetVid || !cachedInterceptedVideoId || cachedInterceptedVideoId === targetVid) &&
      !isBiliHoneyPotCues(cachedInterceptedCues)
    ) {
      return cachedInterceptedCues;
    }
    if (
      cachedFetchedCues.length > 0 &&
      (!targetVid || cachedVideoId === targetVid) &&
      !isBiliHoneyPotCues(cachedFetchedCues)
    ) {
      return cachedFetchedCues;
    }

    // 主动唤醒 yt-bridge 并尝试从 Performance 记录中恢复 B站播放器已加载的真实 AI/CC 字幕
    for (let attempt = 0; attempt < 3; attempt++) {
      if (typeof window !== 'undefined') {
        try {
          window.postMessage({ type: 'TK_REQUEST_YT_TRACKS' }, '*');
        } catch (_) {}
      }
      const perfCues = await this.tryRecoverBiliSubtitleFromPerformance(targetVid);
      if (perfCues.length > 0) {
        return perfCues;
      }
      if (
        cachedInterceptedCues.length > 0 &&
        (!targetVid || !cachedInterceptedVideoId || cachedInterceptedVideoId === targetVid) &&
        !isBiliHoneyPotCues(cachedInterceptedCues)
      ) {
        return cachedInterceptedCues;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 180));
      }
    }

    let apiTitle = '';
    let apiDesc = '';
    let durationMs = 300000;
    const videoEl = document.querySelector('video') as HTMLVideoElement | null;
    if (videoEl && videoEl.duration && !isNaN(videoEl.duration) && isFinite(videoEl.duration)) {
      durationMs = Math.round(videoEl.duration * 1000);
    }

    const bvidMatch =
      typeof window !== 'undefined' ? window.location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i) : null;
    const bvid = bvidMatch ? bvidMatch[1] : null;
    const pageNum =
      typeof window !== 'undefined'
        ? Math.max(1, parseInt(new URLSearchParams(window.location.search).get('p') || '1', 10) || 1)
        : 1;

    if (bvid && typeof fetch === 'function') {
      try {
        const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
          credentials: 'include'
        });
        if (viewRes.ok) {
          const viewJson = await viewRes.json();
          const vData = viewJson?.data;
          if (vData) {
            apiTitle = vData.title || '';
            apiDesc = vData.desc || '';
            const pages = Array.isArray(vData.pages) ? vData.pages : [];
            const activePage = pages[pageNum - 1] || pages[0];
            if (activePage?.duration || vData.duration) {
              durationMs = Math.round((activePage?.duration || vData.duration) * 1000);
            }

            const candidateSubtitles: Array<{ subtitle_url?: string }> = [];
            if (Array.isArray(vData.subtitle?.list)) {
              candidateSubtitles.push(...vData.subtitle.list);
            }

            for (const sub of candidateSubtitles) {
              if (!sub?.subtitle_url) continue;
              const subUrl = sub.subtitle_url.startsWith('//')
                ? `https:${sub.subtitle_url}`
                : sub.subtitle_url.replace(/^http:\/\//i, 'https://');
              try {
                const subRes = await fetch(subUrl);
                if (subRes.ok) {
                  const subText = await subRes.text();
                  if (!isBiliHoneyPotRawText(subText)) {
                    const parsed = parseSubtitlePayload(subText, false);
                    if (parsed.length > 0 && !isBiliHoneyPotCues(parsed)) {
                      cachedFetchedCues = parsed;
                      cachedVideoId = targetVid;
                      return parsed;
                    }
                  }
                }
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // 通道 B2：解析 UP主视频简介 (API desc 或 DOM 简介节点) 中的时间轴知识点章节
    const domDescEl = document.querySelector(
      '.desc-info-text, .basic-desc-info, #v_desc, .video-desc-container'
    );
    const combinedDesc = apiDesc || domDescEl?.textContent || '';
    const descChapters = this.parseTimestampChaptersFromText(combinedDesc, durationMs);
    if (descChapters.length > 0) {
      cachedFetchedCues = descChapters;
      cachedVideoId = targetVid;
      return descChapters;
    }

    // 通道 B3：检查播放过程中实时捕获的字幕流
    if (liveObservedCues.length > 0 && (!targetVid || !liveObservedVideoId || liveObservedVideoId === targetVid)) {
      return liveObservedCues;
    }

    // 通道 B4：基于视频标题与简介段落生成结构化概览
    const domTitleEl = document.querySelector('h1.video-title, .video-info-title, h1');
    const finalTitle = (apiTitle || domTitleEl?.textContent || document.title || '')
      .replace(/_哔哩哔哩_bilibili$/i, '')
      .trim();
    const fallbackCues: SubtitleCue[] = [];
    const descParagraphs = combinedDesc
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 6 && !/^https?:\/\//i.test(l));

    if (finalTitle) {
      fallbackCues.push({
        id: 1,
        startMs: 0,
        endMs: Math.min(60000, durationMs),
        originalText: finalTitle
      });
    }

    if (descParagraphs.length > 0) {
      const stepMs = Math.max(15000, Math.floor(durationMs / Math.max(1, descParagraphs.length)));
      descParagraphs.forEach((para, idx) => {
        const sMs = Math.min(durationMs - 5000, idx * stepMs);
        fallbackCues.push({
          id: fallbackCues.length + 1,
          startMs: Math.max(0, sMs),
          endMs: Math.min(durationMs, sMs + stepMs),
          originalText: para
        });
      });
    }

    return fallbackCues;
  }

  /**
   * 全网通用视频平台 (Coursera / TED / Udemy / Vimeo / 原生 HTML5 Video 等) 字幕与章节提取引擎：
   * 1. 原生 HTML5 <video> textTracks 内存轨道 (VTTCue)
   * 2. <track src="*.vtt|*.srt"> 字幕文件拉取解析
   * 3. 实时观察器已捕获字幕 (liveObservedCues)
   * 4. 页面内时间轴章节与视频描述提取
   */
  private async extractUniversalVideoCues(): Promise<SubtitleCue[]> {
    const targetVid = getLiveVideoIdFromUrl() || this.currentVideoId;
    if (cachedFetchedCues.length > 0 && (!targetVid || cachedVideoId === targetVid)) {
      return cachedFetchedCues;
    }

    // 1. 检查所有 HTML5 <video> 的 textTracks 与 <track> 标签
    const videos = Array.from(document.querySelectorAll('video'));
    for (const video of videos) {
      if (video.textTracks && video.textTracks.length > 0) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (track.mode === 'disabled') {
            try {
              track.mode = 'hidden';
            } catch (_) {}
          }
          if (track.cues && track.cues.length > 0) {
            const cues: SubtitleCue[] = [];
            for (let j = 0; j < track.cues.length; j++) {
              const cue = track.cues[j] as any;
              const text = cleanRawText(String(cue.text || ''));
              if (text) {
                const startMs = Math.round(Number(cue.startTime || 0) * 1000);
                const endMs = Math.max(startMs + 500, Math.round(Number(cue.endTime || (cue.startTime || 0) + 3) * 1000));
                cues.push({ id: cues.length + 1, startMs, endMs, originalText: text });
              }
            }
            if (cues.length > 0) {
              cachedFetchedCues = cues;
              cachedVideoId = targetVid;
              return cues;
            }
          }
        }
      }

      const trackEls = Array.from(video.querySelectorAll('track'));
      for (const trackEl of trackEls) {
        const src = trackEl.getAttribute('src') || trackEl.src;
        if (src && typeof fetch === 'function') {
          try {
            const res = await fetch(src);
            if (res.ok) {
              const raw = await res.text();
              const parsed = parseSubtitlePayload(raw, false);
              if (parsed.length > 0) {
                cachedFetchedCues = parsed;
                cachedVideoId = targetVid;
                return parsed;
              }
            }
          } catch (_) {}
        }
      }
    }

    // 2. 检查实时捕获的字幕流
    if (liveObservedCues.length > 0) {
      return liveObservedCues;
    }

    // 3. 提取页面内转录文本段或带时间戳章节
    const durationMs =
      videos[0]?.duration && !isNaN(videos[0].duration) && isFinite(videos[0].duration)
        ? Math.round(videos[0].duration * 1000)
        : 300000;
    const bodyText = document.body?.innerText || document.body?.textContent || '';
    const chapters = this.parseTimestampChaptersFromText(bodyText, durationMs);
    if (chapters.length > 0) {
      return chapters;
    }

    const titleText = (document.querySelector('h1')?.textContent || document.title || '').trim();
    const metaDesc =
      (document.querySelector('meta[name="description"], meta[property="og:description"]') as HTMLMetaElement | null)
        ?.content || '';
    if (titleText) {
      return [
        {
          id: 1,
          startMs: 0,
          endMs: Math.min(60000, durationMs),
          originalText: metaDesc ? `${titleText} — ${metaDesc.slice(0, 200)}` : titleText
        }
      ];
    }

    return [];
  }

  private async extractVideoCues(): Promise<SubtitleCue[]> {
    this.closeNativeEngagementPanels();
    const host = typeof window !== 'undefined' ? window.location.hostname || '' : '';

    if (host.includes('bilibili.com')) {
      return this.extractBilibiliVideoCues();
    }

    if (!host.includes('youtube.com') && !host.includes('youtu.be')) {
      return this.extractUniversalVideoCues();
    }

    const targetVid = getLiveVideoIdFromUrl() || this.currentVideoId;

    // 主动向 yt-bridge 索取当前视频真实 timedtext 字幕流与最新 captionTracks (最多重试 3 次等待新视频播放器初始化)
    for (let retry = 0; retry < 3; retry++) {
      if (
        cachedInterceptedCues.length > 0 &&
        (!targetVid || !cachedInterceptedVideoId || cachedInterceptedVideoId === targetVid)
      ) {
        return cachedInterceptedCues;
      }

      if (typeof window !== 'undefined') {
        try {
          window.postMessage({ type: 'TK_REQUEST_YT_TRACKS' }, '*');
          await new Promise((r) => setTimeout(r, 180));
        } catch (_) {}
      }

      if (
        cachedInterceptedCues.length > 0 &&
        (!targetVid || !cachedInterceptedVideoId || cachedInterceptedVideoId === targetVid)
      ) {
        return cachedInterceptedCues;
      }

      // 通道 1：尝试通过当前视频的 captionTracks 拉取字幕
      const preloaded = await preloadSharedVideoCues(targetVid);
      if (preloaded.length > 0) {
        return preloaded;
      }
    }

    // 通道 2：仅当页面中已有现成的 ytd-transcript-segment-renderer 时静默读取，绝不主动点击按钮弹出“在此视频中”白框！
    const readDomTranscriptSegments = (): SubtitleCue[] => {
      const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
      const list: SubtitleCue[] = [];
      let id = 1;
      segs.forEach((seg) => {
        const timeEl = seg.querySelector('.segment-timestamp');
        const textEl = seg.querySelector('.segment-text');
        const rawTime = (timeEl?.textContent || '').trim();
        const rawText = cleanRawText(textEl?.textContent || '');
        if (rawText) {
          const startMs = parseTimestampToMs(rawTime);
          list.push({
            id: id++,
            startMs,
            endMs: startMs + 4000,
            originalText: rawText
          });
        }
      });
      return list;
    };

    const domCues = readDomTranscriptSegments();
    if (domCues.length > 0) {
      this.closeNativeEngagementPanels();
      return domCues;
    }

    // 通道 3：提取 YouTube 原生章节时间轴 (ytd-macro-markers-list-item-renderer) + 视频简介核心说明
    const fallbackCues: SubtitleCue[] = [];
    const titleEl = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, #title h1');
    const titleText = (titleEl?.textContent || document.title || '').replace(/- YouTube$/, '').trim();
    const descEl = document.querySelector('#description-inline-expander, ytd-text-inline-expander, #description');
    const descText = (descEl?.textContent || '').replace(/\s+/g, ' ').trim();

    if (titleText) {
      const introSummary = descText ? `${titleText} — ${descText.slice(0, 180)}` : titleText;
      fallbackCues.push({
        id: 1,
        startMs: 0,
        endMs: 15000,
        originalText: introSummary
      });
    }

    const chapterItems = document.querySelectorAll('ytd-macro-markers-list-item-renderer');
    const seenChapterTimes = new Set<number>();
    chapterItems.forEach((item) => {
      const chTitle = (item.querySelector('h4, h3, #details h4')?.textContent || '').trim();
      const chTime = (item.querySelector('#time, .macro-markers')?.textContent || '').trim();
      if (chTitle && chTime) {
        const startMs = parseTimestampToMs(chTime);
        if (!seenChapterTimes.has(startMs)) {
          seenChapterTimes.add(startMs);
          fallbackCues.push({
            id: fallbackCues.length + 1,
            startMs,
            endMs: startMs + 95000,
            originalText: chTitle
          });
        }
      }
    });

    if (fallbackCues.length > 0) {
      return fallbackCues;
    }

    return this.extractUniversalVideoCues();
  }

  private translateBatchTexts(texts: string[]): Promise<string[]> {
    return new Promise((resolve) => {
      if (texts.length === 0) {
        resolve([]);
        return;
      }
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(texts);
        return;
      }
      try {
        chrome.runtime.sendMessage(
          {
            type: 'TRANSLATE_BATCH',
            texts,
            toLang: this.targetLang
          },
          (res: { translations?: string[] } | undefined) => {
            if (chrome.runtime.lastError || !res || !res.translations) {
              resolve(texts);
              return;
            }
            resolve(res.translations);
          }
        );
      } catch {
        resolve(texts);
      }
    });
  }

  public async loadAndSummarize(): Promise<void> {
    const liveVid = getLiveVideoIdFromUrl();
    if (liveVid !== this.currentVideoId) {
      this.currentVideoId = liveVid;
      this.rawCues = [];
      this.transcriptParagraphs = [];
      this.sections = [];
      this.isLoading = false;
    }
    if (this.isLoading) return;
    this.isLoading = true;
    const epoch = ++this.translationEpoch;
    this.renderPanel();

    try {
      const extracted = await this.extractVideoCues();
      if (epoch !== this.translationEpoch) return;

      this.rawCues = extracted;
      // 1. 生成覆盖视频全长 (00:00 ~ 结尾) 的 ~24 个章节总结
      this.sections = groupCuesIntoSections(extracted, 24);
      // 2. 生成覆盖视频全长 (00:00 ~ 结尾) 的连贯双语文字稿段落（无截断）
      this.transcriptParagraphs = mergeCuesIntoTranscriptParagraphs(extracted, 18000);

      if (this.sections.length > 0) {
        const isChineseTarget = this.targetLang === 'zh-CN' || this.targetLang === 'zh-TW';
        const allAlreadyChinese =
          isChineseTarget &&
          this.sections.every((s) => isPredominantlyChinese(s.originalSummary));

        if (allAlreadyChinese) {
          this.sections.forEach((sec) => {
            sec.translatedSummary = sec.originalSummary;
          });
        } else {
          const sourceTexts = this.sections.map((s) => s.originalSummary);
          const translated = await this.translateBatchTexts(sourceTexts);
          if (epoch !== this.translationEpoch) return;
          this.sections.forEach((sec, idx) => {
            sec.translatedSummary = translated[idx] || sec.originalSummary;
          });
        }
      }
    } catch (err) {
      console.warn('[TranslateKing Summary] 提取视频总结异常:', err);
    } finally {
      if (epoch === this.translationEpoch) {
        this.isLoading = false;
        this.renderPanel();
        // 后台渐进式全量翻译整个视频的文字稿段落（支持 3 小时超长视频全量双语）
        this.translateAllTranscriptParagraphsProgressively(epoch);
      }
    }
  }

  /**
   * 渐进式后台批量翻译全部文字稿段落（从 00:00 到视频结尾，每批 25 段），并实时无感更新 DOM 节点
   */
  private async translateAllTranscriptParagraphsProgressively(epoch: number): Promise<void> {
    const isChineseTarget = this.targetLang === 'zh-CN' || this.targetLang === 'zh-TW';
    const BATCH_SIZE = 25;
    for (let i = 0; i < this.transcriptParagraphs.length; i += BATCH_SIZE) {
      if (epoch !== this.translationEpoch) return;
      const chunk = this.transcriptParagraphs
        .slice(i, i + BATCH_SIZE)
        .filter((c) => !c.translatedText && !(isChineseTarget && isPredominantlyChinese(c.originalText)));
      if (chunk.length === 0) continue;

      const texts = chunk.map((c) => c.originalText);
      const translations = await this.translateBatchTexts(texts);
      if (epoch !== this.translationEpoch) return;

      chunk.forEach((cue, idx) => {
        cue.translatedText = translations[idx] || '';
        // 若当前正处于文字稿 Tab，实时将译文填入对应 DOM 行，无需重绘整个滚动容器
        if (this.panelEl && this.activeTab === 'transcript') {
          const zhEl = this.panelEl.querySelector(`[data-tk-cue-zh="${cue.id}"]`) as HTMLElement | null;
          if (zhEl && cue.translatedText) {
            zhEl.textContent = cue.translatedText;
            zhEl.style.display = 'block';
          }
        }
      });

      await new Promise((r) => setTimeout(r, 40));
    }
  }

  private copyFullTranscript(btn: HTMLElement): void {
    const lines: string[] = [];
    const titleEl = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, #title h1');
    const titleText = (titleEl?.textContent || document.title || '').trim();
    lines.push(`# ${titleText}`);
    lines.push(`链接: ${window.location.href}`);
    lines.push('');

    if (this.sections.length > 0) {
      lines.push('## 📌 视频全时间轴中文总结');
      for (const sec of this.sections) {
        lines.push(`[${sec.timestampStr} - ${formatTimestamp(sec.endMs)}] ${sec.translatedSummary || sec.originalSummary}`);
      }
      lines.push('');
    }

    const sourceList = this.transcriptParagraphs.length > 0 ? this.transcriptParagraphs : this.rawCues;
    if (sourceList.length > 0) {
      lines.push('## 📜 完整时间戳双语文字稿 (Full Transcript)');
      for (const cue of sourceList) {
        const ts = formatTimestamp(cue.startMs);
        const zh = cue.translatedText ? `\n[${ts} 中文] ${cue.translatedText}` : '';
        lines.push(`[${ts}] ${cue.originalText}${zh}`);
      }
    }

    const fullText = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullText).then(() => {
        const prev = btn.textContent;
        btn.textContent = '✅ 已复制完整内容';
        setTimeout(() => {
          btn.textContent = prev || '📋 复制全文';
        }, 1800);
      }).catch(() => {});
    }
  }

  private renderPanel(): void {
    if (!this.panelEl) return;
    this.clearElement(this.panelEl);

    // 1. 顶部标题栏（翻译王宝石蓝主题色 + 品牌 Logo）
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 12px 14px !important;
      background: linear-gradient(135deg, rgba(30, 64, 175, 0.52) 0%, rgba(37, 99, 235, 0.28) 55%, rgba(15, 23, 42, 0.95) 100%) !important;
      border-bottom: 1px solid rgba(59, 130, 246, 0.28) !important;
    `;

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display: flex !important; align-items: center !important; gap: 7px !important; font-weight: 700 !important; font-size: 14px !important; color: #EFF6FF !important;';
    const totalSpanStr =
      this.rawCues.length > 0
        ? ` (00:00 ~ ${formatTimestamp(this.rawCues[this.rawCues.length - 1].endMs)})`
        : '';
    const headerLogo = createTranslateKingLogoElement(18, 'summary-header');
    const headerText = document.createElement('span');
    headerText.style.cssText = 'color: #EFF6FF !important;';
    headerText.textContent = `视频时间轴总结${totalSpanStr}`;
    titleWrap.appendChild(headerLogo);
    titleWrap.appendChild(headerText);

    const headerActions = document.createElement('div');
    headerActions.style.cssText = 'display: flex !important; align-items: center !important; gap: 6px !important;';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.style.cssText = `
      background: rgba(37, 99, 235, 0.24) !important;
      color: #DBEAFE !important;
      border: 1px solid rgba(59, 130, 246, 0.42) !important;
      border-radius: 6px !important;
      padding: 4px 8px !important;
      font-size: 12px !important;
      cursor: pointer !important;
    `;
    refreshBtn.textContent = '🔄 刷新';
    refreshBtn.title = '重新提取视频字幕并刷新总结';
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cachedFetchedCues = [];
      this.rawCues = [];
      this.sections = [];
      this.transcriptParagraphs = [];
      this.loadAndSummarize();
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.style.cssText = `
      background: rgba(37, 99, 235, 0.24) !important;
      color: #DBEAFE !important;
      border: 1px solid rgba(59, 130, 246, 0.42) !important;
      border-radius: 6px !important;
      padding: 4px 8px !important;
      font-size: 12px !important;
      cursor: pointer !important;
    `;
    copyBtn.textContent = '📋 复制全文';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.copyFullTranscript(copyBtn);
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.style.cssText = `
      background: transparent !important;
      color: #93C5FD !important;
      border: none !important;
      font-size: 15px !important;
      cursor: pointer !important;
      padding: 2px 6px !important;
    `;
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.panelEl) this.panelEl.style.display = 'none';
    });

    headerActions.appendChild(refreshBtn);
    headerActions.appendChild(copyBtn);
    headerActions.appendChild(closeBtn);
    header.appendChild(titleWrap);
    header.appendChild(headerActions);
    this.panelEl.appendChild(header);

    // 2. Tab 切换栏
    const tabBar = document.createElement('div');
    tabBar.style.cssText = `
      display: flex !important;
      border-bottom: 1px solid rgba(59, 130, 246, 0.2) !important;
      background: rgba(15, 23, 42, 0.78) !important;
    `;

    const createTabBtn = (key: 'summary' | 'transcript', label: string) => {
      const btn = document.createElement('button');
      const isActive = this.activeTab === key;
      btn.style.cssText = `
        flex: 1 !important;
        padding: 9px 10px !important;
        font-size: 13px !important;
        font-weight: ${isActive ? '700' : '500'} !important;
        color: ${isActive ? '#60A5FA' : '#94a3b8'} !important;
        background: ${isActive ? 'rgba(37, 99, 235, 0.18)' : 'transparent'} !important;
        border: none !important;
        border-bottom: 2px solid ${isActive ? '#3B82F6' : 'transparent'} !important;
        cursor: pointer !important;
      `;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.activeTab = key;
        this.renderPanel();
      });
      return btn;
    };

    tabBar.appendChild(createTabBtn('summary', `📌 全程时间轴总结 (${this.sections.length}段)`));
    tabBar.appendChild(createTabBtn('transcript', `📜 完整双语文字稿 (${this.transcriptParagraphs.length}段)`));
    this.panelEl.appendChild(tabBar);

    // 3. 内容滚动区
    const body = document.createElement('div');
    this.bodyEl = body;
    body.style.cssText = `
      padding: 12px 14px !important;
      overflow-y: auto !important;
      max-height: 440px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 10px !important;
      font-size: 13px !important;
      line-height: 1.55 !important;
    `;

    if (this.isLoading) {
      const loadingEl = document.createElement('div');
      loadingEl.style.cssText = 'padding: 24px 12px !important; text-align: center !important; color: #93C5FD !important;';
      loadingEl.textContent = '⏳ 正在提取全视频时间轴字幕并生成全程中文总结...';
      body.appendChild(loadingEl);
    } else if (this.activeTab === 'summary') {
      if (this.sections.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.style.cssText = 'padding: 18px !important; text-align: center !important; color: #94a3b8 !important;';
        emptyEl.textContent = '暂未检测到字幕轨道，请开启视频 CC 字幕后点击重试。';
        body.appendChild(emptyEl);
      } else {
        for (const sec of this.sections) {
          const card = document.createElement('div');
          card.style.cssText = `
            padding: 10px 12px !important;
            background: linear-gradient(135deg, rgba(30, 58, 138, 0.28), rgba(15, 23, 42, 0.85)) !important;
            border: 1px solid rgba(59, 130, 246, 0.22) !important;
            border-radius: 10px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 5px !important;
          `;

          const topRow = document.createElement('div');
          topRow.style.cssText = 'display: flex !important; align-items: center !important; gap: 8px !important;';

          const timeBadge = document.createElement('button');
          timeBadge.style.cssText = `
            background: rgba(37, 99, 235, 0.25) !important;
            color: #93C5FD !important;
            border: 1px solid rgba(59, 130, 246, 0.45) !important;
            border-radius: 6px !important;
            padding: 2px 7px !important;
            font-size: 12px !important;
            font-weight: 700 !important;
            font-family: monospace !important;
            cursor: pointer !important;
          `;
          timeBadge.textContent = `▶ ${sec.timestampStr} - ${formatTimestamp(sec.endMs)}`;
          timeBadge.title = '点击跳转到该视频时间点';
          timeBadge.addEventListener('click', () => this.seekToMs(sec.startMs));

          topRow.appendChild(timeBadge);
          card.appendChild(topRow);

          const primarySummary = (sec.translatedSummary || sec.originalSummary).trim();
          const zhLine = document.createElement('div');
          zhLine.style.cssText = 'color: #f8fafc !important; font-weight: 600 !important; font-size: 13.5px !important;';
          zhLine.textContent = primarySummary;
          card.appendChild(zhLine);

          if (sec.originalSummary && !isNearDuplicateText(sec.originalSummary, primarySummary)) {
            const enLine = document.createElement('div');
            enLine.style.cssText = 'color: #94a3b8 !important; font-size: 12px !important;';
            enLine.textContent = sec.originalSummary;
            card.appendChild(enLine);
          }

          body.appendChild(card);
        }
      }
    } else {
      // 100% 渲染全视频所有时间轴文字稿段落（从 00:00 到 3 小时结尾，无截断！）
      for (const cue of this.transcriptParagraphs) {
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex !important;
          align-items: flex-start !important;
          gap: 8px !important;
          padding: 7px 8px !important;
          border-bottom: 1px solid rgba(59, 130, 246, 0.12) !important;
        `;

        const tsBtn = document.createElement('button');
        tsBtn.style.cssText = `
          flex-shrink: 0 !important;
          background: rgba(37, 99, 235, 0.22) !important;
          color: #60a5fa !important;
          border: 1px solid rgba(59, 130, 246, 0.3) !important;
          border-radius: 4px !important;
          padding: 2px 6px !important;
          font-size: 11px !important;
          font-family: monospace !important;
          cursor: pointer !important;
        `;
        tsBtn.textContent = formatTimestamp(cue.startMs);
        tsBtn.title = '点击跳转到该时间点';
        tsBtn.addEventListener('click', () => this.seekToMs(cue.startMs));

        const textCol = document.createElement('div');
        textCol.style.cssText = 'display: flex !important; flex-direction: column !important; gap: 3px !important; flex: 1 !important;';

        const enSpan = document.createElement('div');
        enSpan.style.cssText = 'color: #e2e8f0 !important; font-size: 12.5px !important;';
        enSpan.textContent = cue.originalText;
        textCol.appendChild(enSpan);

        const hasDistinctTranslation =
          Boolean(cue.translatedText) && cue.translatedText!.trim() !== cue.originalText.trim();
        const zhSpan = document.createElement('div');
        zhSpan.setAttribute('data-tk-cue-zh', String(cue.id));
        zhSpan.style.cssText = `
          color: #93C5FD !important;
          font-size: 12.5px !important;
          font-weight: 500 !important;
          display: ${hasDistinctTranslation ? 'block' : 'none'} !important;
        `;
        zhSpan.textContent = hasDistinctTranslation ? cue.translatedText || '' : '';
        textCol.appendChild(zhSpan);

        row.appendChild(tsBtn);
        row.appendChild(textCol);
        body.appendChild(row);
      }
    }

    this.panelEl.appendChild(body);
  }
}
