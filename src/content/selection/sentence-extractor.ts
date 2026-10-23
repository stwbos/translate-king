/**
 * 翻译王 (TranslateKing) - 上下文原句智能捕获算法
 * 划词时自动以标点符号为边界，向上向下提取包含该生词的完整自然句子与页面出处
 * 支持智能识别缩写 (e.g. / i.e. / vs.) 与浮点数小数位，不切断原句
 */

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 清除生词边缘多余符号
 */
export function cleanWord(rawWord: string): string {
  if (!rawWord) return '';
  return rawWord.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * 从文本段落中提取包含目标词的完整句子
 */
export function extractSentenceFromText(fullText: string, targetWord: string): string {
  if (!fullText || !targetWord) return '';
  const cleaned = cleanWord(targetWord);
  if (!cleaned) return '';

  let wordIdx = -1;
  const escaped = escapeRegExp(cleaned);
  const boundaryRegex = new RegExp(`\\b${escaped}\\b`, 'i');
  const match = fullText.match(boundaryRegex);

  if (match && typeof match.index === 'number') {
    wordIdx = match.index;
  } else {
    wordIdx = fullText.toLowerCase().indexOf(cleaned.toLowerCase());
  }

  if (wordIdx === -1) {
    return fullText.trim().slice(0, 300);
  }

  // 向前搜寻句子起始标志 (排除 e.g./i.e. 等缩写及小数位，句首后接大写或标点)
  let start = 0;
  const preText = fullText.slice(0, wordIdx);
  const startRegex = /(?:(?<!\b(?:e\.g|i\.e|etc|vs|dr|mr|ms))\.(?!\d)|[!?。！？])["'”’）)\]]*\s+(?=[A-Z\u4e00-\u9fa5"'“‘])|[\n\r]+\s*/gi;
  const startMatches = [...preText.matchAll(startRegex)];
  if (startMatches.length > 0) {
    const lastMatch = startMatches[startMatches.length - 1];
    start = (lastMatch.index ?? 0) + lastMatch[0].length;
  }

  // 向后搜寻句子结束标志
  let end = fullText.length;
  const postText = fullText.slice(wordIdx);
  const endRegex = /(?:(?<!\b(?:e\.g|i\.e|etc|vs|dr|mr|ms))\.(?!\d)|[!?。！？]+)["'”’）)\]]*(?=\s+[A-Z\u4e00-\u9fa5"'“‘]|\s*$)|[\n\r]/i;
  const endMatch = postText.match(endRegex);
  if (endMatch && typeof endMatch.index === 'number') {
    end = wordIdx + endMatch.index + endMatch[0].length;
  }

  const sentence = fullText.slice(start, end).replace(/\s+/g, ' ').trim();
  return sentence.length > 0 ? sentence : fullText.trim();
}

/**
 * 从 DOM Selection 对象中爬取段落并提取完整句子
 */
export function extractSentenceFromSelection(selection: Selection): string {
  if (!selection || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  const selectedText = selection.toString().trim();
  if (!selectedText) return '';

  let container: Node | null = range.commonAncestorContainer;
  while (container && container.nodeType !== Node.ELEMENT_NODE) {
    container = container.parentNode;
  }

  const blockTags = new Set([
    'P', 'DIV', 'LI', 'ARTICLE', 'SECTION', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TD', 'TH', 'PRE', 'DD', 'DT', 'MAIN'
  ]);

  let el = container as HTMLElement | null;
  while (
    el &&
    el.parentElement &&
    el.tagName !== 'BODY' &&
    el.tagName !== 'HTML' &&
    !blockTags.has(el.tagName)
  ) {
    el = el.parentElement;
  }

  const paragraphText = (el?.textContent || '').trim();
  if (!paragraphText) return selectedText;

  return extractSentenceFromText(paragraphText, selectedText);
}
