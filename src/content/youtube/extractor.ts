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
// 单句字幕最长展示时长：超过 5.5 秒强行断句，避免屏幕文字长时间不切换
const MAX_CUE_DURATION_MS = 5500;
// 单句最大单词量阈值：防止说话人不带标点连珠炮说话导致单句挤满三行
const MAX_WORDS_PER_CUE = 18;

interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
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
        endMs: wordEnd
      });
    }
  }

  if (rawWords.length === 0) return [];

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
 * YouTube XML 格式字幕解析器 (兼容 <transcript><text start="1.5" dur="2.0">...</text></transcript>)
 */
export function parseXmlToCues(xmlText: string): SubtitleCue[] {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const cues: SubtitleCue[] = [];
  let cueId = 1;

  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
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

  // 跨平台或 Node/JSDOM 测试环境正则保底解析
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

  if (trimmed.startsWith('<') || trimmed.includes('<text')) {
    return parseXmlToCues(trimmed);
  }

  return [];
}

/**
 * 统一字幕事件解析入口（自动区分人工字幕与 ASR 语音识别字幕）
 */
export function parseJson3EventsToCues(
  events: TimedTextJson3Event[],
  isAsr = false
): SubtitleCue[] {
  return isAsr ? mergeAsrSubtitles(events) : parseHumanCcSubtitles(events);
}

/**
 * 直接从 DOM 中的页面脚本 (document.scripts) 中同步提取 captionTracks
 * 突破 Chrome MV3 沙箱限制与播放器初始化延迟，0 毫秒同步命中！
 */
export function extractCaptionTracksFromDom(doc: Document = document): YouTubeCaptionTrack[] | null {
  if (!doc || !doc.scripts) return null;

  for (let i = 0; i < doc.scripts.length; i++) {
    const s = doc.scripts[i];
    const text = s.textContent || '';
    if (text.includes('"captionTracks":')) {
      const match = text.match(/"captionTracks":\s*(\[.+?\])/);
      if (match) {
        try {
          const cleaned = match[1].replace(/\\u0026/g, '&');
          const tracks = JSON.parse(cleaned);
          if (Array.isArray(tracks) && tracks.length > 0) {
            return tracks;
          }
        } catch (_) {
          try {
            const tracks = JSON.parse(match[1]);
            if (Array.isArray(tracks) && tracks.length > 0) {
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
