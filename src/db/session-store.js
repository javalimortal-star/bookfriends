const { Store } = require('express-session');
const { db } = require('./index');

const DAY_MS = 24 * 60 * 60 * 1000;

class SqliteStore extends Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire'
    );
    this.destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expire <= ?');
    // Hourly prune of expired sessions; unref so it never holds the process open.
    this.pruneTimer = setInterval(() => this.pruneStmt.run(Date.now()), 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  expireAt(sess) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : 30 * DAY_MS);
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expireAt(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = { SqliteStore };
