/** Prisma returns JSON columns as a broad JsonValue union; settings use string lists. */
export function getStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length ? strings : fallback;
}
