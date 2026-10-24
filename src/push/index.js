// Web Push to a user's subscribed devices (phones, installed app).
// Placeholder until push is wired up: callers can use it already.

// A new row in `notifications` (reply, mention, ...): tell the recipient's devices.
function notificationCreated(notificationId) { // eslint-disable-line no-unused-vars
}

// Anything else worth a phone notification. payload: { title, body, url }
function sendToUser(userId, payload) { // eslint-disable-line no-unused-vars
}

module.exports = { notificationCreated, sendToUser };
