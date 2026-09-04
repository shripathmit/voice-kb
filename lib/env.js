'use strict';

/**
 * Loads .env when one exists, without depending on a Node version.
 *
 * `node --env-file-if-exists` needs Node 22.9+. On anything older the process
 * exits immediately with "bad option" and prints nothing — which is invisible
 * in a deploy log, because the app never reaches its own logging. Doing it in
 * code costs a few lines and works everywhere.
 *
 * Real environment variables always win: on a host the platform sets them, and
 * a stray .env in the image must never override that.
 */

const fs = require('node:fs');
const path = require('node:path');

function parse(contents) {
  const values = {};

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    values[key] = value;
  }

  return values;
}

function load(file = path.join(__dirname, '..', '.env')) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // No .env is the normal case on a deployed host.
  }

  for (const [key, value] of Object.entries(parse(contents))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

module.exports = { load, parse };
