import { describe, it, expect } from 'vitest';
import { translateBatch } from '../src/background/translator';

describe('TOC Batch Translation Test', () => {
  it('translates all TOC strings', async () => {
    const tocTexts = [
      'Contents',
      'move to sidebar',
      'hide',
      'Structure',
      'Installation type',
      'Publishing architectures',
      'Content modeling',
      'Common features',
      'Other types of content management systems',
      'Widely used CMSs',
      'Cross-reference',
      'Toggle Cross-reference subsection',
      'Structure',
      'Enhancing usability',
      'See also',
      'References',
      'Toggle References subsection',
      'Bibliography',
      'External links',
      '(Top)'
    ];

    const res = await translateBatch(tocTexts, 'zh-CN');
    console.log('=== TOC TRANSLATIONS ===');
    res.translations.forEach((t, i) => console.log(`[${i}] "${tocTexts[i]}" -> "${t}"`));
    expect(res.translations.length).toBe(tocTexts.length);
  });
});
