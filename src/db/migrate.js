const fs = require('fs');
const path = require('path');
const { db } = require('./index');

function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

module.exports = { migrate };
