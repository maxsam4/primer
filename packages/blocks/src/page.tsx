import { createReactBlockSpec } from '@blocknote/react';
import { usePrimerBlockServices } from './services.ts';

/**
 * An HTML page (M6): the agent's page in its sandboxed frame, with its text
 * and its `<primer-*>` blocks edited in Primer's own window. The page's text
 * lives in sub-fragments `page/<blockId>/<pid>` and its blocks in
 * `embed/<blockId>/<embedId>`; this block only names them.
 *
 * - `sourceKey`: the stamped source in storage (`pages/<documentId>/<id>.html`),
 *   checked against the document by the server before any read;
 * - `pids` and `embeds`: the page's current pids and embed ids, space
 *   separated, so reachability (and thread orphaning) follows republishes.
 *
 * The web app renders the frame through `PageView`; elsewhere (the server
 * editor, static renders) the block shows its title.
 */
export const pageBlock = createReactBlockSpec(
  {
    type: 'page',
    propSchema: {
      sourceKey: { default: '' },
      title: { default: '' },
      pids: { default: '' },
      embeds: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block }) => <PageBlockView blockId={block.id} title={block.props.title} sourceKey={block.props.sourceKey} />,
  },
);

function PageBlockView({ blockId, title, sourceKey }: { blockId: string; title: string; sourceKey: string }) {
  const PageView = usePrimerBlockServices()?.PageView;
  if (PageView) return <PageView blockId={blockId} title={title} sourceKey={sourceKey} />;
  return (
    <div className="primer-page" data-primer-page={blockId}>
      {title}
    </div>
  );
}
