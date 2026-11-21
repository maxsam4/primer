import { describe, it, expect } from 'vitest';
import { parseInboundMessage, parseWindowEnvelope } from './protocol.ts';
import { isTextRangeAnchor, isElementPathAnchor } from '@polygonlabs/primer-api-types';

describe('parseInboundMessage', () => {
  it('round-trips selection_captured', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'hello',
        prefix: 'before-',
        suffix: '-after',
        containerPath: 'body > p:nth-of-type(1)',
      },
      clientRects: [{ x: 1, y: 2, width: 3, height: 4 }],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips element_picked', () => {
    const ok = {
      type: 'element_picked',
      anchor: {
        type: 'element-path',
        path: 'body > div:nth-of-type(1) > canvas:nth-of-type(1)',
        innerHash: '0123456789abcdef',
      },
      clientRect: { x: 10, y: 20, width: 200, height: 80 },
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips pick_mode_exited', () => {
    expect(parseInboundMessage({ type: 'pick_mode_exited' })).toEqual({
      type: 'pick_mode_exited',
    });
  });

  it('round-trips selection_cleared', () => {
    expect(parseInboundMessage({ type: 'selection_cleared' })).toEqual({
      type: 'selection_cleared',
    });
  });

  it('round-trips anchor_positions including drifted entries', () => {
    const ok = {
      type: 'anchor_positions',
      positions: [
        { anchorId: 'a1', rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
        { anchorId: 'a2', rects: [], drifted: true },
      ],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips resize', () => {
    expect(parseInboundMessage({ type: 'resize', height: 768 })).toEqual({
      type: 'resize',
      height: 768,
    });
  });

  it('round-trips open_external', () => {
    expect(parseInboundMessage({ type: 'open_external', url: 'https://example.com' })).toEqual({
      type: 'open_external',
      url: 'https://example.com',
    });
  });

  it('returns null for missing type', () => {
    expect(parseInboundMessage({ foo: 'bar' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(parseInboundMessage({ type: 'nope' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseInboundMessage('hello')).toBeNull();
    expect(parseInboundMessage(null)).toBeNull();
    expect(parseInboundMessage(undefined)).toBeNull();
    expect(parseInboundMessage(42)).toBeNull();
  });

  it('returns null for selection_captured with malformed anchor', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'x' /* missing prefix/suffix/containerPath */ },
        clientRects: [],
      })
    ).toBeNull();
  });

  it('accepts selection_captured with position-based anchor', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        start: 100,
        end: 111,
      },
      clientRects: [{ x: 0, y: 0, width: 10, height: 10 }],
    };
    const parsed = parseInboundMessage(ok);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('selection_captured');
  });

  it('accepts selection_captured with legacy text-context anchor', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        prefix: 'before ',
        suffix: ' after',
        containerPath: 'body > article > p',
      },
      clientRects: [],
    };
    const parsed = parseInboundMessage(ok);
    expect(parsed).not.toBeNull();
  });

  it('rejects text-range anchor with neither position nor legacy shape', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'just text' },
        clientRects: [],
      })
    ).toBeNull();
  });

  it('rejects text-range anchor with only `start`, no `end`', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'x', start: 5 },
        clientRects: [],
      })
    ).toBeNull();
  });

  it('rejects text-range anchor with end <= start', () => {
    const parsed = parseInboundMessage({
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'x',
        start: 10,
        end: 10,
      },
      clientRects: [],
    });
    expect(parsed).toBeNull();
  });

  // Companion re-emits selection_captured with the same anchor but fresh
  // clientRects whenever the iframe scrolls or its body reflows, so the
  // parent's "Add comment" pill keeps tracking the selection. See
  // apps/api/src/companion/v1.js scheduleSelectionRectsRefresh().
  // Lock in that the parser accepts repeated emissions with the same
  // anchor + different rects.
  it('round-trips repeated selection_captured with same anchor, fresh rects', () => {
    const anchor = {
      type: 'text-range',
      selectorText: 'hello',
      start: 100,
      end: 105,
    };
    const first = {
      type: 'selection_captured',
      anchor,
      clientRects: [{ x: 10, y: 20, width: 50, height: 18 }],
    };
    const second = {
      type: 'selection_captured',
      anchor,
      clientRects: [{ x: 10, y: 120, width: 50, height: 18 }],
    };
    const parsedFirst = parseInboundMessage(first);
    const parsedSecond = parseInboundMessage(second);
    expect(parsedFirst).toEqual(first);
    expect(parsedSecond).toEqual(second);
    // Anchor identity is preserved across both emissions.
    if (parsedFirst?.type === 'selection_captured' &&
        parsedSecond?.type === 'selection_captured') {
      expect(parsedFirst.anchor).toEqual(parsedSecond.anchor);
    }
  });

  it('round-trips content_metrics', () => {
    expect(parseInboundMessage({ type: 'content_metrics', contentWidth: 812 })).toEqual({
      type: 'content_metrics',
      contentWidth: 812,
    });
  });

  it('rejects content_metrics without a positive finite width', () => {
    expect(parseInboundMessage({ type: 'content_metrics' })).toBeNull();
    expect(parseInboundMessage({ type: 'content_metrics', contentWidth: 0 })).toBeNull();
    expect(parseInboundMessage({ type: 'content_metrics', contentWidth: -5 })).toBeNull();
    expect(parseInboundMessage({ type: 'content_metrics', contentWidth: Infinity })).toBeNull();
    expect(parseInboundMessage({ type: 'content_metrics', contentWidth: '900' })).toBeNull();
  });
});

describe('parseInboundMessage — companion_log', () => {
  it('round-trips info level', () => {
    const ok = { type: 'companion_log', level: 'info', message: 'hello world' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips warn level', () => {
    const ok = { type: 'companion_log', level: 'warn', message: 'CSS Highlight API missing' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips error level', () => {
    const ok = { type: 'companion_log', level: 'error', message: 'boom' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('rejects companion_log with unknown level', () => {
    expect(
      parseInboundMessage({ type: 'companion_log', level: 'debug', message: 'x' })
    ).toBeNull();
  });

  it('rejects companion_log without message string', () => {
    expect(
      parseInboundMessage({ type: 'companion_log', level: 'info', message: 42 })
    ).toBeNull();
  });
});

describe('parseWindowEnvelope', () => {
  it('parses companion_ready', () => {
    expect(parseWindowEnvelope({ type: 'companion_ready', v: 1 })).toEqual({
      type: 'companion_ready',
    });
  });

  it('parses companion_panic with reason', () => {
    expect(
      parseWindowEnvelope({ type: 'companion_panic', reason: 'init exhausted' })
    ).toEqual({ type: 'companion_panic', reason: 'init exhausted' });
  });

  it('returns null for unknown type', () => {
    expect(parseWindowEnvelope({ type: 'something_else' })).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(parseWindowEnvelope({ foo: 'bar' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseWindowEnvelope(null)).toBeNull();
    expect(parseWindowEnvelope(undefined)).toBeNull();
    expect(parseWindowEnvelope('hi')).toBeNull();
  });

  it('returns null for companion_panic without reason string', () => {
    expect(parseWindowEnvelope({ type: 'companion_panic', reason: 42 })).toBeNull();
  });
});

describe('anchor guards (from @polygonlabs/primer-api-types)', () => {
  describe('isTextRangeAnchor', () => {
    it('accepts the position-based shape (start/end numbers, end > start)', () => {
      expect(
        isTextRangeAnchor({
          type: 'text-range',
          selectorText: 'hello',
          start: 5,
          end: 10,
        })
      ).toBe(true);
    });

    it('accepts the legacy shape (prefix/suffix/containerPath strings)', () => {
      expect(
        isTextRangeAnchor({
          type: 'text-range',
          selectorText: 'hello',
          prefix: 'before-',
          suffix: '-after',
          containerPath: 'body > p:nth-of-type(1)',
        })
      ).toBe(true);
    });

    it('rejects end <= start', () => {
      expect(
        isTextRangeAnchor({
          type: 'text-range',
          selectorText: 'hello',
          start: 10,
          end: 10,
        })
      ).toBe(false);
      expect(
        isTextRangeAnchor({
          type: 'text-range',
          selectorText: 'hello',
          start: 10,
          end: 5,
        })
      ).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isTextRangeAnchor(null)).toBe(false);
      expect(isTextRangeAnchor(undefined)).toBe(false);
      expect(isTextRangeAnchor('text-range')).toBe(false);
      expect(isTextRangeAnchor(42)).toBe(false);
    });

    it('rejects the wrong `type` tag', () => {
      expect(
        isTextRangeAnchor({
          type: 'element-path',
          selectorText: 'hello',
          start: 5,
          end: 10,
        })
      ).toBe(false);
    });

    it('rejects a shape with neither position nor legacy fields', () => {
      expect(isTextRangeAnchor({ type: 'text-range', selectorText: 'hello' })).toBe(false);
    });
  });

  describe('isElementPathAnchor', () => {
    it('accepts when `path` and `innerHash` are present', () => {
      expect(
        isElementPathAnchor({
          type: 'element-path',
          path: 'body > div:nth-of-type(1) > canvas:nth-of-type(1)',
          innerHash: '0123456789abcdef',
        })
      ).toBe(true);
    });

    it('rejects when `path` is missing', () => {
      expect(
        isElementPathAnchor({
          type: 'element-path',
          innerHash: '0123456789abcdef',
        })
      ).toBe(false);
    });

    it('rejects when `innerHash` is missing', () => {
      expect(
        isElementPathAnchor({
          type: 'element-path',
          path: 'body > div:nth-of-type(1)',
        })
      ).toBe(false);
    });

    it('rejects non-objects and the wrong `type` tag', () => {
      expect(isElementPathAnchor(null)).toBe(false);
      expect(isElementPathAnchor('element-path')).toBe(false);
      expect(
        isElementPathAnchor({
          type: 'text-range',
          path: 'body > div',
          innerHash: 'abc',
        })
      ).toBe(false);
    });
  });
});

describe('parseInboundMessage — submit_events (issue #78)', () => {
  const validEvent = {
    namespace: 'padd',
    type: 'export',
    payload: { verdict: 'approve' },
    audience: 'artifact',
  };

  it('round-trips a valid batch', () => {
    const msg = { type: 'submit_events', events: [validEvent] };
    expect(parseInboundMessage(msg)).toEqual(msg);
  });

  it('keeps a declared versionId and drops unknown fields', () => {
    const msg = {
      type: 'submit_events',
      events: [{ ...validEvent, versionId: 'abc-123', sneaky: 'dropped' }],
    };
    expect(parseInboundMessage(msg)).toEqual({
      type: 'submit_events',
      events: [{ ...validEvent, versionId: 'abc-123' }],
    });
  });

  it('accepts nested namespaces and null payloads', () => {
    const msg = {
      type: 'submit_events',
      events: [
        { namespace: 'padd/telemetry', type: 'ping', payload: null, audience: 'author' },
      ],
    };
    expect(parseInboundMessage(msg)).toEqual(msg);
  });

  it('rejects the whole batch when ANY event is invalid (all-or-nothing, matching the API)', () => {
    expect(
      parseInboundMessage({
        type: 'submit_events',
        events: [validEvent, { ...validEvent, audience: 'everyone' }],
      }),
    ).toBeNull();
  });

  it('rejects a missing audience — there is no default', () => {
    expect(
      parseInboundMessage({
        type: 'submit_events',
        events: [{ namespace: 'padd', type: 'export', payload: {} }],
      }),
    ).toBeNull();
  });

  it('rejects bad namespaces and types', () => {
    for (const bad of [
      { ...validEvent, namespace: 'Padd' },
      { ...validEvent, namespace: 'padd/' },
      { ...validEvent, namespace: '' },
      { ...validEvent, type: 'a/b' },
      { ...validEvent, type: '' },
    ]) {
      expect(parseInboundMessage({ type: 'submit_events', events: [bad] })).toBeNull();
    }
  });

  it('rejects an empty batch, a non-array, an oversized batch, and an oversized payload', () => {
    expect(parseInboundMessage({ type: 'submit_events', events: [] })).toBeNull();
    expect(parseInboundMessage({ type: 'submit_events', events: 'nope' })).toBeNull();
    expect(
      parseInboundMessage({
        type: 'submit_events',
        events: Array.from({ length: 101 }, () => validEvent),
      }),
    ).toBeNull();
    expect(
      parseInboundMessage({
        type: 'submit_events',
        events: [{ ...validEvent, payload: { big: 'x'.repeat(256 * 1024) } }],
      }),
    ).toBeNull();
  });

  it('rejects a payload that is absent or not JSON-serializable', () => {
    expect(
      parseInboundMessage({
        type: 'submit_events',
        events: [{ namespace: 'padd', type: 'export', audience: 'artifact' }],
      }),
    ).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      parseInboundMessage({
        type: 'submit_events',
        events: [{ ...validEvent, payload: circular }],
      }),
    ).toBeNull();
  });
});

describe('page text messages', () => {
  it('protocol parses page_elements and rejects malformed rects', () => {
    const ok = {
      type: 'page_elements',
      elements: [{ pid: 'p1', text: 'Roadmap', rect: { x: 1, y: 2, width: 3, height: 4 } }],
      embeds: [{ embedId: 'scores', rect: { x: 0, y: 10, width: 100, height: 40 } }],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
    // A malformed element is dropped (read-only), not the whole report.
    expect(parseInboundMessage({ ...ok, elements: [{ pid: 'p1', text: 'x', rect: { x: 1, y: 2, width: 'wide', height: 4 } }] })).toEqual({ ...ok, elements: [] });
    expect(parseInboundMessage({ ...ok, elements: [...ok.elements, { pid: 'p 1', text: 'x', rect: { x: 1, y: 2, width: 3, height: 4 } }] })).toEqual(ok);
    expect(parseInboundMessage({ type: 'page_rects', rects: { p1: { x: 0, y: 0, width: 1, height: 1 } }, embedRects: {} })).toEqual({
      type: 'page_rects',
      rects: { p1: { x: 0, y: 0, width: 1, height: 1 } },
      embedRects: {},
    });
    expect(parseInboundMessage({ type: 'page_rects', rects: { p1: { x: Infinity, y: 0, width: 1, height: 1 } }, embedRects: {} })).toBeNull();
    expect(parseInboundMessage({ type: 'pid_clicked', pid: 'p1' })).toEqual({ type: 'pid_clicked', pid: 'p1' });
    expect(parseInboundMessage({ type: 'embed_clicked', embedId: '<x>' })).toBeNull();
  });
});
