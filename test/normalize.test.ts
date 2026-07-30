import { describe, it, expect } from 'vitest';
import { stripXml, cleanTitle, isSystemCommand } from '../src/ir/normalize.js';

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
