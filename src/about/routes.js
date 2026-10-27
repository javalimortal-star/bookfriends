const express = require('express');
const { avatarTone, initialOf } = require('../users');
const samples = require('./samples');

const router = express.Router();
const HOUR = 60 * 60 * 1000;

// The project's own page: what BookFriends is, a paragraph with its comments
// to try, the phone screens and how it was built. Open to everyone.
router.get('/about', (req, res) => {
  const sample = samples[req.lang];
  const comments = sample.comments.map((c) => ({
    ...c, initial: initialOf(c.name), tone: avatarTone(c.name), at: Date.now() - c.hours * HOUR,
  }));
  res.render('about', {
    title: req.t('About BookFriends'),
    og: { title: req.t('BookFriends: your friends, in the margins') },
    sample,
    // replies sit under the comment before them, as in the reader
    thread: comments.reduce((list, c) => {
      if (c.reply && list.length) list[list.length - 1].replies.push(c);
      else list.push({ ...c, replies: [] });
      return list;
    }, []),
    commentCount: comments.length,
  });
});

module.exports = router;
