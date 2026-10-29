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

/**
 * 向指定标签页发送切换翻译指令，若标签页长时间开启导致 Content Script 失联或未注入，
 * 则自动通过 chrome.scripting 重新动态注入 content.js 并自动重发指令（自愈保活）
 */
async function sendToggleToTabWithAutoHeal(tabId: number, url?: string): Promise<void> {
  chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_PAGE_TRANSLATION' }, async () => {
    if (chrome.runtime.lastError) {
      const isInjectable =
        url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'));

      if (isInjectable && chrome.scripting) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          });
          await chrome.scripting.insertCSS({
            target: { tabId },
            files: ['content.css']
          }).catch(() => {});

          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_PAGE_TRANSLATION' }, () => {
              // 消耗掉可能存在的错误
              if (chrome.runtime.lastError) {
                // 忽略
              }
            });
          }, 80);
        } catch (err) {
          console.warn('[TranslateKing Background] 无法向标签页注入脚本:', err);
        }
      }
    }
  });
}

// 监听快捷键 (Alt+T) 切换当前活跃标签页的翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-translation') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      sendToggleToTabWithAutoHeal(tab.id, tab.url);
    }
  }
});

// 初始化右键菜单并自动为已打开的标签页注入最新脚本（免刷新自愈）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate-king-toggle',
    title: '翻译王：双语对照翻译此页面 (Alt+T)',
    contexts: ['page']
  });

  if (chrome.tabs && chrome.scripting) {
    chrome.tabs.query({ url: ['https://*.youtube.com/*', 'http://*.youtube.com/*'] }, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;
      for (const tab of tabs) {
        if (!tab.id) continue;
        const tabId = tab.id;
        chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
        chrome.scripting
          .executeScript({ target: { tabId }, files: ['yt-bridge.js'], world: 'MAIN' as any })
          .catch(() => {});
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
      }
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-king-toggle' && tab?.id) {
    sendToggleToTabWithAutoHeal(tab.id, tab.url);
  }
});

console.log('[TranslateKing] Background service worker initialized.');
