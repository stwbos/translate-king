import { describe, it, expect } from 'vitest';
import {
  cleanRawText,
  hasSentenceTerminalPunctuation,
  mergeAsrSubtitles,
  parseHumanCcSubtitles,
  selectBestEnglishTrack,
  normalizeTimedTextUrl,
  extractCaptionTracksFromDom
} from '../src/content/youtube/extractor';
import { YouTubeCaptionTrack, TimedTextJson3Event } from '../src/content/youtube/types';

describe('YouTube 字幕嗅探与 ASR 断句重组 (YouTube Extractor & Sentence Merger)', () => {
  it('应当正确清洗 [Music]、[Applause] 及音符杂质', () => {
    expect(cleanRawText('[Music] Welcome back to the channel! [Applause]')).toBe('Welcome back to the channel!');
    expect(cleanRawText('♪ Here is a song ♪')).toBe('Here is a song');
  });

  it('应当准确判定句子终结标点符号', () => {
    expect(hasSentenceTerminalPunctuation('world.')).toBe(true);
    expect(hasSentenceTerminalPunctuation('really?!')).toBe(true);
    expect(hasSentenceTerminalPunctuation('yes...')).toBe(true);
    expect(hasSentenceTerminalPunctuation('said "hello."')).toBe(true);
    expect(hasSentenceTerminalPunctuation('world,')).toBe(false);
    expect(hasSentenceTerminalPunctuation('hello')).toBe(false);
  });

  it('URL 规整器必须强制包含 fmt=json3 参数', () => {
    const raw = 'https://www.youtube.com/api/timedtext?v=abc1234&lang=en';
    const normalized = normalizeTimedTextUrl(raw);
    expect(normalized).toContain('fmt=json3');
    expect(normalized).toContain('lang=en');
  });

  it('应当优先选拔官方人工英文字幕，再降级选拔 ASR 语音识别字幕', () => {
    const tracks: YouTubeCaptionTrack[] = [
      {
        baseUrl: 'https://youtube.com/timedtext?1',
        name: { simpleText: 'Spanish' },
        vssId: '.es',
        languageCode: 'es',
        isTranslatable: true
      },
      {
        baseUrl: 'https://youtube.com/timedtext?2',
        name: { simpleText: 'English (auto-generated)' },
        vssId: 'a.en',
        languageCode: 'en',
        kind: 'asr',
        isTranslatable: true
      },
      {
        baseUrl: 'https://youtube.com/timedtext?3',
        name: { simpleText: 'English' },
        vssId: '.en',
        languageCode: 'en',
        isTranslatable: true
      }
    ];

    const best = selectBestEnglishTrack(tracks);
    expect(best).not.toBeNull();
    expect(best?.baseUrl).toBe('https://youtube.com/timedtext?3');
    expect(best?.kind).toBeUndefined();

    // 如果没有人工英文字幕，降级选取 ASR
    const withoutHuman = tracks.slice(0, 2);
    const bestAsr = selectBestEnglishTrack(withoutHuman);
    expect(bestAsr?.baseUrl).toBe('https://youtube.com/timedtext?2');
    expect(bestAsr?.kind).toBe('asr');
  });

  it('人工 CC 字幕解析应当保持原有完整句子排版', () => {
    const events: TimedTextJson3Event[] = [
      {
        tStartMs: 1000,
        dDurationMs: 2500,
        segs: [{ utf8: 'Hello world, this is a clean sentence.' }]
      },
      {
        tStartMs: 4000,
        dDurationMs: 2000,
        segs: [{ utf8: 'And here is the second sentence.' }]
      }
    ];

    const cues = parseHumanCcSubtitles(events);
    expect(cues).toHaveLength(2);
    expect(cues[0].originalText).toBe('Hello world, this is a clean sentence.');
    expect(cues[0].startMs).toBe(1000);
    expect(cues[0].endMs).toBe(3500);

    expect(cues[1].originalText).toBe('And here is the second sentence.');
    expect(cues[1].startMs).toBe(4000);
    expect(cues[1].endMs).toBe(6000);
  });

  it('核心考验：ASR 极其碎裂的词流应当被 Sentence Merger 合并为完整语义单句', () => {
    // 模拟 YouTube ASR 语音识别返回的微小词流片段 (一句话被切成很多 seg)
    const asrEvents: TimedTextJson3Event[] = [
      {
        tStartMs: 1000,
        dDurationMs: 1500,
        segs: [
          { utf8: 'Today', tOffsetMs: 0 },
          { utf8: ' we', tOffsetMs: 300 },
          { utf8: ' are', tOffsetMs: 600 },
          { utf8: ' introducing', tOffsetMs: 900 }
        ]
      },
      {
        tStartMs: 2500,
        dDurationMs: 1800,
        segs: [
          { utf8: ' a', tOffsetMs: 0 },
          { utf8: ' brand', tOffsetMs: 300 },
          { utf8: ' new', tOffsetMs: 600 },
          { utf8: ' architecture.', tOffsetMs: 900 } // 此处有句号，应当触发断句！
        ]
      },
      {
        tStartMs: 5000, // 距离上一句结束超过 500ms（长时间停顿）
        dDurationMs: 1200,
        segs: [
          { utf8: 'Let', tOffsetMs: 0 },
          { utf8: ' us', tOffsetMs: 300 },
          { utf8: ' begin', tOffsetMs: 600 }
        ]
      }
    ];

    const cues = mergeAsrSubtitles(asrEvents);
    expect(cues).toHaveLength(2);

    // 第一句应当被完整拼接为完整句子，而不是破碎的两个词
    expect(cues[0].originalText).toBe('Today we are introducing a brand new architecture.');
    expect(cues[0].startMs).toBe(1000);
    // 第一句结束时间应当覆盖到最后的 architecture 词
    expect(cues[0].endMs).toBeGreaterThanOrEqual(3400);

    // 第二句经过长时间停顿后独立成句
    expect(cues[1].originalText).toBe('Let us begin');
    expect(cues[1].startMs).toBe(5000);
  });

  it('能直接从 document.scripts 中毫秒级提取 captionTracks', () => {
    const mockDoc = {
      scripts: [
        { textContent: 'console.log("nothing here");' },
        {
          textContent:
            'var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://youtube.com/timedtext?v=test","vssId":".en","languageCode":"en"}]}}};'
        }
      ]
    } as any;

    const tracks = extractCaptionTracksFromDom(mockDoc);
    expect(tracks).not.toBeNull();
    expect(tracks).toHaveLength(1);
    expect(tracks![0].languageCode).toBe('en');
  });
});
