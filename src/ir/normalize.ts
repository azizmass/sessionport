export function stripXml(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function isSystemCommand(text: string): boolean {
  return /^<\w+/.test(text.trim()) || /^\s*\/(clear|reset|help|model|init|web|mcp)/.test(text.trim());
}

export function cleanTitle(raw: string, maxLen = 80): string {
  const cleaned = stripXml(raw);
  if (!cleaned || isSystemCommand(cleaned)) return 'Untitled Session';
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}
