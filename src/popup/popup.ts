/**
 * 翻译王 (TranslateKing) 旗舰级 Popup 控制脚本
 */

import { TargetLanguage, TranslationMode, SavedVocabularyItem } from '../types';

document.addEventListener('DOMContentLoaded', async () => {
  const toggleBtn = document.getElementById('toggleBtn') as HTMLButtonElement;
  const btnText = document.getElementById('btnText') as HTMLSpanElement;
  const modeQuickBtn = document.getElementById('modeQuickBtn') as HTMLButtonElement | null;
  const modeMiniBadge = document.getElementById('modeMiniBadge') as HTMLElement | null;

  const translationProviderSelect = document.getElementById('translationProvider') as HTMLSelectElement | null;
  const webThemeSelect = document.getElementById('webTheme') as HTMLSelectElement | null;
  const enableFloatingBallToggle = document.getElementById('enableFloatingBall') as HTMLInputElement | null;
  const autoTranslateSiteToggle = document.getElementById('autoTranslateSite') as HTMLInputElement | null;
  const currentDomainBadge = document.getElementById('currentDomainBadge') as HTMLElement | null;

  const aiConfigBox = document.getElementById('aiConfigBox') as HTMLElement | null;
  const customOpenAiFields = document.getElementById('customOpenAiFields') as HTMLElement | null;
  const aiApiKeyInput = document.getElementById('aiApiKey') as HTMLInputElement | null;
  const aiApiUrlInput = document.getElementById('aiApiUrl') as HTMLInputElement | null;
  const aiModelInput = document.getElementById('aiModel') as HTMLInputElement | null;
  const openAiSettingsBtn = document.getElementById('openAiSettingsBtn') as HTMLButtonElement | null;

  const targetLangSelect = document.getElementById('targetLang') as HTMLSelectElement;
  const translationModeSelect = document.getElementById('translationMode') as HTMLSelectElement;
  const enableSelectionToggle = document.getElementById('enableSelection') as HTMLInputElement;
  const selectionCardBtn = document.getElementById('selectionCardBtn') as HTMLButtonElement | null;
  const statusText = document.getElementById('statusText') as HTMLSpanElement;

  // 快捷文本翻译与生词本抽屉元素
  const openTextTranslateBtn = document.getElementById('openTextTranslateBtn') as HTMLButtonElement | null;
  const textTranslateDrawer = document.getElementById('textTranslateDrawer') as HTMLElement | null;
  const closeTextDrawer = document.getElementById('closeTextDrawer') as HTMLButtonElement | null;
  const quickInputText = document.getElementById('quickInputText') as HTMLTextAreaElement | null;
  const runQuickTranslateBtn = document.getElementById('runQuickTranslateBtn') as HTMLButtonElement | null;
  const quickOutputText = document.getElementById('quickOutputText') as HTMLElement | null;

  const openVocabBtn = document.getElementById('openVocabBtn') as HTMLButtonElement | null;
  const vocabDrawer = document.getElementById('vocabDrawer') as HTMLElement | null;
  const closeVocabDrawer = document.getElementById('closeVocabDrawer') as HTMLButtonElement | null;
  const vocabListContainer = document.getElementById('vocabListContainer') as HTMLElement | null;
  const vocabCountBadge = document.getElementById('vocabCountBadge') as HTMLElement | null;

  const updateAiBoxVisibility = (forceToggle = false) => {
    if (!translationProviderSelect || !aiConfigBox) return;
    const val = translationProviderSelect.value;
    if (forceToggle) {
      aiConfigBox.style.display = aiConfigBox.style.display === 'none' ? 'flex' : 'none';
      if (customOpenAiFields) {
        customOpenAiFields.style.display = val === 'openai' ? 'block' : 'none';
      }
      return;
    }
    if (val === 'deepseek' || val === 'openai') {
      aiConfigBox.style.display = 'flex';
      if (customOpenAiFields) {
        customOpenAiFields.style.display = val === 'openai' ? 'block' : 'none';
      }
    } else {
      aiConfigBox.style.display = 'none';
    }
  };

  // 获取当前活跃标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let currentHostname = '';
  if (tab?.url) {
    try {
      const u = new URL(tab.url);
      if (u.protocol.startsWith('http')) {
        currentHostname = u.hostname;
      }
    } catch (_) {}
  }
  if (currentDomainBadge) {
    currentDomainBadge.textContent = currentHostname ? currentHostname.replace(/^www\./, '') : '当前站点';
  }

  // 1. 读取保存的配置与生词本
  const saved = await chrome.storage.local.get([
    'translationProvider',
    'aiApiKey',
    'aiApiUrl',
    'aiModel',
    'targetLang',
    'translationMode',
    'webTheme',
    'enableFloatingBall',
    'autoTranslateList',
    'enableSelection',
    'vocabulary'
  ]);

  if (saved.translationProvider && translationProviderSelect) {
    translationProviderSelect.value = saved.translationProvider;
  }
  if (saved.aiApiKey && aiApiKeyInput) {
    aiApiKeyInput.value = saved.aiApiKey;
  }
  if (saved.aiApiUrl && aiApiUrlInput) {
    aiApiUrlInput.value = saved.aiApiUrl;
  }
  if (saved.aiModel && aiModelInput) {
    aiModelInput.value = saved.aiModel;
  }
  updateAiBoxVisibility();

  if (saved.targetLang) {
    targetLangSelect.value = saved.targetLang;
  }
  if (saved.translationMode) {
    translationModeSelect.value = saved.translationMode;
  }
  if (saved.webTheme && webThemeSelect) {
    webThemeSelect.value = saved.webTheme === 'quote' ? 'default' : saved.webTheme;
  }
  if (enableFloatingBallToggle) {
    enableFloatingBallToggle.checked = saved.enableFloatingBall !== false;
  }

  let autoTranslateList: string[] = Array.isArray(saved.autoTranslateList) ? saved.autoTranslateList : [];
  if (autoTranslateSiteToggle && currentHostname) {
    autoTranslateSiteToggle.checked = autoTranslateList.includes(currentHostname);
  }

  const isSelectionEnabled = saved.enableSelection !== false;
  enableSelectionToggle.checked = isSelectionEnabled;
  selectionCardBtn?.classList.toggle('is-enabled', isSelectionEnabled);

  const vocabList: SavedVocabularyItem[] = Array.isArray(saved.vocabulary) ? saved.vocabulary : [];
  if (vocabCountBadge) {
    vocabCountBadge.textContent = String(vocabList.length);
  }

  function updateModeVisual() {
    const mode = translationModeSelect.value as TranslationMode;
    if (modeMiniBadge) {
      modeMiniBadge.textContent = mode === 'replace' ? '纯中' : '双语';
    }
  }
  updateModeVisual();

  function updateBtnLabel(isTranslated = toggleBtn.classList.contains('is-active')) {
    const mode = translationModeSelect.value as TranslationMode;
    updateModeVisual();
    if (isTranslated) {
      toggleBtn.classList.add('is-active');
      btnText.textContent = '还原原文 (⌥+T)';
      statusText.textContent = mode === 'replace' ? '纯中替换中' : '双语伴读中';
    } else {
      toggleBtn.classList.remove('is-active');
      btnText.textContent = mode === 'replace' ? '纯中翻译 (⌥+T)' : '翻译 (⌥+T)';
      statusText.textContent = '极速专线就绪';
    }
  }

  // 事件绑定
  enableFloatingBallToggle?.addEventListener('change', () => {
    chrome.storage.local.set({ enableFloatingBall: enableFloatingBallToggle.checked });
  });

  translationProviderSelect?.addEventListener('change', () => {
    chrome.storage.local.set({ translationProvider: translationProviderSelect.value });
    updateAiBoxVisibility();
  });

  webThemeSelect?.addEventListener('change', () => {
    chrome.storage.local.set({ webTheme: webThemeSelect.value });
  });

  autoTranslateSiteToggle?.addEventListener('change', () => {
    if (!currentHostname) return;
    if (autoTranslateSiteToggle.checked) {
      if (!autoTranslateList.includes(currentHostname)) {
        autoTranslateList.push(currentHostname);
      }
    } else {
      autoTranslateList = autoTranslateList.filter((h) => h !== currentHostname);
    }
    chrome.storage.local.set({ autoTranslateList });
  });

  openAiSettingsBtn?.addEventListener('click', () => {
    if (chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html#general'), '_blank');
    }
  });

  aiApiKeyInput?.addEventListener('input', () => {
    chrome.storage.local.set({ aiApiKey: aiApiKeyInput.value.trim() });
  });

  aiApiUrlInput?.addEventListener('input', () => {
    chrome.storage.local.set({ aiApiUrl: aiApiUrlInput.value.trim() });
  });

  aiModelInput?.addEventListener('input', () => {
    chrome.storage.local.set({ aiModel: aiModelInput.value.trim() });
  });

  targetLangSelect.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: targetLangSelect.value });
  });

  // 点击左侧方形按钮快速切换「双语对照 / 纯中替换」
  modeQuickBtn?.addEventListener('click', () => {
    const nextMode: TranslationMode = translationModeSelect.value === 'bilingual' ? 'replace' : 'bilingual';
    translationModeSelect.value = nextMode;
    chrome.storage.local.set({ translationMode: nextMode });
    updateBtnLabel();
  });

  // 点击底部宫格「划词翻译」切换开关
  selectionCardBtn?.addEventListener('click', () => {
    enableSelectionToggle.checked = !enableSelectionToggle.checked;
    selectionCardBtn.classList.toggle('is-enabled', enableSelectionToggle.checked);
    chrome.storage.local.set({ enableSelection: enableSelectionToggle.checked });
  });

  // 快捷文本互译面板逻辑
  openTextTranslateBtn?.addEventListener('click', () => {
    if (!textTranslateDrawer) return;
    if (vocabDrawer) vocabDrawer.style.display = 'none';
    const isHidden = textTranslateDrawer.style.display === 'none';
    textTranslateDrawer.style.display = isHidden ? 'block' : 'none';
    if (isHidden) quickInputText?.focus();
  });

  closeTextDrawer?.addEventListener('click', () => {
    if (textTranslateDrawer) textTranslateDrawer.style.display = 'none';
  });

  const triggerQuickTextTranslate = () => {
    const raw = quickInputText?.value.trim() || '';
    if (!raw || !quickOutputText) return;
    quickOutputText.style.display = 'block';
    quickOutputText.textContent = '正在翻译...';

    const hasChinese = /[\u4e00-\u9fa5]/.test(raw);
    const toLang: TargetLanguage = hasChinese
      ? (targetLangSelect.value === 'zh-CN' || targetLangSelect.value === 'zh-TW'
          ? 'en'
          : (targetLangSelect.value as TargetLanguage))
      : (targetLangSelect.value as TargetLanguage);

    chrome.runtime.sendMessage(
      { type: 'TRANSLATE_BATCH', texts: [raw], toLang },
      (res) => {
        if (chrome.runtime.lastError || !res?.translations?.[0]) {
          quickOutputText.textContent = '翻译请求失败，请重试';
        } else {
          quickOutputText.textContent = res.translations[0];
        }
      }
    );
  };

  runQuickTranslateBtn?.addEventListener('click', triggerQuickTextTranslate);
  quickInputText?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      triggerQuickTextTranslate();
    }
  });

  // 生词本抽屉逻辑
  openVocabBtn?.addEventListener('click', async () => {
    if (!vocabDrawer || !vocabListContainer) return;
    if (textTranslateDrawer) textTranslateDrawer.style.display = 'none';
    const isHidden = vocabDrawer.style.display === 'none';
    vocabDrawer.style.display = isHidden ? 'block' : 'none';
    if (!isHidden) return;

    const latest = await chrome.storage.local.get(['vocabulary']);
    const items: SavedVocabularyItem[] = Array.isArray(latest.vocabulary) ? latest.vocabulary : [];
    while (vocabListContainer.firstChild) {
      vocabListContainer.removeChild(vocabListContainer.firstChild);
    }

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color: #64748b; font-size: 11.5px; text-align: center; padding: 10px 0;';
      empty.textContent = '暂无收藏生词 · 在网页选中单词点击 ☆ 即可收藏';
      vocabListContainer.appendChild(empty);
      return;
    }

    items.slice(0, 30).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'vocab-item';
      const w = document.createElement('div');
      w.style.cssText = 'font-weight: 700; color: #1e40af; margin-bottom: 2px;';
      w.textContent = `${item.word} ${item.phonetic ? `[${item.phonetic}]` : ''}`;
      const m = document.createElement('div');
      m.style.cssText = 'color: #334155;';
      m.textContent = item.meaning;
      row.appendChild(w);
      row.appendChild(m);
      vocabListContainer.appendChild(row);
    });
  });

  closeVocabDrawer?.addEventListener('click', () => {
    if (vocabDrawer) vocabDrawer.style.display = 'none';
  });

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
      await chrome.scripting
        .insertCSS({
          target: { tabId },
          files: ['content.css']
        })
        .catch(() => {});
      return true;
    } catch (err) {
      console.warn('[TranslateKing Popup] 脚本自愈注入失败:', err);
      return false;
    }
  }

  // 2. 查询当前标签页状态
  const ytNotice = document.getElementById('ytNotice') as HTMLElement | null;
  if (tab?.url && tab.url.includes('youtube.com')) {
    if (ytNotice) ytNotice.style.display = 'flex';
  }

  const queryPageStatus = (tabId: number, url?: string) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATUS' }, async (response) => {
      if (chrome.runtime.lastError || !response) {
        const injected = await ensureContentScriptInjected(tabId, url);
        if (injected) {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATUS' }, (retryRes) => {
              if (!chrome.runtime.lastError && retryRes) {
                if (retryRes.mode) translationModeSelect.value = retryRes.mode;
                updateBtnLabel(retryRes.isTranslated);
              }
            });
          }, 80);
        } else {
          statusText.textContent = isInjectableUrl(url) ? '极速专线就绪' : '系统保护页';
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
    btnText.textContent = '正在翻译...';

    chrome.tabs.sendMessage(
      tab.id,
      { type: 'TOGGLE_PAGE_TRANSLATION', targetLang, mode },
      async (res) => {
        if (chrome.runtime.lastError) {
          const injected = await ensureContentScriptInjected(tab.id!, tab.url);
          if (injected) {
            setTimeout(() => {
              chrome.tabs.sendMessage(
                tab.id!,
                { type: 'TOGGLE_PAGE_TRANSLATION', targetLang, mode },
                (retryRes) => {
                  toggleBtn.disabled = false;
                  if (!chrome.runtime.lastError && retryRes) {
                    updateBtnLabel(retryRes.isTranslated);
                  } else {
                    updateBtnLabel(false);
                  }
                }
              );
            }, 100);
          } else {
            toggleBtn.disabled = false;
            statusText.textContent = '系统页面无法翻译';
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
  });
});
