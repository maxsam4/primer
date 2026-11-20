import { describe, expect, it } from 'vitest';
import { inputToBlocks } from './convert.ts';

describe('inputToBlocks', () => {
  it('reads a Markdown task item as a check list item, as primer_get_doc writes it', async () => {
    const { nodes } = await inputToBlocks('* [x] ship it');
    const block = nodes[0]!.firstChild!;
    expect(block.type.name).toBe('checkListItem');
    expect(block.attrs.checked).toBe(true);
    expect(block.textContent).toBe('ship it');
  });
});
