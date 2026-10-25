// Small user helpers shared by the routes, services and templates (no DB).

// The name a user goes by in comments, mentions and menus.
function displayName(row) {
  return row.display_name || String(row.email).split('@')[0];
}

// First letter for the avatar circles (a whole emoji, not half of one).
function initialOf(name) {
  return (Array.from(name)[0] || '?').toUpperCase();
}

// Same hash as the comment avatars, so a friend keeps one colour everywhere
// (.avatar-0 … .avatar-4 in app.css).
function avatarTone(name) {
  let tone = 0;
  for (let i = 0; i < name.length; i++) tone = (tone * 31 + name.charCodeAt(i)) % 5;
  return tone;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Optional nickname shown on comments; empty means "fall back to email prefix".
function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30) || null;
}

function roleFor(email) {
  return email === normalizeEmail(process.env.OWNER_EMAIL) ? 'owner' : 'reader';
}

module.exports = { displayName, initialOf, avatarTone, normalizeEmail, normalizeDisplayName, roleFor };
