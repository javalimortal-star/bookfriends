const sanitizeHtml = require('sanitize-html');

// Tags Gutenberg EPUBs use: <span> small-caps, <hr> scene breaks, internal
// <a> anchors and <div class="blockquot"> blocks; <sup> for footnote numbers.
const OPTIONS = {
  allowedTags: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'em', 'i', 'b', 'strong', 'blockquote', 'br',
    'img', 'figure', 'figcaption', 'a', 'hr', 'span', 'small', 'div', 'sup', 'sub',
  ],
  allowedAttributes: {
    img: ['src', 'alt'],
    a: ['href'],
    '*': ['class', 'data-p', 'id'],
  },
  // http/https for external links; fragment/relative hrefs pass by default.
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // only the parser's "bf-..." ids (link targets): a book's own ids could
  // clash with the reader page's
  transformTags: {
    '*': (tagName, attribs) => {
      if (attribs.id === undefined || /^bf-[\w-]+$/.test(attribs.id)) return { tagName, attribs };
      const rest = { ...attribs };
      delete rest.id;
      return { tagName, attribs: rest };
    },
  },
};

function sanitizeChapterHtml(html) {
  return sanitizeHtml(html, OPTIONS);
}

module.exports = { sanitizeChapterHtml };
