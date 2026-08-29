import { describe, it, expect } from 'vitest';
import {
  stripXml,
  cleanTitle,
  isSystemCommand,
  isPlaceholderTitle,
  extractText,
  formatSessionTime,
  displayTitle,
} from '../src/ir/normalize.js';

describe('stripXml', () => {
  it('removes XML tags', () => {
    expect(stripXml('<command-name>/clear</command-name>\n<command-message>clear</command-message>')).toBe('/clear clear');
  });

  it('returns empty for only tags', () => {
    expect(stripXml('<foo></foo>')).toBe('');
  });

  it('keeps non-XML text', () => {
    expect(stripXml('hello world')).toBe('hello world');
  });
});

describe('isSystemCommand', () => {
  it('detects XML commands', () => {
    expect(isSystemCommand('<command-name>/clear</command-name>')).toBe(true);
  });

  it('detects slash commands', () => {
    expect(isSystemCommand('/clear')).toBe(true);
    expect(isSystemCommand('/model claude-opus-5')).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(isSystemCommand('How does auth work?')).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('cleans XML from title', () => {
    expect(cleanTitle('<command-name>/clear</command-name>')).toBe('Untitled Session');
  });

  it('returns clean text unchanged', () => {
    expect(cleanTitle('How does auth work?')).toBe('How does auth work?');
  });

  it('truncates long text', () => {
    const long = 'a'.repeat(100);
    expect(cleanTitle(long)).toHaveLength(81);
    expect(cleanTitle(long)).toMatch(/…$/);
  });

  it('returns Untitled for empty text', () => {
    expect(cleanTitle('')).toBe('Untitled Session');
  });
});

describe('isPlaceholderTitle', () => {
  it('detects empty and auto-generated titles', () => {
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('   ')).toBe(true);
    expect(isPlaceholderTitle('Untitled Session')).toBe(true);
    expect(isPlaceholderTitle('Untitled Codex Session')).toBe(true);
    expect(isPlaceholderTitle('New session - 2026-08-26T11:31:32.260Z')).toBe(true);
    expect(isPlaceholderTitle('/clear')).toBe(true);
  });

  it('keeps real titles', () => {
    expect(isPlaceholderTitle('Fix the session list')).toBe(false);
  });
});

describe('extractText', () => {
  it('reads plain string content', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('reads text blocks and ignores tool blocks', () => {
    expect(
      extractText([
        { type: 'text', text: 'fix the list' },
        { type: 'tool_result', tool_use_id: 't1', content: 'noise' },
      ]),
    ).toBe('fix the list');
  });

  it('returns empty for unusable content', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText([{ type: 'tool_use', name: 'Bash', input: {} }])).toBe('');
  });
});

describe('formatSessionTime', () => {
  it('formats date down to the minute', () => {
    const ts = new Date(2026, 7, 29, 14, 5).getTime();
    expect(formatSessionTime(ts)).toBe('2026-08-29 14:05');
  });

  it('handles missing timestamps', () => {
    expect(formatSessionTime(undefined)).toBe('unknown time');
    expect(formatSessionTime(NaN)).toBe('unknown time');
  });
});

describe('displayTitle', () => {
  const updatedAt = new Date(2026, 7, 29, 14, 5).getTime();

  it('uses a real title when there is one', () => {
    expect(displayTitle({ title: 'Port sessions', lastMessage: 'x', updatedAt })).toBe(
      'Port sessions',
    );
  });

  it('falls back to the last message when the title is a placeholder', () => {
    expect(
      displayTitle({ title: 'Untitled Session', lastMessage: 'why is the list empty?', updatedAt }),
    ).toBe('why is the list empty?');
  });

  it('falls back to the last update date and minute when nothing else is usable', () => {
    expect(displayTitle({ title: '', lastMessage: '/clear', updatedAt })).toBe(
      'Untitled · 2026-08-29 14:05',
    );
  });

  it('falls back to createdAt when updatedAt is missing', () => {
    expect(displayTitle({ title: '', createdAt: updatedAt })).toBe('Untitled · 2026-08-29 14:05');
  });

  it('truncates long fallbacks', () => {
    const label = displayTitle({ title: 'a'.repeat(100), updatedAt }, 20);
    expect(label).toHaveLength(21);
    expect(label).toMatch(/…$/);
  });
});
