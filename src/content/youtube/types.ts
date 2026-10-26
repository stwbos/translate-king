/**
 * 翻译王 (TranslateKing) - YouTube 双语字幕核心类型定义
 */

export interface YouTubeCaptionTrack {
  baseUrl: string;
  name: { simpleText?: string; runs?: Array<{ text: string }> };
  vssId: string;
  languageCode: string;
  kind?: string; // 'asr' 为语音识别自动生成字幕，无该属性通常为官方人工字幕
  isTranslatable: boolean;
}

export interface TimedTextJson3Seg {
  utf8: string;
  tOffsetMs?: number;
  acAsrConf?: number;
}

export interface TimedTextJson3Event {
  tStartMs: number;
  dDurationMs: number;
  wWinId?: number;
  segs?: TimedTextJson3Seg[];
  aAppend?: number;
}

export interface TimedTextJson3Response {
  wireMagic?: string;
  events?: TimedTextJson3Event[];
}

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  originalText: string;
  translatedText?: string;
}
