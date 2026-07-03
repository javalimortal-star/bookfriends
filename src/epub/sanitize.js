const sanitizeHtml = require('sanitize-html');

// Widened allowlist per approved plan: the fixture uses <span> small-caps,
// <hr> scene breaks, internal <a> anchors and <div class="blockquot"> blocks.
const OPTIONS = {
  allowedTags: [
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'em', 'i', 'b', 'strong', 'blockquote', 'br',
    'img', 'figure', 'figcaption', 'a', 'hr', 'span', 'small', 'div',
  ],
  allowedAttributes: {
    img: ['src', 'alt'],
    a: ['href'],
    '*': ['class', 'data-p'],
  },
  // http/https for external links; fragment/relative hrefs pass by default.
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

function sanitizeChapterHtml(html) {
  return sanitizeHtml(html, OPTIONS);
}

module.exports = { sanitizeChapterHtml };
