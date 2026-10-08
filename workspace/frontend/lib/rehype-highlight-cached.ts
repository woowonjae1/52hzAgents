import rehypeHighlight from 'rehype-highlight';

/*
  REHYPE-HIGHLIGHT, MEMOISED ACROSS MOUNTS.

  The transcript is virtualised (chat-messages.tsx), so a message is unmounted
  when it scrolls out of the overscan window and mounted again when it comes
  back. Every mount runs ReactMarkdown's pipeline from scratch, and the costly
  step in that pipeline is highlight.js tokenising each fenced block -- for a
  long agent reply that is most of the frame, paid again on every scroll back.

  The highlighted output of a block is a pure function of its language class
  and its text, so this plugin keeps it: a hit swaps in a copy of the stored
  children and skips highlight.js entirely; misses are highlighted by the real
  plugin and stored. Bounded by total characters, least recently used out
  first, so a streaming block -- a new text on every chunk -- cycles through
  the cache instead of growing it.
*/

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface Entry {
  className: unknown[];
  children: HastNode[];
  size: number;
}

/** Total characters of code kept highlighted. A few MB of hast at most. */
const MAX_CACHED_CHARS = 1_500_000;
/** One block bigger than this is highlighted every time rather than evicting everything else. */
const MAX_BLOCK_CHARS = 200_000;

const cache = new Map<string, Entry>();
let cachedChars = 0;

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (!node.children) return '';
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

function walk(node: HastNode, visit: (node: HastNode, parent: HastNode) => void): void {
  if (!node.children) return;
  for (const child of node.children) {
    visit(child, node);
    walk(child, visit);
  }
}

function remember(key: string, entry: Entry): void {
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cachedChars -= old.size;
  }
  cache.set(key, entry);
  cachedChars += entry.size;
  // Map iteration is insertion order, and hits re-insert: the first key is the LRU.
  for (const [k, v] of cache) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    cache.delete(k);
    cachedChars -= v.size;
  }
}

/** Drop-in for `rehypeHighlight` in a `rehypePlugins` array. */
export default function rehypeHighlightCached() {
  const highlight = rehypeHighlight() as unknown as (tree: HastNode, file: unknown) => void;

  return (tree: HastNode, file: unknown) => {
    const misses: { node: HastNode; key: string; size: number }[] = [];

    walk(tree, (node, parent) => {
      if (node.type !== 'element' || node.tagName !== 'code') return;
      if (parent.type !== 'element' || parent.tagName !== 'pre') return;
      const cls = node.properties?.className;
      const classes = Array.isArray(cls) ? cls.map(String) : [];
      // Without a language rehype-highlight leaves the block alone (no
      // auto-detect), so there is nothing to save.
      if (!classes.some((c) => c.startsWith('language-') || c.startsWith('lang-'))) return;

      const text = textOf(node);
      const key = `${classes.join(' ')}\u0000${text}`;
      const hit = cache.get(key);
      if (hit) {
        // Re-insert to mark it most recently used.
        cache.delete(key);
        cache.set(key, hit);
        node.properties = { ...node.properties, className: [...hit.className] };
        // A copy: react-markdown's post-processing may touch the tree it gets.
        node.children = structuredClone(hit.children);
        return;
      }
      misses.push({ node, key, size: text.length });
    });

    if (misses.length === 0) return;

    // Highlight only the misses. Each <code> node is shared with the real tree,
    // so the plugin's in-place rewrite lands there; the <pre> wrappers exist
    // only because the plugin requires a <pre> parent.
    highlight(
      {
        type: 'root',
        children: misses.map((m) => ({ type: 'element', tagName: 'pre', properties: {}, children: [m.node] })),
      },
      file
    );

    for (const m of misses) {
      if (m.size > MAX_BLOCK_CHARS) continue;
      const cls = m.node.properties?.className;
      remember(m.key, {
        className: Array.isArray(cls) ? [...cls] : [],
        children: structuredClone(m.node.children ?? []),
        size: m.size,
      });
    }
  };
}
