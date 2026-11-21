import { describe, it, expect } from 'vitest';
import { buildMenuItems, type MenuItemId } from './documentActionsMenu.ts';

const ids = (items: { id: MenuItemId }[]) => items.map((i) => i.id);

describe('buildMenuItems', () => {
  it('shows document actions, separator, then comment actions for a non-uploader', () => {
    const items = buildMenuItems({ isUploader: false });
    expect(ids(items)).toEqual([
      'open-fullscreen',
      'download-html',
      'notebooklm',
      'separator',
      'copy',
      'download',
    ]);
  });

  it('appends a separator and delete for an uploader', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(ids(items)).toEqual([
      'open-fullscreen',
      'download-html',
      'notebooklm',
      'separator',
      'copy',
      'download',
      'separator',
      'delete',
    ]);
  });

  it('marks the delete item as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    const del = items.find((i) => i.id === 'delete');
    expect(del?.destructive).toBe(true);
  });

  it('does not mark non-destructive items as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    for (const id of ['open-fullscreen', 'download-html', 'notebooklm', 'copy', 'download'] as const) {
      expect(items.find((i) => i.id === id)?.destructive).toBeFalsy();
    }
  });

  it('labels every non-separator item with a string', () => {
    const items = buildMenuItems({ isUploader: true });
    for (const item of items) {
      if (item.id === 'separator') continue;
      expect(typeof item.label).toBe('string');
      expect(item.label!.length).toBeGreaterThan(0);
    }
  });

  it('puts a share entry first when includeShare is set for the uploader', () => {
    const items = buildMenuItems({ isUploader: true, includeShare: true });
    expect(items[0]).toEqual({ id: 'share', label: 'Share…' });
    expect(items[1]).toEqual({ id: 'separator' });
  });

  it('omits share for non-uploaders even when includeShare is set', () => {
    const ids = buildMenuItems({ isUploader: false, includeShare: true }).map((i) => i.id);
    expect(ids).not.toContain('share');
  });

  it('omits share when includeShare is absent', () => {
    const ids = buildMenuItems({ isUploader: true }).map((i) => i.id);
    expect(ids).not.toContain('share');
  });

  it('a page offers HTML but not Markdown export', () => {
    const ids = buildMenuItems({ isUploader: true, live: true, page: true }).map((i) => i.id);
    expect(ids).toContain('export-html');
    expect(ids).not.toContain('export-markdown');
  });
});
