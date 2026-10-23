/**
 * 翻译王 (TranslateKing) 核心类型契约
 */

export type TargetLanguage = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru';

export type TranslationMode = 'replace' | 'bilingual';

export type TranslationProviderId = 'microsoft' | 'google' | 'mymemory' | 'openai-compatible';

export interface TranslationConfig {
  provider: TranslationProviderId;
  targetLang: TargetLanguage;
  translationMode: TranslationMode; // 翻译显示模式：直接替换 vs 双语对照
  autoTranslateList: string[]; // 自动翻译域名白名单
  enableSelection: boolean;    // 是否开启鼠标划词查词
  openaiApiUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
}

export interface TranslateBatchRequest {
  type: 'TRANSLATE_BATCH';
  texts: string[];
  fromLang?: string;
  toLang: TargetLanguage;
}

export interface TranslateBatchResponse {
  translations: string[];
  error?: string;
}

export interface TogglePageTranslationMessage {
  type: 'TOGGLE_PAGE_TRANSLATION';
  targetLang?: TargetLanguage;
  mode?: TranslationMode;
}

export interface GetPageStatusMessage {
  type: 'GET_PAGE_STATUS';
}

export interface GetGatewayHealthMessage {
  type: 'GET_GATEWAY_HEALTH';
}

export interface LookupWordMessage {
  type: 'LOOKUP_WORD';
  word: string;
  sentence: string;
  targetLang?: TargetLanguage;
}

export interface SavedVocabularyItem {
  id: string;
  word: string;
  phonetic: string;
  meaning: string;
  sentence: string;
  sentenceTranslation: string;
  url: string;
  title: string;
  timestamp: number;
}

export interface SaveVocabularyMessage {
  type: 'SAVE_VOCABULARY';
  item: SavedVocabularyItem;
}

export interface GetVocabularyMessage {
  type: 'GET_VOCABULARY';
}

export type RuntimeMessage =
  | TranslateBatchRequest
  | TogglePageTranslationMessage
  | GetPageStatusMessage
  | GetGatewayHealthMessage
  | LookupWordMessage
  | SaveVocabularyMessage
  | GetVocabularyMessage;
