/**
 * 翻译王 (TranslateKing) - 官方统一品牌矢量与图标系统
 *
 * 视觉规范：
 * 1. 皇家蓝/科技蓝渐变背景 (#2563EB -> #1D4ED8)
 * 2. 金黄色皇冠 (#FBBF24)
 * 3. 白色对话气泡 (#FFFFFF) + 粗体「A文」品牌标识 (#1D4ED8)
 * 4. 100% 严守 YouTube TrustedTypes 与各主流站点 CSP 规范（零 innerHTML，纯 DOM API）
 */

/**
 * 纯 DOM API 构建翻译王官方矢量 SVG Logo
 */
export function createTranslateKingSvgLogo(size = 24, idSuffix = 'logo'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('fill', 'none');
  svg.style.cssText =
    'display: block !important; border-radius: 6px !important; pointer-events: none !important; flex-shrink: 0 !important;';

  const gradId = `tk-logo-grad-${idSuffix}`;
  const defs = document.createElementNS(ns, 'defs');
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.id = gradId;
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '48');
  grad.setAttribute('y2', '48');
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');

  const s1 = document.createElementNS(ns, 'stop');
  s1.setAttribute('stop-color', '#2563EB');
  const s2 = document.createElementNS(ns, 'stop');
  s2.setAttribute('offset', '1');
  s2.setAttribute('stop-color', '#1D4ED8');
  grad.appendChild(s1);
  grad.appendChild(s2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 1. 皇家蓝圆角背景
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', '48');
  bg.setAttribute('height', '48');
  bg.setAttribute('rx', '11');
  bg.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(bg);

  // 2. 金黄色皇冠
  const crown = document.createElementNS(ns, 'path');
  crown.setAttribute('d', 'M14 17L17.5 22L24 16L30.5 22L34 17L35 24H13L14 17Z');
  crown.setAttribute('fill', '#FBBF24');
  svg.appendChild(crown);

  const c1 = document.createElementNS(ns, 'circle');
  c1.setAttribute('cx', '14');
  c1.setAttribute('cy', '15.5');
  c1.setAttribute('r', '1.8');
  c1.setAttribute('fill', '#FBBF24');
  svg.appendChild(c1);

  const c2 = document.createElementNS(ns, 'circle');
  c2.setAttribute('cx', '24');
  c2.setAttribute('cy', '14.5');
  c2.setAttribute('r', '2');
  c2.setAttribute('fill', '#FBBF24');
  svg.appendChild(c2);

  const c3 = document.createElementNS(ns, 'circle');
  c3.setAttribute('cx', '34');
  c3.setAttribute('cy', '15.5');
  c3.setAttribute('r', '1.8');
  c3.setAttribute('fill', '#FBBF24');
  svg.appendChild(c3);

  // 3. 白色对话气泡
  const bubble = document.createElementNS(ns, 'path');
  bubble.setAttribute(
    'd',
    'M10 28C10 24.686 12.686 22 16 22H32C35.314 22 38 24.686 38 28V36C38 39.314 35.314 42 32 42H18L13 46V42H16C12.686 42 10 39.314 10 36V28Z'
  );
  bubble.setAttribute('fill', '#FFFFFF');
  svg.appendChild(bubble);

  // 4. "A文" 品牌标识
  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', '13');
  text.setAttribute('y', '35');
  text.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif');
  text.setAttribute('font-size', '12.5');
  text.setAttribute('font-weight', '900');
  text.setAttribute('fill', '#1D4ED8');
  text.setAttribute('letter-spacing', '-0.5');
  text.textContent = 'A文';
  svg.appendChild(text);

  return svg;
}

/**
 * 创建高保真翻译王 Logo 容器
 * 优先加载高清 PNG 图标，加载失败或环境受限时秒级降级为精美矢量 SVG
 * 100% 遵守 TrustedTypes CSP (零 innerHTML)
 */
export function createTranslateKingLogoElement(size = 24, idSuffix = 'logo'): HTMLElement {
  const container = document.createElement('div');
  container.className = 'translate-king-logo-wrap';
  container.style.cssText = `width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; position: relative; flex-shrink: 0; pointer-events: none;`;

  const svgFallback = createTranslateKingSvgLogo(size, idSuffix);
  container.appendChild(svgFallback);

  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    try {
      const img = document.createElement('img');
      img.className = 'translate-king-logo-img';
      img.src = chrome.runtime.getURL('icons/icon-48.png');
      img.alt = '翻译王';
      img.style.cssText = `width: ${size}px; height: ${size}px; border-radius: 6px; object-fit: contain; display: block; pointer-events: none;`;
      img.onload = () => {
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
        container.appendChild(img);
      };
    } catch {
      // Ignored, svgFallback is preserved
    }
  }

  return container;
}
