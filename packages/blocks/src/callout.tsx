/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { createReactBlockSpec } from '@blocknote/react';
import { useBlockText, usePrimerBlockServices } from './services.ts';
import type { BlockText } from './text.ts';

/** Callout kinds, and the GitHub alert each one reads and exports as. */
export const CALLOUT_KINDS = ['info', 'warning', 'success', 'note'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** GitHub's alert markers by kind. Import also reads CAUTION as a warning. */
export const CALLOUT_ALERTS: Record<CalloutKind, string> = {
  note: 'NOTE',
  success: 'TIP',
  info: 'IMPORTANT',
  warning: 'WARNING',
};

const LABEL_KEY = {
  info: 'calloutInfo',
  warning: 'calloutWarning',
  success: 'calloutSuccess',
  note: 'calloutNote',
} as const satisfies Record<CalloutKind, keyof BlockText>;

const ICON: Record<CalloutKind, string> = { info: 'ℹ', warning: '⚠', success: '✓', note: '✎' };

/** The kind a block holds: the document is client-writable, so anything else is a note. */
export function calloutKind(raw: unknown): CalloutKind {
  return (CALLOUT_KINDS as readonly string[]).includes(raw as string) ? (raw as CalloutKind) : 'note';
}

/**
 * A callout: highlighted inline text with a kind (BlockNote's prop-driven
 * alert pattern). It reads and exports as a GitHub alert (`> [!NOTE]`), so a
 * Markdown document keeps its alerts.
 */
export const calloutBlock = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      kind: { default: 'note', values: CALLOUT_KINDS },
    },
    content: 'inline',
  },
  {
    render: (props) => <CalloutView {...(props as unknown as CalloutViewProps)} />,
    // Markdown and plain HTML exports: a quote that opens with its alert marker.
    toExternalHTML: (props) => (
      <blockquote data-primer-callout={calloutKind(props.block.props.kind)}>
        <p>[!{CALLOUT_ALERTS[calloutKind(props.block.props.kind)]}]</p>
        <p ref={props.contentRef} />
      </blockquote>
    ),
  },
);

type CalloutViewProps = {
  block: { id: string; props: { kind: string } };
  editor: { isEditable: boolean; updateBlock(id: string, update: { props: { kind: CalloutKind } }): unknown };
  contentRef: (node: HTMLElement | null) => void;
};

function CalloutView({ block, editor, contentRef }: CalloutViewProps) {
  const text = useBlockText();
  // Only the live editor (which provides services) changes the kind; exports and static renders show it.
  const services = usePrimerBlockServices();
  const editable = editor.isEditable && services !== null;
  const kind = calloutKind(block.props.kind);
  return (
    <div className="primer-callout" data-primer-callout={kind}>
      <span className="primer-callout-icon" contentEditable={false}>
        {editable ? (
          <select
            aria-label={text.calloutKind}
            value={kind}
            onChange={(e) => editor.updateBlock(block.id, { props: { kind: calloutKind(e.target.value) } })}
          >
            {CALLOUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {ICON[k]} {text[LABEL_KEY[k]]}
              </option>
            ))}
          </select>
        ) : (
          <span className="primer-callout-label">
            {ICON[kind]} {text[LABEL_KEY[kind]]}
          </span>
        )}
      </span>
      <div className="primer-callout-body" ref={contentRef} />
    </div>
  );
}
