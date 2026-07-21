'use strict';
const crypto = require('crypto');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randToken(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = {
  sha256,
  randToken,
  newId: (prefix) => `${prefix}_${randToken(12)}`,
  // Only the sha256 hash of a key or token is ever stored.
  newIngestKey: (tag) => `tb_live_${tag ? tag + '_' : ''}${randToken(8)}`,
  newSessionToken: () => `ses_${randToken(32)}`,
};
