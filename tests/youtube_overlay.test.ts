// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SubtitleOverlay } from '../src/content/youtube/overlay';
import { SubtitleCue } from '../src/content/youtube/types';

describe('YouTube 双语字幕渲染器 (SubtitleOverlay)', () => {
  let playerEl: HTMLElement;
  let videoEl: HTMLVideoElement;
  let overlay: SubtitleOverlay;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="movie_player" style="position: relative; width: 1280px; height: 720px;">
        <video src="mock.mp4"></video>
      </div>
    `;

    playerEl = document.getElementById('movie_player')!;
    videoEl = playerEl.querySelector('video')!;

    // Mock HTMLMediaElement methods
    videoEl.play = vi.fn().mockResolvedValue(undefined);
    videoEl.pause = vi.fn();

    overlay = new SubtitleOverlay();
  });

  afterEach(() => {
    overlay.destroy();
    document.body.innerHTML = '';
  });

  it('应当在 #movie_player 内部正确挂载外层穿透容器与内层文字容器', () => {
    const overlayEl = document.getElementById('translate-king-yt-overlay');
    expect(overlayEl).not.toBeNull();
    expect(overlayEl?.parentElement).toBe(playerEl);

    const box = overlayEl?.querySelector('.translate-king-yt-box');
    expect(box).not.toBeNull();
  });

  it('渲染有效双语字幕段时应当同时呈现原文与黄色译文', () => {
    const cue: SubtitleCue = {
      id: 1,
      startMs: 1000,
      endMs: 3500,
      originalText: 'Artificial Intelligence is evolving rapidly.',
      translatedText: '人工智能正在迅速演进。'
    };

    overlay.renderCue(cue);

    const origEl = playerEl.querySelector('.translate-king-yt-orig');
    const transEl = playerEl.querySelector('.translate-king-yt-trans') as HTMLElement;
    const box = playerEl.querySelector('.translate-king-yt-box') as HTMLElement;

    expect(origEl?.textContent).toBe(cue.originalText);
    expect(transEl?.textContent).toBe(cue.translatedText);
    expect(transEl.style.display).toBe('block');
    expect(box.style.display).toBe('inline-flex');
  });

  it('译文尚未返回时应当仅显示英文原文，隐藏译文行以避免空行闪烁', () => {
    const cue: SubtitleCue = {
      id: 2,
      startMs: 4000,
      endMs: 6000,
      originalText: 'Loading next sentence...'
    };

    overlay.renderCue(cue);

    const origEl = playerEl.querySelector('.translate-king-yt-orig');
    const transEl = playerEl.querySelector('.translate-king-yt-trans') as HTMLElement;

    expect(origEl?.textContent).toBe(cue.originalText);
    expect(transEl.style.display).toBe('none');
  });

  it('传入 null 时应当隐藏字幕盒子', () => {
    overlay.renderCue(null);

    const box = playerEl.querySelector('.translate-king-yt-box') as HTMLElement;
    expect(box.style.display).toBe('none');
  });

  it('鼠标悬停在字幕上时应当自动调用 video.pause()，离开时自动恢复播放', () => {
    const box = playerEl.querySelector('.translate-king-yt-box')!;

    // 模拟视频正在播放
    Object.defineProperty(videoEl, 'paused', { value: false, configurable: true });

    // 鼠标移入字幕
    box.dispatchEvent(new MouseEvent('mouseenter'));
    expect(videoEl.pause).toHaveBeenCalledTimes(1);

    // 鼠标移出字幕
    box.dispatchEvent(new MouseEvent('mouseleave'));
    expect(videoEl.play).toHaveBeenCalledTimes(1);
  });
});
