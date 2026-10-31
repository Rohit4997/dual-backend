/**
 * Normalizes a user-typed phone number to E.164 ("+917425004997"), which
 * Firebase phone auth requires. Numbers without a leading "+" get
 * `defaultCountryCode`; leading trunk zeros are dropped.
 *
 *   toE164('7425004997', '+91')      → '+917425004997'
 *   toE164('07425004997', '+91')     → '+917425004997'
 *   toE164('917425004997', '+91')    → '+917425004997'
 *   toE164('+91 74250 04997', '+91') → '+917425004997'
 */
export function toE164(raw: string, defaultCountryCode: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return `+${digits}`;
  }
  const cc = defaultCountryCode.replace(/\D/g, '');
  const national = digits.replace(/^0+/, '');
  // Already includes the country code but without "+": only when the number
  // is longer than a typical national number (10 digits).
  if (national.length > 10 && national.startsWith(cc)) {
    return `+${national}`;
  }
  return `+${cc}${national}`;
}

export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}
