// Thread anchors across block boundaries and edits elsewhere.
import { describe, it, expect } from 'vitest';
import { bodyText, placeTextRange } from './threadCarry.ts';

describe('selections across block boundaries', () => {
  // The browser's selection text carries line breaks between blocks; the DOM
  // text the offsets index has none. The highlight must survive both.
  const cases = [
    { name: 'paragraphs', html: '<p>First paragraph.</p><p>Second paragraph.</p>', text: 'First paragraph.\n\nSecond paragraph.' },
    { name: 'list items', html: '<ul><li>Apples</li><li>Oranges</li></ul>', text: 'Apples\nOranges' },
    { name: 'table cells', html: '<table><tr><td>Owner</td><td>Platform team</td></tr></table>', text: 'Owner\tPlatform team' },
  ];
  const edited = (html: string) => `<p>A new intro, added later.</p>\n${html}\n<p>And a footer.</p>`;

  for (const c of cases) {
    it(`keeps a selection across ${c.name}, unchanged or with an edit elsewhere`, () => {
      const origin = bodyText(c.html);
      const squeezedAt = (needle: string) => origin.text.replace(/ /g, '').indexOf(needle.replace(/\s/g, ''));
      // Offsets as the companion captures them: first to last selected character.
      const chars = [...origin.text].map((ch, i) => ({ ch, i })).filter((x) => x.ch !== ' ');
      const k = squeezedAt(c.text);
      const last = c.text.replace(/\s/g, '').length - 1;
      const withOffsets = {
        type: 'text-range' as const,
        selectorText: c.text,
        start: origin.rawOffset[chars[k].i],
        end: origin.rawOffset[chars[k + last].i] + 1,
      };
      const noOffsets = { type: 'text-range' as const, selectorText: c.text };

      for (const html of [c.html, edited(c.html)]) {
        const target = bodyText(html);
        for (const anchor of [withOffsets, noOffsets]) {
          const placed = placeTextRange(anchor, origin, target);
          expect(placed, `${c.name} on ${html}`).not.toBeNull();
          // The stored quote is the live DOM text (no block-boundary spaces), so the companion can find it.
          const dom = [...target.text].filter((_, i) => !target.synthetic[i]).join('');
          expect(dom).toContain(placed!.selectorText);
          expect(placed!.selectorText.replace(/\s/g, '')).toBe(c.text.replace(/\s/g, ''));
        }
      }
    });
  }

  // Word boundaries are part of the quote: a split or a join is a changed text.
  const wording = [
    { name: 'a split word joined', before: 'Please approve now here today.', quote: 'now here', after: 'Please approve nowhere today.' },
    { name: 'a joined word split', before: 'Please approve nowhere today.', quote: 'nowhere', after: 'Please approve now here today.' },
    { name: 'a space inserted in a word', before: 'Ship the roll out today.', quote: 'roll out', after: 'Ship the rollout today.' },
  ];
  for (const w of wording) {
    it(`reports ${w.name} as context changed`, () => {
      const origin = bodyText(`<p>${w.before}</p>`);
      const start = origin.text.indexOf(w.quote);
      const target = bodyText(`<p>${w.after}</p>`);
      for (const anchor of [
        { type: 'text-range' as const, selectorText: w.quote, start, end: start + w.quote.length },
        { type: 'text-range' as const, selectorText: w.quote },
      ]) {
        expect(placeTextRange(anchor, origin, target)).toBeNull();
      }
    });
  }

  it('still reports a changed quote as context changed', () => {
    const origin = bodyText(cases[0].html);
    const target = bodyText('<p>First paragraph.</p><p>Third paragraph.</p>');
    expect(placeTextRange({ type: 'text-range', selectorText: cases[0].text }, origin, target)).toBeNull();
  });
});
