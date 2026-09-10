export type ClassValue = string | false | null | undefined;

/** Join conditional class names. Falsy values are dropped. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
