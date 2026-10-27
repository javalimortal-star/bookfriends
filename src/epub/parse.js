const path = require('path').posix;
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { sanitizeChapterHtml } = require('./sanitize');

// Chapter img srcs are rewritten to `${MEDIA_BASE_PLACEHOLDER}/<name>`;
// the persistence layer replaces the placeholder once the book id is known.
const MEDIA_BASE_PLACEHOLDER = '__MEDIA_BASE__';

function decodeHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

const zipEntry = (zip, entryPath) => zip.getEntry(path.normalize(entryPath));

function zipEntryText(zip, entryPath) {
  const entry = zipEntry(zip, entryPath);
  if (!entry) throw new Error(`EPUB entry not found: ${path.normalize(entryPath)}`);
  return entry.getData().toString('utf8');
}

// dc: metadata helper — xmlMode keeps namespace prefixes in tag names.
function metaText($opf, localName) {
  let value = null;
  $opf('metadata').children().each((_, el) => {
    const name = el.tagName || '';
    if (name === localName || name.endsWith(`:${localName}`)) {
      const text = $opf(el).text().trim();
      if (text && !value) value = text;
    }
  });
  return value;
}

// The author: a dc:creator marked as one (opf:role="aut", or an EPUB 3
// <meta refines> role) wins over the others, such as whoever made the file
// ("ePub created by ..."); without roles, the first one.
function authorOf($opf) {
  const creators = $opf('metadata').children().toArray()
    .filter((el) => /(^|:)creator$/.test(el.tagName || ''))
    .map((el) => {
      const attr = Object.keys(el.attribs || {}).find((name) => /(^|:)role$/.test(name));
      const id = el.attribs && el.attribs.id;
      const refined = id ? $opf('metadata meta').filter((_, m) => m.attribs.refines === `#${id}` && m.attribs.property === 'role').first().text() : '';
      return { name: $opf(el).text().trim(), role: (attr ? el.attribs[attr] : refined).trim() };
    })
    .filter((c) => c.name);
  const author = creators.find((c) => c.role === 'aut') || creators[0];
  return author ? author.name : null;
}

function findOpfPath(zip) {
  const container = zipEntryText(zip, 'META-INF/container.xml');
  const $ = cheerio.load(container, { xmlMode: true });
  const opfPath = $('rootfile').first().attr('full-path');
  if (!opfPath) throw new Error('EPUB has no rootfile in META-INF/container.xml');
  return opfPath;
}

function parseManifest($opf) {
  const items = new Map();
  $opf('manifest > item').each((_, el) => {
    const $el = $opf(el);
    items.set($el.attr('id'), {
      id: $el.attr('id'),
      href: decodeHref($el.attr('href') || ''),
      mediaType: $el.attr('media-type') || '',
      properties: $el.attr('properties') || '',
    });
  });
  return items;
}

function findCoverItem($opf, manifest) {
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes('cover-image')) return item;
  }
  const coverId = $opf('metadata meta[name="cover"]').attr('content');
  if (coverId && manifest.has(coverId)) {
    const item = manifest.get(coverId);
    if (item.mediaType.startsWith('image/')) return item;
  }
  return null;
}

function findNcxItem($opf, manifest) {
  for (const item of manifest.values()) {
    if (item.mediaType === 'application/x-dtbncx+xml') return item;
  }
  const tocId = $opf('spine').attr('toc');
  if (tocId && manifest.has(tocId)) return manifest.get(tocId);
  return null;
}

function parseNavPoints(ncxXml, ncxDir) {
  const $ = cheerio.load(ncxXml, { xmlMode: true });
  const points = [];
  $('navMap navPoint').each((_, el) => {
    const $el = $(el);
    const label = $el.children('navLabel').children('text').first().text().trim()
      || $el.find('text').first().text().trim();
    const src = decodeHref($el.children('content').attr('src') || $el.find('content').first().attr('src') || '');
    if (!src) return;
    const [file, fragment] = src.split('#');
    points.push({
      title: label || 'Untitled',
      file: path.normalize(path.join(ncxDir, file)),
      fragment: fragment || null,
    });
  });
  return points;
}

// Wrappers a file may be split inside. Project Gutenberg puts a whole part
// (dozens of chapters) in one <div class="chapter">, and a self-closed
// <a id="..."/>, read as HTML, swallows everything after it; a <p> or a
// heading holding an anchor stays whole.
const CONTAINERS = new Set(['body', 'div', 'section', 'article', 'main', 'a', 'span']);

const contains = (outer, node) => {
  for (let n = node; n; n = n.parent) if (n === outer) return true;
  return false;
};

// The file's content as blocks in reading order, with every wrapper that holds
// an anchor opened up, so chapters can start between its children.
function blocksOf(node, anchorEls) {
  const blocks = [];
  for (const child of node.children || []) {
    if (child.type === 'text') {
      if (child.data.trim()) blocks.push(child);
    } else if (child.type === 'tag') {
      const opens = CONTAINERS.has(child.tagName) && anchorEls.some((el) => el !== child && contains(child, el));
      if (opens) blocks.push(...blocksOf(child, anchorEls));
      else blocks.push(child);
    }
  }
  return blocks;
}

// Cut one spine file at its navPoints' anchors: `lead` is what comes before
// the first anchor, `slices[i]` runs from anchor i to the next one (or the end
// of the file), `last` is the anchor whose chapter is still open at the end.
function sliceFile(fileXhtml, anchors) {
  const $ = cheerio.load(fileXhtml);
  const body = $('body')[0];
  const anchorEls = anchors.map(({ fragment }) => (fragment && $(`[id="${fragment}"]`)[0]) || null);
  const blocks = body ? blocksOf(body, anchorEls.filter(Boolean)) : [];
  const html = (from, to) => blocks.slice(from, to).map((node) => $.html(node)).join('\n');

  // an opened wrapper's chapter starts at its first block
  const starts = anchorEls.map((el) => {
    if (!el) return 0;
    const idx = blocks.findIndex((block) => contains(block, el) || contains(el, block));
    return idx === -1 ? 0 : idx;
  });
  const first = anchors.length ? Math.min(...starts) : blocks.length;
  let last = -1;
  starts.forEach((start, i) => { if (last === -1 || start >= starts[last]) last = i; });

  return {
    lead: html(0, first),
    slices: starts.map((start, i) => {
      let end = blocks.length;
      if (i + 1 < anchors.length) end = starts[i + 1] > start ? starts[i + 1] : start + 1;
      return html(start, end);
    }),
    last,
  };
}

// Rewrite img srcs to the media placeholder and collect image zip paths.
function rewriteImages(chapterHtml, fileDir, images) {
  const $ = cheerio.load(chapterHtml, null, false);
  $('img').each((_, el) => {
    const src = decodeHref($(el).attr('src') || '');
    if (!src || /^[a-z]+:/i.test(src)) {
      $(el).remove();
      return;
    }
    const zipPath = path.normalize(path.join(fileDir, src));
    let name = path.basename(zipPath);
    const existing = images.get(name);
    if (existing && existing !== zipPath) {
      name = `${images.size}-${name}`;
    }
    images.set(name, zipPath);
    $(el).attr('src', `${MEDIA_BASE_PLACEHOLDER}/${name}`);
  });
  return $.html();
}

// Unwrap anchors that aren't real external links. EPUB-internal anchors lose
// their attributes to sanitization; a leftover unclosed <a> makes the browser
// re-wrap every following paragraph in the link (all text renders link-blue).
function unwrapNonLinks(chapterHtml) {
  const $ = cheerio.load(chapterHtml, null, false);
  $('a').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) {
      $(el).replaceWith($(el).contents());
    }
  });
  return $.html();
}

// Assign stable 0-based data-p paragraph indexes: every <p> and childless-of-<p>
// <blockquote> that has visible text or an image gets one, in document order.
function assignParagraphIndexes(chapterHtml) {
  const $ = cheerio.load(chapterHtml, null, false);
  let index = 0;
  $('p, blockquote').each((_, el) => {
    const $el = $(el);
    if (el.tagName === 'blockquote' && $el.find('p').length > 0) return;
    const hasText = $el.text().trim().length > 0;
    const hasImg = $el.find('img').length > 0;
    if (!hasText && !hasImg) return;
    $el.attr('data-p', String(index));
    index += 1;
  });
  return { html: $.html(), paraCount: index };
}

function parseEpub(epubPath) {
  const zip = new AdmZip(epubPath);
  const opfPath = findOpfPath(zip);
  const opfDir = path.dirname(opfPath);
  const $opf = cheerio.load(zipEntryText(zip, opfPath), { xmlMode: true });

  const manifest = parseManifest($opf);
  const title = metaText($opf, 'title') || path.basename(epubPath, '.epub');
  const author = authorOf($opf);

  const coverItem = findCoverItem($opf, manifest);
  const cover = coverItem
    ? { zipPath: path.normalize(path.join(opfDir, coverItem.href)), ext: path.extname(coverItem.href) || '.img' }
    : null;

  const ncxItem = findNcxItem($opf, manifest);
  if (!ncxItem) throw new Error('EPUB has no NCX table of contents (unsupported for now)');
  const ncxPath = path.normalize(path.join(opfDir, ncxItem.href));
  const navPoints = parseNavPoints(zipEntryText(zip, ncxPath), path.dirname(ncxPath));
  if (navPoints.length === 0) throw new Error('EPUB NCX has no navPoints');

  // Group navPoints by file, preserving global order.
  const byFile = new Map();
  navPoints.forEach((point, order) => {
    if (!byFile.has(point.file)) byFile.set(point.file, []);
    byFile.get(point.file).push({ ...point, order });
  });

  // Chapters follow the reading order (the spine), from one anchor to the next
  // even across files: what comes before a file's first anchor, or a whole file
  // with none, continues the chapter before it. Before the first chapter
  // (a cover page, say) it is left out, except in the first chapter's own file.
  const spine = $opf('spine itemref').toArray()
    .map((el) => manifest.get($opf(el).attr('idref')))
    .filter(Boolean)
    .map((item) => path.normalize(path.join(opfDir, item.href)));
  const files = [...new Set([...spine, ...byFile.keys()])];
  const images = new Map();
  const parts = navPoints.map(() => []);
  let open = -1;
  for (const file of files) {
    const anchors = byFile.get(file) || [];
    if (!zipEntry(zip, file) || (!anchors.length && open === -1)) continue;
    const { lead, slices, last } = sliceFile(zipEntryText(zip, file), anchors);
    const media = (html) => rewriteImages(html, path.dirname(file), images);
    if (lead.trim()) parts[open !== -1 ? open : anchors[0].order].push(media(lead));
    anchors.forEach((anchor, i) => parts[anchor.order].push(media(slices[i])));
    if (anchors.length) open = anchors[last].order;
  }
  const chapters = navPoints.map((point, i) => {
    const sanitized = unwrapNonLinks(sanitizeChapterHtml(parts[i].join('\n')));
    const { html, paraCount } = assignParagraphIndexes(sanitized);
    return { title: point.title, contentHtml: html, paraCount };
  });

  return {
    title,
    author,
    cover,
    chapters,
    images: [...images.entries()].map(([name, zipPath]) => ({ name, zipPath })),
    readZipEntry: (zipPath) => {
      const entry = zipEntry(zip, zipPath);
      return entry ? entry.getData() : null;
    },
  };
}

module.exports = { parseEpub, MEDIA_BASE_PLACEHOLDER };
