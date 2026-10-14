/** Only non-empty strings are titles; malformed metadata must not hide a fallback. */
export function sessionTitle(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
