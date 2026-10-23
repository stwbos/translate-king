/**
 * 翻译王 (TranslateKing) Background Service Worker
 */

import { translateBatch, getGatewayHealthStatus } from './translator';
import { lookupWord } from './dictionary';
import { RuntimeMessage, SavedVocabularyItem } from '../types';

// 消息路由分发
chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === 'TRANSLATE_BATCH') {
    translateBatch(message.texts, message.toLang)
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({
          translations: message.texts,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    return true; // 声明异步响应通道
  }

  if (message.type === 'GET_GATEWAY_HEALTH') {
    sendResponse(getGatewayHealthStatus());
    return false;
  }

  if (message.type === 'LOOKUP_WORD') {
    lookupWord(message.word, message.sentence, message.targetLang)
      .then((res) => sendResponse(res))
      .catch((err) => {
        sendResponse({
          word: message.word,
          phonetic: '',
          meaning: err instanceof Error ? err.message : '查词失败',
          sentence: message.sentence,
          sentenceTranslation: ''
        });
      });
    return true;
  }

  if (message.type === 'SAVE_VOCABULARY') {
    chrome.storage.local.get(['vocabulary'], (data) => {
      const list: SavedVocabularyItem[] = data.vocabulary || [];
      // 避免重复添加同一个词
      const filtered = list.filter((item) => item.word.toLowerCase() !== message.item.word.toLowerCase());
      filtered.unshift(message.item);
      chrome.storage.local.set({ vocabulary: filtered }, () => {
        sendResponse({ success: true, count: filtered.length });
      });
    });
    return true;
  }

  if (message.type === 'GET_VOCABULARY') {
    chrome.storage.local.get(['vocabulary'], (data) => {
      sendResponse(data.vocabulary || []);
    });
    return true;
  }
});

// 监听快捷键 (Alt+T) 切换当前活跃标签页的翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-translation') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PAGE_TRANSLATION' });
    }
  }
});

// 初始化右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate-king-toggle',
    title: '翻译王：双语对照翻译此页面 (Alt+T)',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-king-toggle' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PAGE_TRANSLATION' });
  }
});

console.log('[TranslateKing] Background service worker initialized.');
