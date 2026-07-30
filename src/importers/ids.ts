import { randomUUID, randomBytes } from 'crypto';

export function claudeSessionId(): string {
  return randomUUID();
}

export function codexSessionId(): string {
  return '019' + Date.now().toString(36).padStart(10, '0') + '-' + randomBytes(6).toString('hex').slice(0, 4) + '-' + randomBytes(4).toString('hex').slice(0, 4) + '-' + randomBytes(4).toString('hex').slice(0, 4) + '-' + randomBytes(12).toString('hex').slice(0, 12);
}

function randomAlphanum(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

/*
 * OpenCode identifiers are not random: they are a 48-bit `timestamp * 4096 + counter`
 * rendered as 12 hex chars, followed by 14 random base62 chars. That makes them sort
 * lexicographically in creation order, and OpenCode relies on it — its session loop
 * exits immediately when `lastUserMessage.id < lastAssistantMessage.id`, and messages
 * and parts are read back ordered by id. Random ids break both, which leaves an
 * imported session unable to send messages or compact. Descending ids (sessions)
 * store the bitwise complement so newest sorts first.
 *
 * Port of opencode's Identifier.ascending / Identifier.descending.
 */
const OPENCODE_ID_LENGTH = 26;
const OPENCODE_BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let lastIdTimestamp = 0;
let idCounter = 0;

function opencodeBase62(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += OPENCODE_BASE62[bytes[i] % 62];
  }
  return result;
}

function opencodeId(prefix: string, direction: 'ascending' | 'descending', timestamp?: number): string {
  const ts = timestamp ?? Date.now();
  if (ts !== lastIdTimestamp) {
    lastIdTimestamp = ts;
    idCounter = 0;
  }
  idCounter++;

  let bits = BigInt(Math.floor(ts)) * 4096n + BigInt(idCounter);
  if (direction === 'descending') bits = ~bits;

  const buf = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    buf[i] = Number((bits >> BigInt(40 - 8 * i)) & 0xffn);
  }

  return prefix + '_' + buf.toString('hex') + opencodeBase62(OPENCODE_ID_LENGTH - 12);
}

/**
 * Timestamp encoded in an ascending OpenCode id. Only the low 48 bits of
 * `timestamp * 4096 + counter` are stored, so this returns `timestamp % 2**36` —
 * the same lossy value OpenCode's own Identifier.timestamp() reports.
 */
export function opencodeIdTimestamp(id: string): number {
  const prefix = id.split('_')[0];
  const hex = id.slice(prefix.length + 1, prefix.length + 13);
  return Number(BigInt('0x' + hex) / 4096n);
}

export function opencodeSessionId(timestamp?: number): string {
  return opencodeId('ses', 'descending', timestamp);
}

export function opencodeMessageId(timestamp?: number): string {
  return opencodeId('msg', 'ascending', timestamp);
}

export function opencodePartId(timestamp?: number): string {
  return opencodeId('prt', 'ascending', timestamp);
}

export function claudeUuid(): string {
  return randomUUID();
}

export function codexTurnId(): string {
  return randomUUID();
}

export function codexCallId(): string {
  return 'call_' + randomBytes(16).toString('hex').slice(0, 24);
}

export function codexToolCallId(): string {
  return 'ctc_' + randomBytes(16).toString('hex').slice(0, 24);
}

export function opencodeEventId(timestamp?: number): string {
  return opencodeId('evt', 'ascending', timestamp);
}

const adjectives = [
  'brave', 'calm', 'eager', 'fancy', 'gentle', 'happy', 'jolly', 'keen',
  'lively', 'mighty', 'noble', 'proud', 'quick', 'sharp', 'witty', 'bright',
  'cool', 'swift', 'warm', 'bold', 'busy', 'chill', 'clean', 'clear', 'crisp',
  'dandy', 'dryad', 'elven', 'fleet', 'fresh', 'grand', 'great', 'light',
  'lucky', 'merry', 'neat', 'new', 'nice', 'odd', 'old', 'prime', 'rare',
  'safe', 'slim', 'small', 'smart', 'solid', 'still', 'sunny', 'super',
];

const nouns = [
  'otter', 'wolf', 'moon', 'tiger', 'eagle', 'fox', 'bear', 'deer', 'hawk',
  'owl', 'puma', 'hare', 'orca', 'koala', 'lynx', 'raven', 'rook', 'dove',
  'swan', 'heron', 'falcon', 'finch', 'gecko', 'ibex', 'jaguar', 'kite',
  'lark', 'newt', 'osprey', 'panda', 'quail', 'robin', 'sable', 'tuna',
  'viper', 'wren', 'yak', 'zebra', 'crane', 'drake', 'elver', 'frill',
  'guppy', 'hyena', 'imp', 'jackal', 'kiwi', 'lemur', 'moth', 'newt',
];

export function opencodeSlug(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}`;
}

export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
