/**
 * 翻译王 (TranslateKing) Popup 控制脚本
 */

import { TargetLanguage, TranslationMode } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const toggleBtn = document.getElementById('toggleBtn') as HTMLButtonElement;
  const btnText = document.getElementById('btnText') as HTMLSpanElement;
  const targetLangSelect = document.getElementById('targetLang') as HTMLSelectElement;
  const translationModeSelect = document.getElementById('translationMode') as HTMLSelectElement;
  const enableSelectionToggle = document.getElementById('enableSelection') as HTMLInputElement;
  const statusText = document.getElementById('statusText') as HTMLSpanElement;

  // 1. 读取保存的语言、模式与划词偏好
  const saved = await chrome.storage.local.get(['targetLang', 'translationMode', 'enableSelection']);
  if (saved.targetLang) {
    targetLangSelect.value = saved.targetLang;
  }
  if (saved.translationMode) {
    translationModeSelect.value = saved.translationMode;
  }
  if (typeof saved.enableSelection === 'boolean') {
    enableSelectionToggle.checked = saved.enableSelection;
  } else {
    enableSelectionToggle.checked = true; // 默认开启
  }

  targetLangSelect.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: targetLangSelect.value });
  });

  translationModeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ translationMode: translationModeSelect.value });
    updateBtnLabel();
  });

  enableSelectionToggle.addEventListener('change', () => {
    chrome.storage.local.set({ enableSelection: enableSelectionToggle.checked });
  });

  function updateBtnLabel(isTranslated = toggleBtn.classList.contains('is-active')) {
    const mode = translationModeSelect.value as TranslationMode;
    if (isTranslated) {
      toggleBtn.classList.add('is-active');
      btnText.textContent = '恢复网页纯净原文';
      statusText.textContent = mode === 'replace' ? '纯中文替换模式已开启 (含按钮)' : '双语对照伴读已开启';
    } else {
      toggleBtn.classList.remove('is-active');
      btnText.textContent = mode === 'replace' ? '一键纯中文翻译 (含按钮)' : '一键开启双语对照 (Alt+T)';
      statusText.textContent = 'Microsoft 极速专线已就绪 (免配 Key)';
    }
  }

  const isInjectableUrl = (url?: string) =>
    url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'));

  async function ensureContentScriptInjected(tabId: number, url?: string): Promise<boolean> {
    if (!isInjectableUrl(url) || !chrome.scripting) {
      return false;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      }).catch(() => {});
      return true;
    } catch (err) {
      console.warn('[TranslateKing Popup] 脚本自愈注入失败:', err);
      return false;
    }
  }

  // 2. 查询当前标签页的翻译状态
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const ytNotice = document.getElementById('ytNotice') as HTMLElement | null;
  if (tab?.url && tab.url.includes('youtube.com')) {
    if (ytNotice) ytNotice.style.display = 'block';
  }

  const queryPageStatus = (tabId: number, url?: string) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATUS' }, async (response) => {
      if (chrome.runtime.lastError || !response) {
        const injected = await ensureContentScriptInjected(tabId, url);
        if (injected) {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATUS' }, (retryRes) => {
              if (chrome.runtime.lastError) {
                statusText.textContent = '准备就绪，点击即可开启双语对照';
                return;
              }
              if (retryRes) {
                if (retryRes.mode) translationModeSelect.value = retryRes.mode;
                updateBtnLabel(retryRes.isTranslated);
              }
            });
          }, 80);
        } else {
          statusText.textContent = isInjectableUrl(url) ? 'Microsoft 极速专线已就绪' : '当前受保护页面无法翻译';
        }
        return;
      }

      if (response.mode) {
        translationModeSelect.value = response.mode;
      }
      updateBtnLabel(response.isTranslated);
    });
  };

  if (tab?.id) {
    queryPageStatus(tab.id, tab.url);
  }

  // 3. 点击一键切换翻译
  toggleBtn.addEventListener('click', async () => {
    if (!tab?.id) return;

    const targetLang = targetLangSelect.value as TargetLanguage;
    const mode = translationModeSelect.value as TranslationMode;
    toggleBtn.disabled = true;
    btnText.textContent = '正在处理...';

    const sendToggle = () => {
      chrome.tabs.sendMessage(
        tab.id!,
        { type: 'TOGGLE_PAGE_TRANSLATION', targetLang, mode },
        async (res) => {
          if (chrome.runtime.lastError) {
            // 自动自愈注入并重发
            const injected = await ensureContentScriptInjected(tab.id!, tab.url);
            if (injected) {
              setTimeout(() => {
                chrome.tabs.sendMessage(
                  tab.id!,
                  { type: 'TOGGLE_PAGE_TRANSLATION', targetLang, mode },
                  (retryRes) => {
                    toggleBtn.disabled = false;
                    if (chrome.runtime.lastError) {
                      statusText.textContent = '页面已就绪，请再点击一次开启';
                      updateBtnLabel(false);
                      return;
                    }
                    if (retryRes) {
                      updateBtnLabel(retryRes.isTranslated);
                    }
                  }
                );
              }, 100);
            } else {
              toggleBtn.disabled = false;
              statusText.textContent = isInjectableUrl(tab.url) ? '网络繁忙，请稍后重试' : '当前受保护页面无法翻译';
              updateBtnLabel(false);
            }
            return;
          }

          toggleBtn.disabled = false;
          if (res) {
            updateBtnLabel(res.isTranslated);
          }
        }
      );
    };

    sendToggle();
  });
});
