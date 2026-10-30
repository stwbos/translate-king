/**
 * 翻译王 (TranslateKing) - YouTube 视频字幕多维快捷控制菜单 (对标沉浸式翻译 subtitle.quickButton)
 *
 * 核心特性（100% 纯 DOM API 构建，零 .innerHTML，严守 YouTube TrustedTypes CSP）：
 * 1. 字幕显示模式：双语对照 (bilingual) / 仅显示译文 (translation-only)
 * 2. 译文位置：原文下方 (bottom) / 原文上方 (top)
 * 3. 译文字号缩放：80% / 100% / 120% / 145%
 * 4. 译文颜色预设：亮黄 (#FEF08A) / 纯白 (#FFFFFF) / 青色 (#22D3EE) / 翠绿 (#4ADE80) / 柔粉 (#F472B6)
 * 5. 背景不透明度：0% / 50% / 78% / 95%
 * 6. 听力学习遮罩模式：默认模糊译文，鼠标悬停在字幕上时清晰显示（练听力神器）
 * 7. 一键下载当前视频双语 .SRT 字幕文件 / 带时间戳 .TXT 字幕文稿 / 唤起视频总结面板
 */

import { TargetLanguage } from '../../types';

export interface YouTubeSubtitleStyleConfig {
  enabled: boolean;
  targetLang?: TargetLanguage;
  displayMode: 'bilingual' | 'translation-only';
  position: 'bottom' | 'top';
  fontScale: number; // 0.8 | 1.0 | 1.2 | 1.45
  textColor: string; // '#FEF08A' | '#FFFFFF' | '#22D3EE' | '#4ADE80' | '#F472B6'
  bgOpacity: number; // 0 | 0.5 | 0.78 | 0.95
  learningMask: boolean; // 模糊遮罩悬停显示
  hoverPause: boolean; // 鼠标悬停字幕自动暂停视频
}

export const DEFAULT_YT_SUBTITLE_CONFIG: YouTubeSubtitleStyleConfig = {
  enabled: true,
  targetLang: 'zh-CN',
  displayMode: 'bilingual',
  position: 'bottom',
  fontScale: 1.0,
  textColor: '#FEF08A',
  bgOpacity: 0.78,
  learningMask: false,
  hoverPause: true
};

let currentConfig: YouTubeSubtitleStyleConfig = { ...DEFAULT_YT_SUBTITLE_CONFIG };
const listeners = new Set<(cfg: YouTubeSubtitleStyleConfig) => void>();

/**
 * 初始化加载持久化的 YouTube 字幕样式配置
 */
export function initSubtitleConfig(): void {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['ytSubtitleConfig', 'targetLang'], (res) => {
      if (res?.ytSubtitleConfig) {
        currentConfig = { ...DEFAULT_YT_SUBTITLE_CONFIG, ...res.ytSubtitleConfig };
      }
      if (res?.targetLang) {
        currentConfig.targetLang = res.targetLang;
      }
      notifyListeners();
    });
  }
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.targetLang) {
        const nextLang = changes.targetLang.newValue as TargetLanguage;
        if (nextLang && currentConfig.targetLang !== nextLang) {
          currentConfig.targetLang = nextLang;
          notifyListeners();
        }
      }
    });
  } catch (_) {}
}

export function getSubtitleConfig(): YouTubeSubtitleStyleConfig {
  return currentConfig;
}

export function updateSubtitleConfig(partial: Partial<YouTubeSubtitleStyleConfig>): YouTubeSubtitleStyleConfig {
  currentConfig = { ...currentConfig, ...partial };
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      chrome.storage.local.set({ ytSubtitleConfig: currentConfig });
      if (partial.targetLang) {
        chrome.storage.local.set({ targetLang: partial.targetLang });
      }
    } catch (_) {}
  }
  notifyListeners();
  return currentConfig;
}

export function onSubtitleConfigChange(fn: (cfg: YouTubeSubtitleStyleConfig) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(): void {
  listeners.forEach((fn) => {
    try {
      fn(currentConfig);
    } catch (_) {}
  });
}

/**
 * 将毫秒转为标准 SRT 时间戳格式 00:01:23,450
 */
export function formatSrtTime(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return (
    `${String(hours).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')},` +
    `${String(millis).padStart(3, '0')}`
  );
}

/**
 * 构建并挂载播放器内悬浮字幕设置菜单（纯 DOM API 构建）
 */
export function toggleSubtitleSettingsMenu(callbacks: {
  onToggleEnabled: (enabled: boolean) => void;
  onChangeTargetLang?: (lang: TargetLanguage) => void;
  onOpenSummary: () => void;
  onDownloadSrt: () => void;
}): void {
  if (typeof document === 'undefined') return;

  const existing = document.getElementById('translate-king-yt-subtitle-menu');
  if (existing) {
    existing.remove();
    return;
  }

  const player =
    document.getElementById('movie_player') ||
    document.querySelector('.html5-video-player, .bpx-player-container, #bilibili-player, .bilibili-player-video');
  if (!player) return;

  const menu = document.createElement('div');
  menu.id = 'translate-king-yt-subtitle-menu';
  menu.setAttribute('translate', 'no');
  menu.style.cssText = `
    position: absolute !important;
    bottom: 62px !important;
    right: 16px !important;
    width: 310px !important;
    background: rgba(15, 23, 42, 0.96) !important;
    backdrop-filter: blur(14px) !important;
    -webkit-backdrop-filter: blur(14px) !important;
    border: 1px solid rgba(59, 130, 246, 0.35) !important;
    border-radius: 14px !important;
    padding: 14px 16px !important;
    color: #F8FAFC !important;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif !important;
    font-size: 12.5px !important;
    z-index: 2500 !important;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65) !important;
    user-select: none !important;
  `;

  // 阻止菜单内点击穿透到视频播放器触发暂停
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('dblclick', (e) => e.stopPropagation());
  menu.addEventListener('mousedown', (e) => e.stopPropagation());

  // 顶部标题栏
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding-bottom: 10px !important;
    margin-bottom: 10px !important;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18) !important;
  `;

  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display: flex !important; align-items: center !important; gap: 6px !important; font-weight: 700 !important; font-size: 13.5px !important; color: #93C5FD !important;';
  titleWrap.textContent = '🎬 翻译王 · 双语字幕控制台';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    background: transparent !important;
    border: none !important;
    color: #94A3B8 !important;
    cursor: pointer !important;
    font-size: 14px !important;
    padding: 2px 6px !important;
    border-radius: 6px !important;
  `;
  closeBtn.addEventListener('click', () => menu.remove());

  header.appendChild(titleWrap);
  header.appendChild(closeBtn);
  menu.appendChild(header);

  const rerender = () => {
    menu.remove();
    toggleSubtitleSettingsMenu(callbacks);
  };

  // 辅助创建分段按钮行
  const createSegmentedRow = <T extends string | number | boolean>(
    labelText: string,
    options: Array<{ label: string; value: T }>,
    currentVal: T,
    onSelect: (val: T) => void
  ) => {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      margin-bottom: 9px !important;
      gap: 8px !important;
    `;

    const label = document.createElement('span');
    label.style.cssText = 'color: #CBD5E1 !important; font-size: 12px !important; flex-shrink: 0 !important;';
    label.textContent = labelText;

    const group = document.createElement('div');
    group.style.cssText = `
      display: inline-flex !important;
      background: rgba(30, 41, 59, 0.9) !important;
      border-radius: 7px !important;
      padding: 2px !important;
      gap: 2px !important;
    `;

    options.forEach((opt) => {
      const btn = document.createElement('button');
      const isSelected = opt.value === currentVal;
      btn.textContent = opt.label;
      btn.style.cssText = `
        border: none !important;
        padding: 4px 8px !important;
        border-radius: 5px !important;
        font-size: 11.5px !important;
        font-weight: ${isSelected ? '700' : '500'} !important;
        cursor: pointer !important;
        background: ${isSelected ? '#2563EB' : 'transparent'} !important;
        color: ${isSelected ? '#FFFFFF' : '#E2E8F0'} !important;
        transition: all 0.15s ease !important;
      `;
      btn.addEventListener('click', () => {
        onSelect(opt.value);
        rerender();
      });
      group.appendChild(btn);
    });

    row.appendChild(label);
    row.appendChild(group);
    return row;
  };

  // 1. 双语字幕总开关
  menu.appendChild(
    createSegmentedRow(
      '双语字幕开关',
      [
        { label: '开启 ON', value: true },
        { label: '关闭 OFF', value: false }
      ],
      currentConfig.enabled,
      (val) => {
        updateSubtitleConfig({ enabled: val });
        callbacks.onToggleEnabled(val);
      }
    )
  );

  // 2. 目标语言选择（全语言下拉菜单 + 4 个高频快捷药丸）
  const langRow = document.createElement('div');
  langRow.style.cssText = `
    display: flex !important;
    flex-direction: column !important;
    margin-bottom: 9px !important;
    gap: 5px !important;
  `;

  const langTopRow = document.createElement('div');
  langTopRow.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
  `;

  const langLabel = document.createElement('span');
  langLabel.style.cssText = 'color: #CBD5E1 !important; font-size: 12px !important;';
  langLabel.textContent = '翻译目标语言';

  const langSelect = document.createElement('select');
  langSelect.style.cssText = `
    background: rgba(30, 41, 59, 0.95) !important;
    color: #F8FAFC !important;
    border: 1px solid rgba(59, 130, 246, 0.45) !important;
    border-radius: 6px !important;
    padding: 3px 6px !important;
    font-size: 11.5px !important;
    outline: none !important;
    cursor: pointer !important;
  `;

  const allLanguages: Array<{ code: TargetLanguage; label: string }> = [
    { code: 'zh-CN', label: '🇨🇳 简体中文' },
    { code: 'zh-TW', label: '🇭🇰 繁體中文' },
    { code: 'ko', label: '🇰🇷 한국어' },
    { code: 'ja', label: '🇯🇵 日本語' },
    { code: 'en', label: '🇺🇸 English' },
    { code: 'fr', label: '🇫🇷 Français' },
    { code: 'de', label: '🇩🇪 Deutsch' },
    { code: 'es', label: '🇪🇸 Español' },
    { code: 'ru', label: '🇷🇺 Русский' }
  ];

  const currentLang = currentConfig.targetLang || 'zh-CN';

  allLanguages.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.label;
    if (l.code === currentLang) opt.selected = true;
    opt.style.cssText = 'background: #0F172A; color: #F8FAFC;';
    langSelect.appendChild(opt);
  });

  const onSelectLang = (newLang: TargetLanguage) => {
    if (newLang === currentConfig.targetLang) return;
    updateSubtitleConfig({ targetLang: newLang });
    callbacks.onChangeTargetLang?.(newLang);
    rerender();
  };

  langSelect.addEventListener('change', () => {
    onSelectLang(langSelect.value as TargetLanguage);
  });

  langTopRow.appendChild(langLabel);
  langTopRow.appendChild(langSelect);
  langRow.appendChild(langTopRow);

  // 4 个高频快捷药丸按钮
  const quickPillRow = document.createElement('div');
  quickPillRow.style.cssText = `
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    background: rgba(30, 41, 59, 0.75) !important;
    border-radius: 7px !important;
    padding: 2px !important;
  `;

  const quickLanguages: Array<{ code: TargetLanguage; label: string }> = [
    { code: 'zh-CN', label: '🇨🇳 中文' },
    { code: 'ko', label: '🇰🇷 韩语' },
    { code: 'ja', label: '🇯🇵 日语' },
    { code: 'en', label: '🇺🇸 英语' }
  ];

  quickLanguages.forEach((item) => {
    const btn = document.createElement('button');
    const isSel = item.code === currentLang;
    btn.textContent = item.label;
    btn.style.cssText = `
      flex: 1 !important;
      border: none !important;
      padding: 3px 0 !important;
      border-radius: 5px !important;
      font-size: 11px !important;
      font-weight: ${isSel ? '700' : '500'} !important;
      cursor: pointer !important;
      background: ${isSel ? '#2563EB' : 'transparent'} !important;
      color: ${isSel ? '#FFFFFF' : '#94A3B8'} !important;
      transition: all 0.15s ease !important;
      text-align: center !important;
    `;
    btn.addEventListener('click', () => onSelectLang(item.code));
    quickPillRow.appendChild(btn);
  });

  langRow.appendChild(quickPillRow);
  menu.appendChild(langRow);

  // 2. 字幕显示模式（双语对照 / 仅译文）
  menu.appendChild(
    createSegmentedRow(
      '显示模式',
      [
        { label: '双语对照', value: 'bilingual' as const },
        { label: '仅看译文', value: 'translation-only' as const }
      ],
      currentConfig.displayMode,
      (val) => updateSubtitleConfig({ displayMode: val })
    )
  );

  // 3. 译文位置（原文下方 / 原文上方）
  menu.appendChild(
    createSegmentedRow(
      '译文位置',
      [
        { label: '原文下方', value: 'bottom' as const },
        { label: '原文上方', value: 'top' as const }
      ],
      currentConfig.position,
      (val) => updateSubtitleConfig({ position: val })
    )
  );

  // 4. 译文字号比例
  menu.appendChild(
    createSegmentedRow(
      '译文字号',
      [
        { label: '小', value: 0.8 },
        { label: '标准', value: 1.0 },
        { label: '大', value: 1.2 },
        { label: '特大', value: 1.45 }
      ],
      currentConfig.fontScale,
      (val) => updateSubtitleConfig({ fontScale: val })
    )
  );

  // 5. 译文颜色圆点选择行
  const colorRow = document.createElement('div');
  colorRow.style.cssText = `
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    margin-bottom: 9px !important;
  `;
  const colorLabel = document.createElement('span');
  colorLabel.style.cssText = 'color: #CBD5E1 !important; font-size: 12px !important;';
  colorLabel.textContent = '译文颜色';

  const colorGroup = document.createElement('div');
  colorGroup.style.cssText = 'display: flex !important; align-items: center !important; gap: 8px !important;';

  const colors = [
    { hex: '#FEF08A', title: '柠檬亮黄' },
    { hex: '#FFFFFF', title: '纯净亮白' },
    { hex: '#22D3EE', title: '科技冰青' },
    { hex: '#4ADE80', title: '护眼翠绿' },
    { hex: '#F472B6', title: '活力柔粉' }
  ];

  colors.forEach((c) => {
    const dot = document.createElement('button');
    const isSel = currentConfig.textColor.toUpperCase() === c.hex;
    dot.setAttribute('title', c.title);
    dot.style.cssText = `
      width: 20px !important;
      height: 20px !important;
      border-radius: 50% !important;
      background: ${c.hex} !important;
      border: ${isSel ? '2px solid #3B82F6' : '1px solid rgba(255,255,255,0.3)'} !important;
      box-shadow: ${isSel ? '0 0 0 2px rgba(59, 130, 246, 0.45)' : 'none'} !important;
      cursor: pointer !important;
      padding: 0 !important;
    `;
    dot.addEventListener('click', () => {
      updateSubtitleConfig({ textColor: c.hex });
      rerender();
    });
    colorGroup.appendChild(dot);
  });

  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorGroup);
  menu.appendChild(colorRow);

  // 6. 背景不透明度
  menu.appendChild(
    createSegmentedRow(
      '背景底色',
      [
        { label: '透明', value: 0 },
        { label: '50%', value: 0.5 },
        { label: '78%', value: 0.78 },
        { label: '95%', value: 0.95 }
      ],
      currentConfig.bgOpacity,
      (val) => updateSubtitleConfig({ bgOpacity: val })
    )
  );

  // 7. 听力学习模式（模糊译文，鼠标悬停显示）
  menu.appendChild(
    createSegmentedRow(
      '听力遮罩模式',
      [
        { label: '正常显示', value: false },
        { label: '模糊译文(悬停显)', value: true }
      ],
      currentConfig.learningMask,
      (val) => updateSubtitleConfig({ learningMask: val })
    )
  );

  // 8. 悬停自动暂停视频
  menu.appendChild(
    createSegmentedRow(
      '悬停字幕暂停',
      [
        { label: '开启', value: true },
        { label: '关闭', value: false }
      ],
      currentConfig.hoverPause,
      (val) => updateSubtitleConfig({ hoverPause: val })
    )
  );

  // 底部快捷工具动作栏（下载双语 SRT / 打开视频总结）
  const footer = document.createElement('div');
  footer.style.cssText = `
    display: flex !important;
    gap: 8px !important;
    margin-top: 12px !important;
    padding-top: 10px !important;
    border-top: 1px solid rgba(148, 163, 184, 0.18) !important;
  `;

  const dlSrtBtn = document.createElement('button');
  dlSrtBtn.textContent = '📥 下载双语 SRT';
  dlSrtBtn.style.cssText = `
    flex: 1 !important;
    padding: 7px 8px !important;
    border-radius: 8px !important;
    border: 1px solid rgba(56, 189, 248, 0.4) !important;
    background: rgba(14, 116, 144, 0.35) !important;
    color: #7DD3FC !important;
    font-size: 11.5px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
  `;
  dlSrtBtn.addEventListener('click', () => {
    callbacks.onDownloadSrt();
  });

  const openSummaryBtn = document.createElement('button');
  openSummaryBtn.textContent = '✨ 视频总结/文稿';
  openSummaryBtn.style.cssText = `
    flex: 1 !important;
    padding: 7px 8px !important;
    border-radius: 8px !important;
    border: 1px solid rgba(59, 130, 246, 0.45) !important;
    background: rgba(37, 99, 235, 0.25) !important;
    color: #93C5FD !important;
    font-size: 11.5px !important;
    font-weight: 600 !important;
    cursor: pointer !important;
  `;
  openSummaryBtn.addEventListener('click', () => {
    menu.remove();
    callbacks.onOpenSummary();
  });

  footer.appendChild(dlSrtBtn);
  footer.appendChild(openSummaryBtn);
  menu.appendChild(footer);

  player.appendChild(menu);

  // 点击播放器外部区域时自动关闭菜单
  const closeOnOutside = (ev: MouseEvent) => {
    const target = ev.target as Node | null;
    const ctrlBtn = document.getElementById('translate-king-yt-control-btn');
    if (target && !menu.contains(target) && (!ctrlBtn || !ctrlBtn.contains(target))) {
      menu.remove();
      document.removeEventListener('click', closeOnOutside, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closeOnOutside, true);
  }, 50);
}
