/**
 * 翻译王 (TranslateKing) 词典与语境服务
 * 集成网易有道 100ms 极速免翻墙词典 + 多级网关原句翻译
 */

import { translateBatch } from './translator';

export interface WordLookupResult {
  word: string;
  phonetic: string;
  meaning: string;
  sentence: string;
  sentenceTranslation: string;
}

const wordCache = new Map<string, WordLookupResult>();

/**
 * 网易有道极速词典接口 (免翻墙、100~150ms 超低延迟、永不 429)
 */
async function fetchYoudaoWord(word: string): Promise<{ phonetic: string; meaning: string } | null> {
  try {
    const clean = word.trim().toLowerCase();
    const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(clean)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();

    let phonetic = '';
    let meaning = '';

    const sw = data.simple?.word?.[0];
    if (sw) {
      phonetic = sw.usphone ? `/${sw.usphone}/` : (sw.ukphone ? `/${sw.ukphone}/` : '');
    }

    const trs = data.ec?.word?.[0]?.trs;
    if (Array.isArray(trs)) {
      meaning = trs
        .map((t: { tr?: Array<{ l?: { i?: string[] } }> }) => t.tr?.[0]?.l?.i?.join('；') || '')
        .filter(Boolean)
        .join('； ');
    }

    return (phonetic || meaning) ? { phonetic, meaning } : null;
  } catch (err) {
    console.warn('[TranslateKing] Youdao dictionary fetch error:', err);
    return null;
  }
}

/**
 * 综合查词解析：词典释义 + 原句双语对照
 */
export async function lookupWord(word: string, sentence: string): Promise<WordLookupResult> {
  const clean = word.trim();
  const cacheKey = `${clean.toLowerCase()}:::${sentence.trim()}`;

  if (wordCache.has(cacheKey)) {
    return wordCache.get(cacheKey)!;
  }

  // 并发查询：有道词典查单词释义与音标，多级网关翻译原句
  const [dictData, sentenceTransResult] = await Promise.all([
    fetchYoudaoWord(clean),
    sentence && sentence !== clean
      ? translateBatch([sentence], 'zh-CN')
      : Promise.resolve({ translations: [''] })
  ]);

  const phonetic = dictData?.phonetic || '';
  let meaning = dictData?.meaning || '';

  // 若词典未收录该生词（如生僻合成词或短语），降级调用主力网关翻译
  if (!meaning) {
    const wordTrans = await translateBatch([clean], 'zh-CN');
    meaning = wordTrans.translations[0] || '暂无释义';
  }

  const result: WordLookupResult = {
    word: clean,
    phonetic,
    meaning,
    sentence: sentence.trim(),
    sentenceTranslation: sentenceTransResult.translations[0] || ''
  };

  // 写入内存缓存 (最多保留 200 条)
  if (wordCache.size >= 200) {
    const firstKey = wordCache.keys().next().value;
    if (firstKey) wordCache.delete(firstKey);
  }
  wordCache.set(cacheKey, result);

  return result;
}
