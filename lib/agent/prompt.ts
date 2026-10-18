/** The repository part of the agent's first message. */
export function repositorySection(map: string, related: string[]): string {
  const relatedText =
    related.length > 0 ? related.map((p) => `- ${p}`).join("\n") : "(не найдено — ищи сам по карте и grep)";
  return (
    "=== КАРТА РЕПОЗИТОРИЯ (копия на разбираемом коммите) ===\n" +
    `${map}\n\n` +
    "Связанные файлы (импортируются изменёнными файлами) — прочитай их:\n" +
    `${relatedText}\n` +
    "=== КОНЕЦ КАРТЫ ==="
  );
}
