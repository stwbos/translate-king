/**
 * 翻译王 (TranslateKing) 词典与语境服务
 * 集成网易有道 100ms 极速免翻墙词典 + 多级网关原句翻译
 */

import { translateBatch } from './translator';
import { TargetLanguage } from '../types';

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
 * 同时支持英汉 (EC) 与汉英 (CE/CE_NEW) 双向词典及网络释义
 */
async function fetchYoudaoWord(word: string): Promise<{ phonetic: string; meaning: string } | null> {
  try {
    const clean = word.trim();
    const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(clean)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();

    let phonetic = '';
    let meaning = '';

    // 1. 提取音标 (英文 usphone / ukphone) 或 拼音 (中文 phone)
    const sw = data.simple?.word?.[0];
    if (sw) {
      if (sw.usphone) phonetic = `/${sw.usphone}/`;
      else if (sw.ukphone) phonetic = `/${sw.ukphone}/`;
      else if (sw.phone) phonetic = `[${sw.phone}]`;
    }
    if (!phonetic && data.ce_new?.word?.[0]?.phone) {
      phonetic = `[${data.ce_new.word[0].phone}]`;
    }

    // 2. 英文 -> 中文 释义 (EC)
    const ecTrs = data.ec?.word?.[0]?.trs;
    if (Array.isArray(ecTrs)) {
      meaning = ecTrs
        .map((t: { tr?: Array<{ l?: { i?: string[] } }> }) => t.tr?.[0]?.l?.i?.join('；') || '')
        .filter(Boolean)
        .join('； ');
    }

    // 3. 中文 -> 英文 释义 (CE_NEW / CE)
    if (!meaning) {
      const ceNewTrs = data.ce_new?.word?.[0]?.trs;
      if (Array.isArray(ceNewTrs)) {
        meaning = ceNewTrs
          .map((t: { tr?: Array<{ l?: { i?: string[] } }> }) => {
            const arr = t.tr?.[0]?.l?.i;
            return Array.isArray(arr) ? arr.join('；') : '';
          })
          .filter(Boolean)
          .join('； ');
      }
    }

    // 4. 网络释义兜底 (web_trans)
    if (!meaning && Array.isArray(data.web_trans?.['web-translation'])) {
      meaning = data.web_trans['web-translation']
        .slice(0, 3)
        .map((item: { trans?: Array<{ value?: string }> }) => item.trans?.[0]?.value)
        .filter(Boolean)
        .join('; ');
    }

    return (phonetic || meaning) ? { phonetic, meaning } : null;
  } catch (err) {
    console.warn('[TranslateKing] Youdao dictionary fetch error:', err);
    return null;
  }
}

/**
 * 综合查词解析：词典释义 + 原句双语对照 (支持中英双向智能互译)
 */
export async function lookupWord(
  word: string,
  sentence: string,
  targetLang?: TargetLanguage
): Promise<WordLookupResult> {
  const clean = word.trim();
  const isChinese = /[\u4e00-\u9fa5]/.test(clean);

  // 智能推断有效目标语言：若源文本为中文，默认翻成英文 (en)；若为英文/外文，默认翻成中文 (zh-CN)
  let effectiveTargetLang: TargetLanguage = targetLang || (isChinese ? 'en' : 'zh-CN');
  if (isChinese && (effectiveTargetLang === 'zh-CN' || effectiveTargetLang === 'zh-TW')) {
    effectiveTargetLang = 'en';
  }

  const cacheKey = `${clean.toLowerCase()}:::${sentence.trim()}:::${effectiveTargetLang}`;

  if (wordCache.has(cacheKey)) {
    return wordCache.get(cacheKey)!;
  }

  // 并发查询：有道词典查释义与音标/拼音，多级网关翻译原句语境
  const [dictData, sentenceTransResult] = await Promise.all([
    fetchYoudaoWord(clean),
    sentence && sentence !== clean
      ? translateBatch([sentence], effectiveTargetLang)
      : Promise.resolve({ translations: [''] })
  ]);

  const phonetic = dictData?.phonetic || '';
  let meaning = dictData?.meaning || '';

  // 若词典未收录该生词（如生僻短语、中文复合短语或指定非英文目标语言），调用主力翻译网关
  if (!meaning || (isChinese && effectiveTargetLang !== 'en')) {
    const wordTrans = await translateBatch([clean], effectiveTargetLang);
    const transText = wordTrans.translations[0] || '';
    if (transText) {
      meaning = meaning ? `${meaning} (${transText})` : transText;
    }
  }

  if (!meaning) {
    meaning = '暂无释义';
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
