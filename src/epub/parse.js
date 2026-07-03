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

function zipEntryText(zip, entryPath) {
  const normalized = path.normalize(entryPath).replace(/^\.\//, '');
  const entry = zip.getEntry(normalized);
  if (!entry) throw new Error(`EPUB entry not found: ${normalized}`);
  return entry.getData().toString('utf8');
}

function zipHasEntry(zip, entryPath) {
  return !!zip.getEntry(path.normalize(entryPath).replace(/^\.\//, ''));
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

// Slice a chapter out of a spine file: from the navPoint's anchor (lifted to its
// top-level ancestor under <body>) up to the next same-file anchor, else end of
// body. Handles multiple navPoints sharing one file via fragment anchors.
function sliceChapters(fileXhtml, anchors) {
  const $ = cheerio.load(fileXhtml);
  const bodyChildren = $('body').children().toArray();
  if (bodyChildren.length === 0) return anchors.map(() => '');

  const startIndexes = anchors.map(({ fragment }) => {
    if (!fragment) return 0;
    const el = $(`[id="${fragment}"]`).first();
    if (el.length === 0) return 0;
    let node = el[0];
    while (node.parent && node.parent.tagName !== 'body' && node.parent.type === 'tag') {
      node = node.parent;
    }
    const idx = bodyChildren.indexOf(node);
    return idx === -1 ? 0 : idx;
  });

  return anchors.map((_, i) => {
    const start = startIndexes[i];
    let end = bodyChildren.length;
    if (i + 1 < anchors.length) {
      end = startIndexes[i + 1] > start ? startIndexes[i + 1] : start + 1;
    }
    return bodyChildren.slice(start, end).map((node) => $.html(node)).join('\n');
  });
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
  const author = metaText($opf, 'creator') || null;

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

  const images = new Map();
  const chapters = new Array(navPoints.length);
  for (const [file, anchors] of byFile) {
    if (!zipHasEntry(zip, file)) {
      anchors.forEach((a) => { chapters[a.order] = { title: a.title, contentHtml: '', paraCount: 0 }; });
      continue;
    }
    const slices = sliceChapters(zipEntryText(zip, file), anchors);
    anchors.forEach((anchor, i) => {
      const withMedia = rewriteImages(slices[i], path.dirname(file), images);
      const sanitized = unwrapNonLinks(sanitizeChapterHtml(withMedia));
      const { html, paraCount } = assignParagraphIndexes(sanitized);
      chapters[anchor.order] = { title: anchor.title, contentHtml: html, paraCount };
    });
  }

  return {
    title,
    author,
    cover,
    chapters,
    images: [...images.entries()].map(([name, zipPath]) => ({ name, zipPath })),
    readZipEntry: (zipPath) => {
      const entry = zip.getEntry(path.normalize(zipPath));
      return entry ? entry.getData() : null;
    },
  };
}

module.exports = { parseEpub, MEDIA_BASE_PLACEHOLDER };
