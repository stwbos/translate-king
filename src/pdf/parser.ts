/**
 * 翻译王 (TranslateKing) - PDF 几何版面多栏聚类与 PDFMathTranslate 数学公式保护引擎
 *
 * 核心算法：
 * 1. 基于 PDFMathTranslate (pdf2zh) 原理的数学字体与行内公式识别：
 *    - 自动检测 CMMI / CMSY / CMEX / MSBM / Math / Symbol / STIX / CambriaMath 等数学字体
 *    - 自动识别 LaTeX 公式、希腊字母、微积分/集合算子、上下标变量与矩阵表达式
 *    - 翻译前替换为 {v1}, {v2} 占位符，翻译后 100% 无损还原为高亮数学公式节点
 * 2. 学术论文双栏/多栏几何坐标聚类算法 (Multi-Column Layout Clustering)：
 *    - 自动区分跨栏大标题/摘要 (Full-Width) 与左右双栏正文 (Left Column -> Right Column)
 *    - 自动愈合跨行连字符 (如 "trans-" + "former" -> "transformer")
 *    - 精确计算每个自然段在原版 PDF 页面上的归一化百分比坐标框 (normBox)，
 *      同时赋能【模式 A：沉浸式原位覆盖】与【模式 B：翻译王双向聚光灯精读】！
 */

export interface PdfRawTextItem {
  str: string;
  /** PDF.js transform 矩阵: [scaleX, skewY, skewX, scaleY, x, y] */
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfNormalizedBox {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

export type PdfBlockKind = 'heading' | 'paragraph' | 'formula' | 'caption';

export interface PdfParagraphBlock {
  id: string;
  pageNumber: number;
  kind: PdfBlockKind;
  column: 'full' | 'left' | 'right';
  originalText: string;
  /** 数学公式替换为 {v1}, {v2} 后的待翻译文本 */
  protectedText: string;
  /** 保护的原始数学公式片段数组，索引 0 对应 {v1} */
  mathTokens: string[];
  translatedText?: string;
  fontSize: number;
  bbox: PdfBoundingBox;
  normBox: PdfNormalizedBox;
}

export interface MathProtectedResult {
  protectedText: string;
  mathTokens: string[];
}

export interface RestoredSegment {
  type: 'text' | 'math';
  value: string;
}

const MATH_FONT_NAME_RE =
  /(?:CMMI|CMSY|CMEX|CMR|MSAM|MSBM|EUFM|EUSM|eurm|Math|Symbol|CambriaMath|NotoSansMath|STIX|LatinModernMath|Asana-Math|TeXGyre)/i;

const UNICODE_MATH_CHAR_RE =
  /[∑∫∏√∞∇∂∀∃∈∉⊆⊂⊇⊃∪∩≤≥≠≈≡±×÷→⇒⇔↦↔∝⊥∥∠∧∨¬⊕⊗⊙⊤⊥⊢⊨ℵℏℓℜℑ℘αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΥΦΨΩ]/;

/**
 * 匹配文本中的行内数学表达式（如 $...$、带上下标的变量 x_i / d_{model}、函数表达式 Softmax(...)、等式 a = b + c 等）
 */
const INLINE_MATH_EXPR_RE =
  /(\$[^$]+\$|\\[a-zA-Z]+(?:\{[^}]*\})*|\b[A-Za-z]+(?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+)+|\b(?:Attention|Softmax|MultiHead|Concat|LayerNorm|ReLU|GELU|argmin|argmax|log|exp|sin|cos|tan|lim|sup|inf)\s*\([^)]+\)|(?:[A-Za-z0-9_]+\s*[=≈≤≥≠∈⊂⊆+\-×÷]\s*[A-Za-z0-9_\\∑∫∏√∞∇∂α-ωΑ-Ω()^_{}\s]+[A-Za-z0-9_\\∑∫∏√∞∇∂α-ωΑ-Ω)²³])|[\u0370-\u03FF\u2200-\u22FF\u2190-\u21FF]+(?:\s*[A-Za-z0-9_^()+=\-]+)*)/g;

/**
 * 判断单个 PDF 文本碎片是否属于数学字体或纯数学符号
 */
export function isMathFontOrToken(fontName: string | undefined, text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;

  if (fontName && MATH_FONT_NAME_RE.test(fontName)) {
    // 若是 CMR 等混合字体但包含纯英文长单词（>=4 个字母且无数学符号），视为普通单词
    if (/CMR/i.test(fontName) && /^[A-Za-z]{4,}$/.test(trimmed)) {
      return false;
    }
    return true;
  }

  if (UNICODE_MATH_CHAR_RE.test(trimmed)) {
    return true;
  }

  // 典型变量下标/上标或简短等式
  if (/^(?:[A-Za-z]_[A-Za-z0-9{}]+|[A-Za-z]\^[A-Za-z0-9{}]+|\([0-9]+\))$/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * 将文本中的数学公式与预识别的数学字体片段替换为 {v1}, {v2} 占位符（PDFMathTranslate 协议）
 */
export function protectMathTokens(
  rawText: string,
  explicitMathFragments: string[] = []
): MathProtectedResult {
  if (!rawText) {
    return { protectedText: '', mathTokens: [] };
  }

  const mathTokens: string[] = [];
  let working = rawText;

  const registerToken = (mathStr: string): string => {
    const clean = mathStr.trim();
    if (!clean) return mathStr;
    const existingIdx = mathTokens.indexOf(clean);
    if (existingIdx !== -1) {
      return `{v${existingIdx + 1}}`;
    }
    mathTokens.push(clean);
    return `{v${mathTokens.length}}`;
  };

  // 1. 先保护由 PDF 数学字体层显式标记的片段
  const sortedExplicit = [...new Set(explicitMathFragments.map((s) => s.trim()).filter((s) => s.length >= 1))].sort(
    (a, b) => b.length - a.length
  );
  for (const frag of sortedExplicit) {
    // 跳过普通纯英文介词/连词
    if (/^(?:the|and|for|with|from|that|this|are|was|were|have|has|in|on|at|to|of|by|as|is|be|or|an|a)$/i.test(frag)) {
      continue;
    }
    if (UNICODE_MATH_CHAR_RE.test(frag) || /[=^_{}\\]/.test(frag)) {
      working = working.split(frag).join(registerToken(frag));
    }
  }

  // 2. 正则扫描行内公式、函数表达式与希腊字母算式
  working = working.replace(INLINE_MATH_EXPR_RE, (match) => {
    // 若已经是 {v1} 占位符本身，跳过
    if (/^\{v\d+\}$/.test(match.trim())) {
      return match;
    }
    // 避免误伤纯普通英文单词或普通年份范围 (如 2020-2024)
    if (/^[0-9]{4}\s*-\s*[0-9]{4}$/.test(match.trim())) {
      return match;
    }
    return registerToken(match);
  });

  return {
    protectedText: working,
    mathTokens
  };
}

/**
 * 将翻译后的文本（含 {v1}, { v1 }, ｛v1｝ 等占位符）无损还原为文本段与数学公式段
 */
export function restoreMathTokens(
  translatedText: string,
  mathTokens: string[]
): RestoredSegment[] {
  if (!translatedText) return [];
  if (!mathTokens || mathTokens.length === 0) {
    return [{ type: 'text', value: translatedText }];
  }

  const segments: RestoredSegment[] = [];
  const placeholderRe = /[｛{]\s*v(\d+)\s*[｝}]/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholderRe.exec(translatedText)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        value: translatedText.slice(lastIndex, match.index)
      });
    }
    const tokenIdx = parseInt(match[1], 10) - 1;
    const mathVal = mathTokens[tokenIdx];
    if (mathVal !== undefined) {
      segments.push({
        type: 'math',
        value: mathVal
      });
    } else {
      segments.push({
        type: 'text',
        value: match[0]
      });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < translatedText.length) {
    segments.push({
      type: 'text',
      value: translatedText.slice(lastIndex)
    });
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: translatedText }];
}

interface InternalTextLine {
  text: string;
  mathFragments: string[];
  x: number;
  y: number; // PDF 笛卡尔坐标系（原点在左下角，y 越大越靠上）
  topY: number; // 转换为屏幕顶部向下坐标系（原点在左上角，topY 越小越靠上）
  width: number;
  height: number;
  fontSize: number;
  isMathHeavy: boolean;
}

/**
 * 判断某一行是否是独立数学公式行或图表图注
 */
function classifyBlockKind(text: string, fontSize: number, medianFontSize: number, isMathHeavy: boolean): PdfBlockKind {
  const trimmed = text.trim();
  if (/^(?:Figure|Fig\.|Table|Algorithm)\s+\d+/i.test(trimmed)) {
    return 'caption';
  }
  if (
    isMathHeavy ||
    (/(\(\d+\)|\[\d+\])$/.test(trimmed) && UNICODE_MATH_CHAR_RE.test(trimmed) && trimmed.length < 140) ||
    (/^(?:Attention|MultiHead|FFN|LayerNorm)\s*\(/.test(trimmed) && trimmed.length < 160)
  ) {
    return 'formula';
  }
  if (
    fontSize >= medianFontSize * 1.18 ||
    /^(?:\d+(?:\.\d+)*\s+[A-Z]|Abstract\b|Introduction\b|Conclusion\b|References\b|Related Work\b)/i.test(trimmed)
  ) {
    if (trimmed.length <= 120) {
      return 'heading';
    }
  }
  return 'paragraph';
}

/**
 * 核心几何聚类函数：将单页 PDF.js 原始碎片文本聚合成按阅读顺序排列的自然段，并生成精确坐标与公式保护
 */
export function clusterPdfTextItemsToParagraphs(
  items: PdfRawTextItem[],
  pageWidth: number,
  pageHeight: number,
  pageNumber = 1
): PdfParagraphBlock[] {
  const validItems = (items || []).filter((it) => it && typeof it.str === 'string' && it.str.trim().length > 0);
  if (validItems.length === 0 || pageWidth <= 0 || pageHeight <= 0) {
    return [];
  }

  // 1. 将碎片项转换为带屏幕顶部坐标 (topY) 的标准化项
  const normalized = validItems.map((it) => {
    const tr = it.transform || [12, 0, 0, 12, 0, 0];
    const fontSize = Math.max(6, Math.abs(tr[3]) || Math.abs(tr[0]) || it.height || 10);
    const x = tr[4] || 0;
    const pdfY = tr[5] || 0;
    const h = Math.max(fontSize, it.height || fontSize);
    // PDF 的 (x, pdfY) 是文字基线左下角，转为左上角 topY
    const topY = Math.max(0, pageHeight - pdfY - h * 0.85);
    const w = Math.max(fontSize * 0.5, it.width || it.str.length * fontSize * 0.52);
    const isMath = isMathFontOrToken(it.fontName, it.str);
    return {
      str: it.str,
      x,
      pdfY,
      topY,
      width: w,
      height: h,
      fontSize,
      fontName: it.fontName,
      isMath
    };
  });

  // 计算全页字号中位数
  const fontSizes = normalized.map((n) => n.fontSize).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 10;

  // 2. 先按高度 topY 与水平坐标聚合为物理行 (InternalTextLine)
  // 注意：双栏论文中左右两栏可能处于同一个 topY，因此若两碎片水平间距大于 pageWidth * 0.06 且跨越中线，绝对不能合并为同一行！
  const centerX = pageWidth * 0.5;
  const sortedByY = [...normalized].sort((a, b) => {
    if (Math.abs(a.topY - b.topY) > Math.min(a.height, b.height) * 0.45) {
      return a.topY - b.topY;
    }
    return a.x - b.x;
  });

  const lines: InternalTextLine[] = [];
  for (const item of sortedByY) {
    // 寻找已有行中 topY 接近且处于同栏/相邻位置的候选行
    let targetLine: InternalTextLine | null = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
      const candidate = lines[i];
      const yDiff = Math.abs(candidate.topY - item.topY);
      const lineTol = Math.max(candidate.height, item.height) * 0.55;
      if (yDiff <= lineTol) {
        const candidateRight = candidate.x + candidate.width;
        const horizontalGap = item.x - candidateRight;
        const crossesCenterColumnGap =
          candidateRight <= centerX * 1.04 &&
          item.x >= centerX * 0.94 &&
          horizontalGap > Math.max(candidate.fontSize * 1.8, pageWidth * 0.035);
        if (!crossesCenterColumnGap && horizontalGap >= -candidate.fontSize * 2) {
          targetLine = candidate;
          break;
        }
      }
    }

    if (!targetLine) {
      lines.push({
        text: item.str.trim(),
        mathFragments: item.isMath ? [item.str.trim()] : [],
        x: item.x,
        y: item.pdfY,
        topY: item.topY,
        width: item.width,
        height: item.height,
        fontSize: item.fontSize,
        isMathHeavy: item.isMath
      });
    } else {
      const prevRight = targetLine.x + targetLine.width;
      const gap = item.x - prevRight;
      const needsSpace =
        gap > targetLine.fontSize * 0.18 &&
        !/[\s\-([/]$/.test(targetLine.text) &&
        !/^[,.;:?!)\]]/.test(item.str.trim());
      targetLine.text += (needsSpace ? ' ' : '') + item.str.trim();
      if (item.isMath) {
        targetLine.mathFragments.push(item.str.trim());
      }
      const newRight = Math.max(prevRight, item.x + item.width);
      targetLine.x = Math.min(targetLine.x, item.x);
      targetLine.width = newRight - targetLine.x;
      targetLine.topY = Math.min(targetLine.topY, item.topY);
      targetLine.height = Math.max(targetLine.height, item.height);
      targetLine.fontSize = Math.max(targetLine.fontSize, item.fontSize);
      if (item.isMath && targetLine.mathFragments.join('').length > targetLine.text.length * 0.45) {
        targetLine.isMathHeavy = true;
      }
    }
  }

  // 过滤纯页码行
  const meaningfulLines = lines.filter((ln) => {
    const t = ln.text.trim();
    if (!t) return false;
    if (/^\d{1,4}$/.test(t) && (ln.topY < pageHeight * 0.08 || ln.topY > pageHeight * 0.91)) {
      return false;
    }
    return true;
  });

  // 3. 判定每行所属栏位 ('full' | 'left' | 'right')
  const classifiedLines = meaningfulLines.map((ln) => {
    const rightEdge = ln.x + ln.width;
    let column: 'full' | 'left' | 'right' = 'full';
    if (ln.width < pageWidth * 0.48) {
      if (rightEdge <= pageWidth * 0.53) {
        column = 'left';
      } else if (ln.x >= pageWidth * 0.46) {
        column = 'right';
      }
    }
    return { ...ln, column };
  });

  // 检查页面是否存在明显的双栏结构
  const leftCount = classifiedLines.filter((l) => l.column === 'left').length;
  const rightCount = classifiedLines.filter((l) => l.column === 'right').length;
  const isTwoColumnPage = leftCount >= 2 && rightCount >= 2;

  let orderedLines = classifiedLines;
  if (isTwoColumnPage) {
    const firstColumnY = Math.min(
      ...classifiedLines.filter((l) => l.column !== 'full').map((l) => l.topY)
    );
    const topFullLines = classifiedLines
      .filter((l) => l.column === 'full' && l.topY < firstColumnY)
      .sort((a, b) => a.topY - b.topY);
    const leftLines = classifiedLines
      .filter((l) => l.column === 'left')
      .sort((a, b) => a.topY - b.topY);
    const rightLines = classifiedLines
      .filter((l) => l.column === 'right')
      .sort((a, b) => a.topY - b.topY);
    const bottomFullLines = classifiedLines
      .filter((l) => l.column === 'full' && l.topY >= firstColumnY)
      .sort((a, b) => a.topY - b.topY);
    orderedLines = [...topFullLines, ...leftLines, ...rightLines, ...bottomFullLines];
  } else {
    orderedLines = [...classifiedLines].sort((a, b) => a.topY - b.topY);
  }

  // 4. 将同栏相邻行聚类为完整语义段落 (PdfParagraphBlock)
  const blocks: PdfParagraphBlock[] = [];

  interface DraftParagraph {
    column: 'full' | 'left' | 'right';
    kind: PdfBlockKind;
    lines: typeof orderedLines;
  }

  let currentDraft: DraftParagraph | null = null;

  const flushDraft = () => {
    if (!currentDraft || currentDraft.lines.length === 0) return;
    const ls = currentDraft.lines;
    let mergedText = '';
    const allMathFrags: string[] = [];

    for (let i = 0; i < ls.length; i++) {
      const lineText = ls[i].text.trim();
      allMathFrags.push(...ls[i].mathFragments);
      if (i === 0) {
        mergedText = lineText;
      } else {
        // 愈合英文跨行连字符 (如 "trans-" + "former" -> "transformer")
        if (/[a-zA-Z]-$/.test(mergedText) && /^[a-z]/.test(lineText)) {
          mergedText = mergedText.slice(0, -1) + lineText;
        } else {
          mergedText += ' ' + lineText;
        }
      }
    }

    const minX = Math.min(...ls.map((l) => l.x));
    const minTopY = Math.min(...ls.map((l) => l.topY));
    const maxRight = Math.max(...ls.map((l) => l.x + l.width));
    const maxBottom = Math.max(...ls.map((l) => l.topY + l.height));
    const maxFont = Math.max(...ls.map((l) => l.fontSize));

    const width = Math.max(16, maxRight - minX);
    const height = Math.max(maxFont * 1.15, maxBottom - minTopY);

    const { protectedText, mathTokens } = protectMathTokens(mergedText, allMathFrags);

    const blockIdx = blocks.length + 1;
    blocks.push({
      id: `p${pageNumber}-b${blockIdx}`,
      pageNumber,
      kind: currentDraft.kind,
      column: currentDraft.column,
      originalText: mergedText,
      protectedText,
      mathTokens,
      fontSize: maxFont,
      bbox: {
        x: minX,
        y: minTopY,
        width,
        height
      },
      normBox: {
        leftPct: Number(Math.max(0, Math.min(96, (minX / pageWidth) * 100)).toFixed(2)),
        topPct: Number(Math.max(0, Math.min(98, (minTopY / pageHeight) * 100)).toFixed(2)),
        widthPct: Number(Math.max(4, Math.min(100, (width / pageWidth) * 100)).toFixed(2)),
        heightPct: Number(Math.max(1.2, Math.min(100, (height / pageHeight) * 100)).toFixed(2))
      }
    });

    currentDraft = null;
  };

  for (const ln of orderedLines) {
    const lineKind = classifyBlockKind(ln.text, ln.fontSize, medianFontSize, ln.isMathHeavy);
    if (!currentDraft) {
      currentDraft = {
        column: ln.column,
        kind: lineKind,
        lines: [ln]
      };
      continue;
    }

    const prevLine = currentDraft.lines[currentDraft.lines.length - 1];
    const verticalGap = ln.topY - (prevLine.topY + prevLine.height);
    const maxAllowedGap = Math.max(prevLine.height, ln.height) * 0.85;
    const sameColumn = currentDraft.column === ln.column;
    const sameFontSize = Math.abs(prevLine.fontSize - ln.fontSize) <= 1.6;
    const prevEndsWithSentenceStop = /[.:?!。？！]$/.test(prevLine.text.trim()) && prevLine.width < pageWidth * 0.34;

    if (
      sameColumn &&
      currentDraft.kind === 'paragraph' &&
      lineKind === 'paragraph' &&
      sameFontSize &&
      verticalGap >= -prevLine.height * 0.5 &&
      verticalGap <= maxAllowedGap &&
      !prevEndsWithSentenceStop
    ) {
      currentDraft.lines.push(ln);
    } else {
      flushDraft();
      currentDraft = {
        column: ln.column,
        kind: lineKind,
        lines: [ln]
      };
    }
  }

  flushDraft();
  return blocks;
}

/**
 * 将纯文本 / Markdown / SRT 字幕文件解析为兼容的双语文档段落块（支持本地文档上传）
 */
export function parsePlainDocumentToBlocks(content: string, fileName = 'document.txt'): PdfParagraphBlock[] {
  const lines = (content || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const blocks: PdfParagraphBlock[] = [];
  let pageNumber = 1;
  let currentY = 40;
  const pageWidth = 600;
  const pageHeight = 840;

  for (const rawChunk of lines) {
    const text = rawChunk
      .replace(/^\d+\s*\n\d{2}:\d{2}:\d{2}[,.:]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.:]\d{3}\s*\n/gm, '')
      .replace(/\n+/g, ' ')
      .trim();
    if (!text) continue;

    const isHeading = /^#{1,4}\s+/.test(text) || (text.length < 70 && !/[.,;?!。，；？！]$/.test(text));
    const cleanText = text.replace(/^#{1,4}\s+/, '').trim();
    const { protectedText, mathTokens } = protectMathTokens(cleanText);
    const estHeight = Math.max(28, Math.ceil(cleanText.length / 65) * 22);

    if (currentY + estHeight > pageHeight - 50) {
      pageNumber++;
      currentY = 40;
    }

    blocks.push({
      id: `p${pageNumber}-b${blocks.length + 1}`,
      pageNumber,
      kind: isHeading ? 'heading' : 'paragraph',
      column: 'full',
      originalText: cleanText,
      protectedText,
      mathTokens,
      fontSize: isHeading ? 15 : 11,
      bbox: { x: 48, y: currentY, width: 504, height: estHeight },
      normBox: {
        leftPct: 8,
        topPct: Number(((currentY / pageHeight) * 100).toFixed(2)),
        widthPct: 84,
        heightPct: Number(((estHeight / pageHeight) * 100).toFixed(2))
      }
    });

    currentY += estHeight + 16;
  }

  return blocks;
}
