// Builds the online manual: a static HTML site (index.html + one page per
// document) and a Markdown set for the GitHub wiki.
//   node scripts/build-docs.mjs [outputDir]   (default: build/docs)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'build/docs'));
const repo = process.env.GITHUB_REPOSITORY || 'ultimumdesign/LayerForge';
const ref = process.env.GITHUB_REF_NAME || 'main';
const blobBase = `https://github.com/${repo}/blob/${ref}/`;
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const pages = [
  { src: 'README.md', slug: 'overview', wiki: 'Home', title: 'Overview' },
  { src: 'USER_GUIDE.md', slug: 'user-guide', wiki: 'User-Guide', title: 'User Guide' },
  { src: 'docs/DSP.md', slug: 'dsp-reference', wiki: 'DSP-Reference', title: 'DSP Reference' },
  { src: 'docs/ARCHITECTURE.md', slug: 'architecture', wiki: 'Architecture', title: 'Architecture' },
  { src: 'CONTRIBUTING.md', slug: 'contributing', wiki: 'Contributing', title: 'Contributing' },
  { src: 'RELEASING.md', slug: 'releasing', wiki: 'Releasing', title: 'Releasing' }
];
const bySrc = new Map(pages.map((page) => [page.src, page]));

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const textOf = (html) => html.replace(/<[^>]*>/g, '');
const slugify = (text) => text.toLowerCase().trim()
  .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

// Resolves a relative link found in `from` to either a manual page or a repo file.
function resolveLink(from, href) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return null;
  const [path, hash = ''] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  return { page: bySrc.get(target), target, hash: hash ? `#${hash}` : '' };
}

function renderer(page, mode) {
  const used = new Map();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const base = slugify(textOf(inner)) || 'section';
        const count = used.get(base) || 0;
        used.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const link = resolveLink(page.src, href);
        let target = href;
        if (link) {
          if (link.page) {
            target = mode === 'html' ? `${link.page.slug}.html${link.hash}` : `${link.page.wiki}${link.hash}`;
          } else {
            target = `${blobBase}${link.target}${link.hash}`;
          }
        }
        const attrs = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(target)}"${attrs}>${inner}</a>`;
      }
    }
  });
  return marked;
}

function wikiMarkdown(page, markdown) {
  // Rewrite relative Markdown links so they resolve inside the wiki or on GitHub.
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const link = resolveLink(page.src, href);
    if (!link) return whole;
    const target = link.page ? `${link.page.wiki}${link.hash}` : `${blobBase}${link.target}${link.hash}`;
    return `[${label}](${target})`;
  });
}

const css = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2330;--muted:#5b6475;--line:#d9dee7;--accent:#c2410c;--code:#f3f4f7;--side:#f7f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e4e7ee;--muted:#9aa3b5;--line:#2b3140;--accent:#fb923c;--code:#1d222c;--side:#181c24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif;display:flex;min-height:100vh}
nav{width:260px;flex:none;background:var(--side);border-right:1px solid var(--line);padding:24px 18px;position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{font-weight:700;font-size:1.1rem;margin-bottom:2px}nav .ver{color:var(--muted);font-size:.8rem;margin-bottom:18px}
nav a{display:block;padding:6px 10px;border-radius:6px;color:var(--fg);text-decoration:none}
nav a:hover{background:var(--code)}nav a[aria-current=page]{background:var(--accent);color:#fff}
main{flex:1;min-width:0;max-width:60rem;padding:32px 40px 64px}
h1,h2,h3{line-height:1.25}h2{border-bottom:1px solid var(--line);padding-bottom:.25em;margin-top:2em}
a{color:var(--accent)}code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em}
code{background:var(--code);padding:.1em .3em;border-radius:4px}pre{background:var(--code);padding:14px;border-radius:8px;overflow:auto}pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:6px 12px;text-align:left}th{background:var(--side)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;list-style:none;padding:0}
.cards a{display:block;border:1px solid var(--line);border-radius:10px;padding:16px;text-decoration:none;color:var(--fg)}
.cards a:hover{border-color:var(--accent)}.cards strong{display:block;color:var(--accent)}.cards span{color:var(--muted);font-size:.9rem}
@media(max-width:800px){body{display:block}nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:20px}}
`;

function shell({ title, current, body }) {
  const links = [{ slug: 'index', title: 'Manual index' }, ...pages]
    .map((p) => `<a href="${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a>`)
    .join('\n    ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · LayerForge Manual</title>
<style>${css}</style>
</head>
<body>
<nav aria-label="Manual">
  <div class="brand">LayerForge</div>
  <div class="ver">Manual · v${escapeHtml(version)}</div>
    ${links}
</nav>
<main>
${body}
</main>
</body>
</html>
`;
}

function firstParagraph(markdown) {
  const text = markdown.split(/\n\s*\n/).map((block) => block.trim())
    .find((block) => block && !/^(#|\||[-*] |```|\*\*Contents)/.test(block)) || '';
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').slice(0, 160);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'site'), { recursive: true });
mkdirSync(join(out, 'wiki'), { recursive: true });

const sources = pages.map((page) => ({ page, markdown: readFileSync(join(root, page.src), 'utf8') }));

for (const { page, markdown } of sources) {
  const body = renderer(page, 'html').parse(markdown);
  writeFileSync(join(out, 'site', `${page.slug}.html`), shell({ title: page.title, current: page.slug, body }));
  writeFileSync(join(out, 'wiki', `${page.wiki}.md`), wikiMarkdown(page, markdown));
}

const cards = sources.map(({ page, markdown }) =>
  `<li><a href="${page.slug}.html"><strong>${escapeHtml(page.title)}</strong><span>${escapeHtml(firstParagraph(markdown))}</span></a></li>`
).join('\n');
writeFileSync(join(out, 'site', 'index.html'), shell({
  title: 'Manual index',
  current: 'index',
  body: `<h1>LayerForge manual</h1>\n<p>Documentation for LayerForge ${escapeHtml(version)}, a drum layering plug-in.</p>\n<ul class="cards">\n${cards}\n</ul>`
}));

const index = pages.map((page) => `- [${page.title}](${page.wiki})`).join('\n');
writeFileSync(join(out, 'wiki', '_Sidebar.md'), `**LayerForge manual**\n\n${index}\n`);
writeFileSync(join(out, 'wiki', '_Footer.md'),
  `Generated from [the repository docs](https://github.com/${repo}/tree/${ref}) — edit them there, not in the wiki.\n`);

console.log(`Built ${pages.length} pages into ${out}`);
