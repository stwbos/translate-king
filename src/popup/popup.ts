/**
 * 翻译王 (TranslateKing) Popup 控制脚本
 */

import { TargetLanguage, TranslationMode } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const toggleBtn = document.getElementById('toggleBtn') as HTMLButtonElement;
  const btnText = document.getElementById('btnText') as HTMLSpanElement;
  const targetLangSelect = document.getElementById('targetLang') as HTMLSelectElement;
  const translationModeSelect = document.getElementById('translationMode') as HTMLSelectElement;
  const statusText = document.getElementById('statusText') as HTMLSpanElement;

  // 1. 读取保存的语言与模式偏好
  const saved = await chrome.storage.local.get(['targetLang', 'translationMode']);
  if (saved.targetLang) {
    targetLangSelect.value = saved.targetLang;
  }
  if (saved.translationMode) {
    translationModeSelect.value = saved.translationMode;
  }

  targetLangSelect.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: targetLangSelect.value });
  });

  translationModeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ translationMode: translationModeSelect.value });
    updateBtnLabel();
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

  // 2. 查询当前标签页的翻译状态
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusText.textContent = '当前页面无需翻译或无法注入';
        return;
      }

      if (response.mode) {
        translationModeSelect.value = response.mode;
      }
      updateBtnLabel(response.isTranslated);
    });
  }

  // 3. 点击一键切换翻译
  toggleBtn.addEventListener('click', async () => {
    if (!tab?.id) return;

    const targetLang = targetLangSelect.value as TargetLanguage;
    const mode = translationModeSelect.value as TranslationMode;
    toggleBtn.disabled = true;
    btnText.textContent = '正在处理...';

    chrome.tabs.sendMessage(
      tab.id,
      { type: 'TOGGLE_PAGE_TRANSLATION', targetLang, mode },
      (res) => {
        toggleBtn.disabled = false;
        if (chrome.runtime.lastError) {
          statusText.textContent = '请刷新网页后再次尝试';
          updateBtnLabel(false);
          return;
        }
        if (res) {
          updateBtnLabel(res.isTranslated);
        }
      }
    );
  });
});
