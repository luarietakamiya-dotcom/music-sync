import { readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
writeFileSync('tests/fixtures/tone.flac', Buffer.from(readFileSync('tests/fixtures/tone.flac.base64', 'utf8').trim(), 'base64'));
