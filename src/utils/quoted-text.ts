/** Step text with quoted values ("x", “x”, «x», `x`, 'x') blanked out. Apostrophes inside words are kept. */
export function withoutQuotedText(text: string): string {
  return text
    .replace(/"[^"]*"|“[^”]*”|«[^»]*»|`[^`]*`/g, '""')
    .replace(/(^|[^\p{L}\p{N}])'[^']*'(?=[^\p{L}\p{N}]|$)/gu, '$1\'\'');
}
