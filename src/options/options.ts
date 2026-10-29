/**
 * 翻译王 (TranslateKing) - 独立设置中心控制脚本 (options.html#general / #services / #subtitle ...)
 */

import type { YouTubeSubtitleStyleConfig } from '../content/youtube/subtitle-menu';
import type { SavedVocabularyItem, TargetLanguage } from '../types';

const DEFAULT_YT_SUBTITLE_CONFIG: YouTubeSubtitleStyleConfig = {
  enabled: true,
  displayMode: 'bilingual',
  position: 'bottom',
  fontScale: 1,
  textColor: '#FEF08A',
  bgOpacity: 0.78,
  learningMask: false,
  hoverPause: true
};

document.addEventListener('DOMContentLoaded', async () => {
  const saveToast = document.getElementById('saveToast') as HTMLElement | null;
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  function showSavedToast(msg = '✓ 设置已自动保存并实时同步') {
    if (!saveToast) return;
    saveToast.textContent = msg;
    saveToast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      saveToast.classList.remove('show');
    }, 1600);
  }

  // 1. Hash 路由与侧边栏导航切换 (#general, #services, #subtitle, #mouse-input, #floating-ball, #vocabulary)
  const navItems = Array.from(document.querySelectorAll<HTMLAnchorElement>('.nav-item'));
  const sections = Array.from(document.querySelectorAll<HTMLElement>('.settings-section'));

  function activateSectionFromHash() {
    const hash = (window.location.hash || '#general').replace('#', '');
    const targetSectionId = `section-${hash}`;
    const matchedSection = document.getElementById(targetSectionId) || document.getElementById('section-general');

    sections.forEach((sec) => sec.classList.toggle('active', sec === matchedSection));
    navItems.forEach((item) => {
      const secKey = item.getAttribute('data-section');
      item.classList.toggle('active', secKey === hash || (!document.getElementById(targetSectionId) && secKey === 'general'));
    });
  }

  window.addEventListener('hashchange', activateSectionFromHash);
  activateSectionFromHash();

  // 启动本页面的连按三下空格输入框沙盒体验
  const optTargetLang = document.getElementById('optTargetLang') as HTMLSelectElement;
  let lastSpaceTimestamps: number[] = [];
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.tagName !== 'TEXTAREA') return;
    if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey) {
      lastSpaceTimestamps = [];
      return;
    }
    const now = Date.now();
    lastSpaceTimestamps.push(now);
    lastSpaceTimestamps = lastSpaceTimestamps.filter((t) => now - t <= 850);
    if (lastSpaceTimestamps.length >= 3) {
      lastSpaceTimestamps = [];
      e.preventDefault();
      const ta = target as HTMLTextAreaElement;
      const rawText = ta.value.trim();
      if (!rawText) return;
      const hasChinese = /[\u4e00-\u9fa5]/.test(rawText);
      const userTarget = (optTargetLang?.value as TargetLanguage) || 'zh-CN';
      const toLang: TargetLanguage = hasChinese && (userTarget === 'zh-CN' || userTarget === 'zh-TW') ? 'en' : userTarget;
      chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', texts: [rawText], toLang }, (res) => {
        if (!chrome.runtime.lastError && res?.translations?.[0]) {
          ta.value = res.translations[0];
        }
      });
    }
  });

  // 2. 加载持久化配置
  const optTranslationMode = document.getElementById('optTranslationMode') as HTMLSelectElement;
  const themeCards = Array.from(document.querySelectorAll<HTMLElement>('.theme-option-card'));
  const webThemePreviewTarget = document.getElementById('webThemePreviewTarget') as HTMLElement;

  const serviceCards = Array.from(document.querySelectorAll<HTMLElement>('.service-card'));
  const optAiApiKey = document.getElementById('optAiApiKey') as HTMLInputElement;
  const optAiModel = document.getElementById('optAiModel') as HTMLInputElement;
  const optAiApiUrl = document.getElementById('optAiApiUrl') as HTMLInputElement;
  const testServiceBtn = document.getElementById('testServiceBtn') as HTMLButtonElement;
  const testServiceResult = document.getElementById('testServiceResult') as HTMLElement;

  // YouTube 字幕设置控件
  const ytEnabled = document.getElementById('ytEnabled') as HTMLInputElement;
  const ytDisplayMode = document.getElementById('ytDisplayMode') as HTMLSelectElement;
  const ytPosition = document.getElementById('ytPosition') as HTMLSelectElement;
  const ytFontScale = document.getElementById('ytFontScale') as HTMLSelectElement;
  const ytTextColor = document.getElementById('ytTextColor') as HTMLSelectElement;
  const ytBgOpacity = document.getElementById('ytBgOpacity') as HTMLSelectElement;
  const ytLearningMask = document.getElementById('ytLearningMask') as HTMLInputElement;
  const ytHoverPause = document.getElementById('ytHoverPause') as HTMLInputElement;
  const ytPreviewBox = document.getElementById('ytPreviewBox') as HTMLElement;
  const ytPreviewOrig = document.getElementById('ytPreviewOrig') as HTMLElement;
  const ytPreviewTrans = document.getElementById('ytPreviewTrans') as HTMLElement;

  // 划词、悬浮球与域名白名单
  const optEnableSelection = document.getElementById('optEnableSelection') as HTMLInputElement;
  const optEnableFloatingBall = document.getElementById('optEnableFloatingBall') as HTMLInputElement;
  const newDomainInput = document.getElementById('newDomainInput') as HTMLInputElement;
  const addDomainBtn = document.getElementById('addDomainBtn') as HTMLButtonElement;
  const domainListContainer = document.getElementById('domainListContainer') as HTMLElement;

  // 生词本控件
  const navVocabCount = document.getElementById('navVocabCount') as HTMLElement;
  const vocabFullTableContainer = document.getElementById('vocabFullTableContainer') as HTMLElement;
  const exportVocabCsvBtn = document.getElementById('exportVocabCsvBtn') as HTMLButtonElement;
  const clearVocabBtn = document.getElementById('clearVocabBtn') as HTMLButtonElement;
  const resetConfigBtn = document.getElementById('resetConfigBtn') as HTMLButtonElement;

  const data = await chrome.storage.local.get([
    'targetLang',
    'translationMode',
    'webTheme',
    'translationProvider',
    'aiApiKey',
    'aiApiUrl',
    'aiModel',
    'ytSubtitleConfig',
    'enableSelection',
    'enableFloatingBall',
    'autoTranslateList',
    'vocabulary'
  ]);

  if (data.targetLang) optTargetLang.value = data.targetLang;
  if (data.translationMode) optTranslationMode.value = data.translationMode;

  const activeTheme = data.webTheme === 'quote' ? 'default' : data.webTheme || 'default';
  function updateWebThemeUI(theme: string) {
    themeCards.forEach((c) => c.classList.toggle('active', c.getAttribute('data-theme-val') === theme));
    if (webThemePreviewTarget) {
      webThemePreviewTarget.className = `preview-trans theme-${theme}`;
    }
  }
  updateWebThemeUI(activeTheme);

  const activeProvider = data.translationProvider || 'auto';
  function updateProviderUI(provider: string) {
    serviceCards.forEach((c) => c.classList.toggle('active', c.getAttribute('data-provider') === provider));
  }
  updateProviderUI(activeProvider);

  if (data.aiApiKey) optAiApiKey.value = data.aiApiKey;
  if (data.aiApiUrl) optAiApiUrl.value = data.aiApiUrl;
  if (data.aiModel) optAiModel.value = data.aiModel;

  // YouTube 字幕配置初始化与预览刷新
  let ytCfg: YouTubeSubtitleStyleConfig = {
    ...DEFAULT_YT_SUBTITLE_CONFIG,
    ...(data.ytSubtitleConfig || {})
  };

  function syncYtFormAndPreview() {
    ytEnabled.checked = ytCfg.enabled;
    ytDisplayMode.value = ytCfg.displayMode;
    ytPosition.value = ytCfg.position;
    ytFontScale.value = String(ytCfg.fontScale);
    ytTextColor.value = ytCfg.textColor;
    ytBgOpacity.value = String(ytCfg.bgOpacity);
    ytLearningMask.checked = ytCfg.learningMask;
    ytHoverPause.checked = ytCfg.hoverPause;

    if (ytPreviewOrig && ytPreviewTrans && ytPreviewBox) {
      ytPreviewOrig.style.display = ytCfg.displayMode === 'translation-only' ? 'none' : 'block';
      ytPreviewBox.style.flexDirection = ytCfg.position === 'top' ? 'column-reverse' : 'column';
      ytPreviewTrans.style.color = ytCfg.textColor;
      ytPreviewTrans.style.background = `rgba(8, 8, 8, ${ytCfg.bgOpacity})`;
      ytPreviewTrans.style.fontSize = `${Math.round(16 * ytCfg.fontScale)}px`;
      ytPreviewTrans.style.filter = ytCfg.learningMask ? 'blur(4px)' : 'none';
    }
  }
  syncYtFormAndPreview();

  ytPreviewTrans?.addEventListener('mouseenter', () => {
    if (ytCfg.learningMask) ytPreviewTrans.style.filter = 'none';
  });
  ytPreviewTrans?.addEventListener('mouseleave', () => {
    if (ytCfg.learningMask) ytPreviewTrans.style.filter = 'blur(4px)';
  });

  optEnableSelection.checked = data.enableSelection !== false;
  optEnableFloatingBall.checked = data.enableFloatingBall !== false;

  let autoDomains: string[] = Array.isArray(data.autoTranslateList) ? data.autoTranslateList : [];
  function renderDomainChips() {
    while (domainListContainer.firstChild) {
      domainListContainer.removeChild(domainListContainer.firstChild);
    }
    if (autoDomains.length === 0) {
      const empty = document.createElement('span');
      empty.style.cssText = 'font-size: 12.5px; color: #94a3b8;';
      empty.textContent = '暂未添加自动翻译域名（可在上方添加或在任意网页悬浮球中一键勾选）';
      domainListContainer.appendChild(empty);
      return;
    }
    autoDomains.forEach((dom) => {
      const chip = document.createElement('span');
      chip.className = 'domain-chip';
      const label = document.createElement('span');
      label.textContent = dom;
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        autoDomains = autoDomains.filter((d) => d !== dom);
        chrome.storage.local.set({ autoTranslateList: autoDomains });
        renderDomainChips();
        showSavedToast();
      });
      chip.appendChild(label);
      chip.appendChild(delBtn);
      domainListContainer.appendChild(chip);
    });
  }
  renderDomainChips();

  // 生词本渲染
  let vocabItems: SavedVocabularyItem[] = Array.isArray(data.vocabulary) ? data.vocabulary : [];
  function renderVocabularyTable() {
    if (navVocabCount) navVocabCount.textContent = String(vocabItems.length);
    while (vocabFullTableContainer.firstChild) {
      vocabFullTableContainer.removeChild(vocabFullTableContainer.firstChild);
    }
    if (vocabItems.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 36px 0; text-align: center; color: #64748b; font-size: 13.5px;';
      empty.textContent = '生词本暂无内容 · 在任意网页用鼠标划选单词后点击浮窗右上角的「☆ 收藏」即可自动收录到此';
      vocabFullTableContainer.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'vocab-table';
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    ['单词/短语', '音标', '核心释义', '原句语境', '操作'].forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    vocabItems.forEach((item) => {
      const tr = document.createElement('tr');

      const tdWord = document.createElement('td');
      tdWord.style.cssText = 'font-weight: 700; color: #1e40af;';
      tdWord.textContent = item.word;

      const tdPhon = document.createElement('td');
      tdPhon.style.cssText = 'color: #64748b; font-family: monospace;';
      tdPhon.textContent = item.phonetic ? `[${item.phonetic}]` : '-';

      const tdMean = document.createElement('td');
      tdMean.textContent = item.meaning;

      const tdSent = document.createElement('td');
      tdSent.style.cssText = 'color: #475569; max-width: 320px;';
      tdSent.textContent = item.sentence || '-';

      const tdAct = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'btn-outline';
      del.style.cssText = 'padding: 4px 8px; font-size: 11.5px;';
      del.textContent = '删除';
      del.addEventListener('click', () => {
        vocabItems = vocabItems.filter((v) => v.word !== item.word);
        chrome.storage.local.set({ vocabulary: vocabItems });
        renderVocabularyTable();
        showSavedToast('✓ 已移除该生词');
      });
      tdAct.appendChild(del);

      tr.appendChild(tdWord);
      tr.appendChild(tdPhon);
      tr.appendChild(tdMean);
      tr.appendChild(tdSent);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    vocabFullTableContainer.appendChild(table);
  }
  renderVocabularyTable();

  // 3. 绑定所有表单变更事件
  optTargetLang.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: optTargetLang.value });
    showSavedToast();
  });

  optTranslationMode.addEventListener('change', () => {
    chrome.storage.local.set({ translationMode: optTranslationMode.value });
    showSavedToast();
  });

  themeCards.forEach((card) => {
    card.addEventListener('click', () => {
      const val = card.getAttribute('data-theme-val') || 'default';
      updateWebThemeUI(val);
      chrome.storage.local.set({ webTheme: val });
      showSavedToast();
    });
  });

  serviceCards.forEach((card) => {
    card.addEventListener('click', () => {
      const provider = card.getAttribute('data-provider') || 'auto';
      updateProviderUI(provider);
      chrome.storage.local.set({ translationProvider: provider });
      showSavedToast();
    });
  });

  optAiApiKey.addEventListener('input', () => {
    chrome.storage.local.set({ aiApiKey: optAiApiKey.value.trim() });
    showSavedToast();
  });

  optAiModel.addEventListener('input', () => {
    chrome.storage.local.set({ aiModel: optAiModel.value.trim() });
    showSavedToast();
  });

  optAiApiUrl.addEventListener('input', () => {
    chrome.storage.local.set({ aiApiUrl: optAiApiUrl.value.trim() });
    showSavedToast();
  });

  testServiceBtn.addEventListener('click', () => {
    testServiceResult.style.color = '#2563eb';
    testServiceResult.textContent = '⏳ 正在向翻译网关发送测试请求...';
    const start = Date.now();
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_BATCH',
        texts: ['Immersion is the fastest way to master a language.'],
        toLang: (optTargetLang.value as TargetLanguage) || 'zh-CN'
      },
      (res) => {
        const ms = Date.now() - start;
        if (chrome.runtime.lastError || !res?.translations?.[0]) {
          testServiceResult.style.color = '#dc2626';
          testServiceResult.textContent = '❌ 连接异常，请检查网络或 API Key';
        } else {
          testServiceResult.style.color = '#059669';
          testServiceResult.textContent = `✓ 响应成功 (${ms}ms)：${res.translations[0]}`;
        }
      }
    );
  });

  // YouTube 字幕变更保存
  const saveYtConfig = () => {
    ytCfg = {
      enabled: ytEnabled.checked,
      displayMode: ytDisplayMode.value as 'bilingual' | 'translation-only',
      position: ytPosition.value as 'bottom' | 'top',
      fontScale: parseFloat(ytFontScale.value) || 1.0,
      textColor: ytTextColor.value,
      bgOpacity: parseFloat(ytBgOpacity.value) ?? 0.78,
      learningMask: ytLearningMask.checked,
      hoverPause: ytHoverPause.checked
    };
    syncYtFormAndPreview();
    chrome.storage.local.set({ ytSubtitleConfig: ytCfg });
    showSavedToast();
  };

  [ytEnabled, ytDisplayMode, ytPosition, ytFontScale, ytTextColor, ytBgOpacity, ytLearningMask, ytHoverPause].forEach(
    (el) => el?.addEventListener('change', saveYtConfig)
  );

  optEnableSelection.addEventListener('change', () => {
    chrome.storage.local.set({ enableSelection: optEnableSelection.checked });
    showSavedToast();
  });

  optEnableFloatingBall.addEventListener('change', () => {
    chrome.storage.local.set({ enableFloatingBall: optEnableFloatingBall.checked });
    showSavedToast();
  });

  addDomainBtn.addEventListener('click', () => {
    const raw = newDomainInput.value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!raw) return;
    if (!autoDomains.includes(raw)) {
      autoDomains.push(raw);
      chrome.storage.local.set({ autoTranslateList: autoDomains });
      renderDomainChips();
      showSavedToast(`✓ 已添加自动翻译域名: ${raw}`);
    }
    newDomainInput.value = '';
  });

  exportVocabCsvBtn.addEventListener('click', () => {
    if (vocabItems.length === 0) return;
    const rows = [
      ['Word', 'Phonetic', 'Meaning', 'Sentence'],
      ...vocabItems.map((v) => [
        `"${(v.word || '').replace(/"/g, '""')}"`,
        `"${(v.phonetic || '').replace(/"/g, '""')}"`,
        `"${(v.meaning || '').replace(/"/g, '""')}"`,
        `"${(v.sentence || '').replace(/"/g, '""')}"`
      ])
    ];
    const csv = '\uFEFF' + rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TranslateKing-Vocabulary.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  clearVocabBtn.addEventListener('click', () => {
    vocabItems = [];
    chrome.storage.local.set({ vocabulary: [] });
    renderVocabularyTable();
    showSavedToast('✓ 生词本已清空');
  });

  resetConfigBtn.addEventListener('click', () => {
    chrome.storage.local.set(
      {
        targetLang: 'zh-CN',
        translationMode: 'bilingual',
        webTheme: 'default',
        translationProvider: 'auto',
        ytSubtitleConfig: DEFAULT_YT_SUBTITLE_CONFIG,
        enableSelection: true,
        enableFloatingBall: true
      },
      () => {
        window.location.reload();
      }
    );
  });
});
