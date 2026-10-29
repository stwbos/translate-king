/**
 * 翻译王 (TranslateKing) - YouTube 字幕提取器与 ASR 语义断句合并引擎 (Sentence Merger)
 *
 * 核心能力：
 * 1. 播放器内核原生字幕轨道嗅探 (优先官方人工字幕，自适应降级语音识别 ASR)
 * 2. 保证 json3 格式抓取并携带合法参数
 * 3. ASR 碎片化词流合并清洗器 (Sentence Merger)：
 *    - 依据词间停顿阈值 (Pause Gap) 自动切分自然停顿
 *    - 依据句末标点符号 (. ! ?) 与最长字数限制防止字幕跨越过长
 *    - 归一化首尾时间戳，消除 ASR 固有的时间戳交错重叠 Bug
 */

import {
  YouTubeCaptionTrack,
  TimedTextJson3Event,
  TimedTextJson3Response,
  SubtitleCue
} from './types';

// ASR 停顿断句阈值：若两个词之间的空隙超过 450ms，视为说话人自然停顿断句
const ASR_PAUSE_GAP_THRESHOLD_MS = 450;
// 单句字幕最长展示时长：超过 4.5 秒强行断句，避免屏幕文字过长
const MAX_CUE_DURATION_MS = 4500;
// 单句最大单词量阈值：控制在 14 词以内，确保视频画面内 1~2 行舒适排版绝不溢出
const MAX_WORDS_PER_CUE = 14;

interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
  rawEventEndMs?: number;
}

/**
 * 清洗单段原始文本（过滤 YouTube 音效杂音标记，如 [Music]、[Applause]、♪ 等）
 */
export function cleanRawText(text: string): string {
  return text
    .replace(/\[(?:Music|Applause|Laughter|Cheering|Whispering)\]/gi, '')
    .replace(/[♪♫#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 判断单词末尾是否具有强句末标点符号
 */
export function hasSentenceTerminalPunctuation(word: string): boolean {
  return /[.!?。！？…]+["')\]]?$/.test(word.trim());
}

/**
 * ASR 专属语义断句合并算法 (ASR Sentence Merger)
 * 将零碎飞出的逐词 ASR 事件重组为语法连贯、标点规整、时间轴严谨的 SubtitleCue
 */
export function mergeAsrSubtitles(events: TimedTextJson3Event[]): SubtitleCue[] {
  if (!events || events.length === 0) return [];

  // 第一步：打散并平铺为连续带时间戳的词流 (Word Stream)
  const rawWords: RawWord[] = [];

  for (const event of events) {
    if (!event.segs || event.segs.length === 0) continue;
    const baseStart = event.tStartMs;
    const eventDuration = event.dDurationMs || 1000;
    const segCount = event.segs.length;

    for (let i = 0; i < segCount; i++) {
      const seg = event.segs[i];
      const rawWordText = (seg.utf8 || '').trim();
      if (!rawWordText || rawWordText === '\n') continue;

      // 计算单词精确起始与结束时间
      const wordOffset = typeof seg.tOffsetMs === 'number' ? seg.tOffsetMs : 0;
      const wordStart = baseStart + wordOffset;

      // 若有下一个 seg，则当前词的结束时间对齐到下一个词；否则分配事件剩余时长
      let wordEnd = wordStart + 400;
      if (i + 1 < segCount && typeof event.segs[i + 1].tOffsetMs === 'number') {
        const nextOffset = event.segs[i + 1].tOffsetMs!;
        wordEnd = Math.max(wordStart + 100, baseStart + nextOffset);
      } else {
        wordEnd = Math.max(wordStart + 200, baseStart + eventDuration);
      }

      rawWords.push({
        text: rawWordText,
        startMs: wordStart,
        endMs: wordEnd,
        rawEventEndMs: Math.max(wordStart + 200, baseStart + eventDuration)
      });
    }
  }

  if (rawWords.length === 0) return [];

  // 归一化跨 Event 的单词结束时间：
  // YouTube ASR 的 dDurationMs 往往长达 5 秒（包含两行滚动悬停时间），会严重跨入下一个 Event 的起始时间，
  // 导致时间轴重叠以及跨 Event 的自然停顿 (hasLongPause) 失效。此处按后续词起始时间严格裁剪！
  for (let i = 0; i < rawWords.length - 1; i++) {
    const cur = rawWords[i];
    const nxt = rawWords[i + 1];
    const gap = nxt.startMs - cur.startMs;
    if (gap <= 0) {
      cur.endMs = cur.startMs + 80;
    } else if (gap >= 850) {
      // 词间存在明显自然停顿，保留至少 500ms 空隙以触发 ASR_PAUSE_GAP_THRESHOLD_MS 断句
      cur.endMs = Math.min(cur.rawEventEndMs ?? cur.endMs, Math.max(cur.startMs + 250, nxt.startMs - 500));
    } else if (cur.endMs > nxt.startMs) {
      cur.endMs = nxt.startMs;
    }
  }

  // 第二步：根据停顿间隔、标点符号、时长及词数阈值智能聚合重组整句
  const cues: SubtitleCue[] = [];
  let currentSentenceWords: RawWord[] = [];
  let sentenceStartMs = rawWords[0].startMs;
  let cueId = 1;

  const flushSentence = () => {
    if (currentSentenceWords.length === 0) return;

    const fullText = cleanRawText(currentSentenceWords.map((w) => w.text).join(' '));
    if (fullText.length > 0) {
      const lastWord = currentSentenceWords[currentSentenceWords.length - 1];
      const endMs = Math.max(lastWord.endMs, sentenceStartMs + 800);

      cues.push({
        id: cueId++,
        startMs: sentenceStartMs,
        endMs,
        originalText: fullText
      });
    }
    currentSentenceWords = [];
  };

  for (let i = 0; i < rawWords.length; i++) {
    const current = rawWords[i];
    const next = i + 1 < rawWords.length ? rawWords[i + 1] : null;

    if (currentSentenceWords.length === 0) {
      sentenceStartMs = current.startMs;
    }
    currentSentenceWords.push(current);

    const isTerminalPunct = hasSentenceTerminalPunctuation(current.text);
    const hasLongPause = next ? next.startMs - current.endMs >= ASR_PAUSE_GAP_THRESHOLD_MS : false;
    const isDurationExceeded = next ? next.startMs - sentenceStartMs >= MAX_CUE_DURATION_MS : false;
    const isWordCountExceeded = currentSentenceWords.length >= MAX_WORDS_PER_CUE;

    // 触发断句条件：遇到标点、停顿明显、时长过长或词数达标
    if (isTerminalPunct || hasLongPause || isDurationExceeded || isWordCountExceeded || !next) {
      flushSentence();
    }
  }

  flushSentence();

  // 第三步：确保相邻 Cue 时间戳严格递增不重叠，保证 SubtitleScheduler 二分查找 100% 稳定不闪烁
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].endMs > cues[i + 1].startMs) {
      cues[i].endMs = Math.max(cues[i].startMs + 200, cues[i + 1].startMs - 1);
    }
  }

  return cues;
}

/**
 * 官方人工 CC 字幕解析（人工字幕本身具备良好标点与时间戳，仅需规整空段和噪声）
 */
export function parseHumanCcSubtitles(events: TimedTextJson3Event[]): SubtitleCue[] {
  if (!events || events.length === 0) return [];

  const cues: SubtitleCue[] = [];
  let cueId = 1;

  for (const ev of events) {
    if (!ev.segs || ev.segs.length === 0) continue;

    const combined = ev.segs.map((s) => s.utf8 || '').join('');
    const cleaned = cleanRawText(combined);

    if (cleaned.length > 0) {
      const startMs = ev.tStartMs;
      const endMs = Math.max(startMs + (ev.dDurationMs || 1000), startMs + 600);

      cues.push({
        id: cueId++,
        startMs,
        endMs,
        originalText: cleaned
      });
    }
  }

  return cues;
}

/**
 * YouTube XML 格式字幕解析器 (兼容 srv1 <transcript><text start="1.5" dur="2.0">...</text></transcript> 与 srv3 <timedtext><body><p t="1500" d="2000"><s>...</s></p></body></timedtext>)
 */
export function parseXmlToCues(xmlText: string, isAsr = false): SubtitleCue[] {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const cues: SubtitleCue[] = [];
  let cueId = 1;

  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');

      // 1. 优先尝试解析 YouTube 新版 srv3 XML 格式: <p t="1200" d="3500"><s t="150">word</s></p>
      const pNodes = doc.querySelectorAll('p[t]');
      if (pNodes.length > 0) {
        const events: TimedTextJson3Event[] = [];
        let hasWordOffsets = false;
        pNodes.forEach((p) => {
          const tStartMs = parseInt(p.getAttribute('t') || '0', 10);
          const dDurationMs = parseInt(p.getAttribute('d') || '1500', 10);
          const sNodes = p.querySelectorAll('s');
          if (sNodes.length > 0) {
            const segs: { utf8: string; tOffsetMs?: number }[] = [];
            sNodes.forEach((s) => {
              const tAttr = s.getAttribute('t');
              const tOffsetMs = tAttr ? parseInt(tAttr, 10) : 0;
              if (tOffsetMs > 0) hasWordOffsets = true;
              segs.push({
                utf8: s.textContent || '',
                tOffsetMs
              });
            });
            events.push({ tStartMs, dDurationMs, segs });
          } else {
            const raw = p.textContent || '';
            if (raw.trim().length > 0) {
              events.push({
                tStartMs,
                dDurationMs,
                segs: [{ utf8: raw }]
              });
            }
          }
        });
        if (events.length > 0) {
          return parseJson3EventsToCues(events, isAsr || hasWordOffsets);
        }
      }

      // 2. 解析传统 srv1 XML 格式: <text start="1.5" dur="2.0">...</text>
      const textNodes = doc.querySelectorAll('text');
      if (textNodes.length > 0) {
        textNodes.forEach((node) => {
          const startSec = parseFloat(node.getAttribute('start') || '0');
          const durSec = parseFloat(node.getAttribute('dur') || '1');
          const rawText = node.textContent || '';
          const cleaned = cleanRawText(rawText);
          if (cleaned.length > 0) {
            const startMs = Math.round(startSec * 1000);
            const endMs = Math.round((startSec + durSec) * 1000);
            cues.push({
              id: cueId++,
              startMs,
              endMs: Math.max(endMs, startMs + 600),
              originalText: cleaned
            });
          }
        });
        if (cues.length > 0) return cues;
      }
    } catch (_) {}
  }

  // 跨平台或 Node/JSDOM 测试环境正则保底解析 (srv3 <p t="..." d="...">)
  if (xmlText.includes('<p ') && xmlText.includes('t="')) {
    const pTagRegex = /<p\s+[^>]*t="(\d+)"(?:\s+[^>]*d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    const events: TimedTextJson3Event[] = [];
    let hasWordOffsets = false;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pTagRegex.exec(xmlText)) !== null) {
      const tStartMs = parseInt(pMatch[1], 10);
      const dDurationMs = pMatch[2] ? parseInt(pMatch[2], 10) : 1500;
      const inner = pMatch[3];
      const sTagRegex = /<s(?:\s+[^>]*t="(\d+)")?[^>]*>([\s\S]*?)<\/s>/gi;
      const segs: { utf8: string; tOffsetMs?: number }[] = [];
      let sMatch: RegExpExecArray | null;
      while ((sMatch = sTagRegex.exec(inner)) !== null) {
        const tOffsetMs = sMatch[1] ? parseInt(sMatch[1], 10) : 0;
        if (tOffsetMs > 0) hasWordOffsets = true;
        const decoded = sMatch[2]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        segs.push({ utf8: decoded, tOffsetMs });
      }
      if (segs.length > 0) {
        events.push({ tStartMs, dDurationMs, segs });
      } else {
        const stripped = inner
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        if (stripped.trim().length > 0) {
          events.push({ tStartMs, dDurationMs, segs: [{ utf8: stripped }] });
        }
      }
    }
    if (events.length > 0) {
      return parseJson3EventsToCues(events, isAsr || hasWordOffsets);
    }
  }

  // 跨平台或 Node/JSDOM 测试环境正则保底解析 (srv1 <text start="...">)
  const textTagRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textTagRegex.exec(xmlText)) !== null) {
    const startSec = parseFloat(match[1]);
    const durSec = match[2] ? parseFloat(match[2]) : 1;
    const rawText = match[3]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const cleaned = cleanRawText(rawText);
    if (cleaned.length > 0) {
      const startMs = Math.round(startSec * 1000);
      const endMs = Math.round((startSec + durSec) * 1000);
      cues.push({
        id: cueId++,
        startMs,
        endMs: Math.max(endMs, startMs + 600),
        originalText: cleaned
      });
    }
  }

  return cues;
}

/**
 * 统一字幕负载解析器 (自适应解析 json3、json 或 xml 格式字幕流)
 */
export function parseSubtitlePayload(payload: string, isAsr = false): SubtitleCue[] {
  if (!payload || typeof payload !== 'string') return [];
  const trimmed = payload.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const events = data.events || (Array.isArray(data) ? data : []);
      return parseJson3EventsToCues(events, isAsr);
    } catch (_) {}
  }

  if (trimmed.startsWith('<') || trimmed.includes('<text') || trimmed.includes('<p ')) {
    return parseXmlToCues(trimmed, isAsr);
  }

  return [];
}

/**
 * 统一字幕事件解析入口（自动区分人工字幕与 ASR 语音识别逐词字幕）
 */
export function parseJson3EventsToCues(
  events: TimedTextJson3Event[],
  isAsr = false
): SubtitleCue[] {
  if (!events || events.length === 0) return [];
  // 自动探测逐词偏移时间戳 (tOffsetMs > 0) 或 ASR 换行占位的特征，确保所有自动生成语音字幕 100% 聚合为完整长句
  const detectedAsr =
    isAsr ||
    events.some(
      (ev) =>
        Array.isArray(ev.segs) &&
        ev.segs.length > 1 &&
        ev.segs.some((s) => typeof s.tOffsetMs === 'number' && s.tOffsetMs > 0)
    );
  return detectedAsr ? mergeAsrSubtitles(events) : parseHumanCcSubtitles(events);
}

/**
 * 直接从 DOM 中的页面脚本 (document.scripts) 中同步提取 captionTracks
 * 支持传入 expectedVideoId 校验，严防 YouTube SPA 切换视频后误读首个视频残留在 <script> 中的旧字幕轨道！
 */
export function extractCaptionTracksFromDom(
  doc: Document = document,
  expectedVideoId?: string | null
): YouTubeCaptionTrack[] | null {
  if (!doc || !doc.scripts) return null;

  const matchesExpectedVideo = (tracks: YouTubeCaptionTrack[]): boolean => {
    if (!expectedVideoId) return true;
    for (const t of tracks) {
      if (t && typeof t.baseUrl === 'string') {
        const m = t.baseUrl.match(/[?&]v=([a-zA-Z0-9_-]+)/);
        if (m && m[1] && m[1] !== expectedVideoId) {
          return false;
        }
      }
    }
    return true;
  };

  for (let i = 0; i < doc.scripts.length; i++) {
    const s = doc.scripts[i];
    const text = s.textContent || '';
    if (text.includes('"captionTracks":')) {
      if (expectedVideoId && text.includes('"videoId":') && !new RegExp(`"videoId"\\s*:\\s*"${expectedVideoId}"`).test(text)) {
        continue;
      }
      const match = text.match(/"captionTracks":\s*(\[[\s\S]+?\])/);
      if (match) {
        try {
          const cleaned = match[1].replace(/\\u0026/g, '&');
          const tracks = JSON.parse(cleaned);
          if (Array.isArray(tracks) && tracks.length > 0 && matchesExpectedVideo(tracks)) {
            return tracks;
          }
        } catch (_) {
          try {
            const tracks = JSON.parse(match[1]);
            if (Array.isArray(tracks) && tracks.length > 0 && matchesExpectedVideo(tracks)) {
              return tracks;
            }
          } catch (_) {}
        }
      }
    }
  }
  return null;
}

/**
 * 从可用字幕轨道列表中挑出最优先的英文字幕
 * 优先级：
 * 1. 官方人工英文字幕 (kind !== 'asr' && en)
 * 2. ASR 自动生成英文字幕 (kind === 'asr' && en)
 * 3. 任何可翻译的其他语言轨道
 */
export function selectBestEnglishTrack(
  tracks: YouTubeCaptionTrack[]
): YouTubeCaptionTrack | null {
  if (!tracks || tracks.length === 0) return null;

  // 1. 优先人工英文字幕
  const humanEn = tracks.find(
    (t) =>
      t.kind !== 'asr' &&
      (t.languageCode === 'en' || t.languageCode.startsWith('en-') || t.vssId.startsWith('.en'))
  );
  if (humanEn) return humanEn;

  // 2. 其次 ASR 自动生成英文字幕
  const asrEn = tracks.find(
    (t) =>
      t.kind === 'asr' &&
      (t.languageCode === 'en' || t.languageCode.startsWith('en-') || t.vssId.includes('.en'))
  );
  if (asrEn) return asrEn;

  // 3. 任何标注为 en 的轨道
  const anyEn = tracks.find(
    (t) => t.languageCode === 'en' || t.languageCode.startsWith('en-')
  );
  if (anyEn) return anyEn;

  // 4. 退而求其次：第一条可用的主轨道
  return tracks[0] || null;
}

/**
 * 规范化拼接 timedtext 请求地址，强制附加 fmt=json3
 */
export function normalizeTimedTextUrl(rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl, typeof window !== 'undefined' ? window.location.href : 'https://www.youtube.com');
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

/**
 * 远程拉取字幕并解析为标准 SubtitleCue 列表 (具备 0 字节防崩与 XML/JSON 双格式兼容)
 */
export async function fetchAndParseSubtitles(
  track: YouTubeCaptionTrack
): Promise<SubtitleCue[]> {
  try {
    const isAsr = track.kind === 'asr' || (track.vssId ? track.vssId.includes('a.') : false);
    const targetUrl = normalizeTimedTextUrl(track.baseUrl);
    const response = await fetch(targetUrl, {
      headers: {
        Accept: 'application/json, text/xml, */*'
      }
    });

    if (!response.ok) {
      return [];
    }

    const text = await response.text();
    if (!text || text.trim().length === 0) {
      // YouTube 返回 0 字节（因缺少 pot 防爬校验），静默返回空，由 DOM Observer 和 XHR 拦截层无缝接管
      return [];
    }

    return parseSubtitlePayload(text, isAsr);
  } catch (err) {
    console.warn('[TranslateKing YouTube] fetchAndParseSubtitles 异常 (安全降级):', err);
    return [];
  }
}
