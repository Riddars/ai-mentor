/** A notebook as its code and markdown cells, without outputs and images; null if it is not valid JSON. */
export function notebookCells(raw: string): string | null {
  try {
    const nb = JSON.parse(raw) as { cells?: Array<{ cell_type: string; source: string | string[] }> };
    const cells = (nb.cells ?? [])
      .filter((c) => c.cell_type === "code" || c.cell_type === "markdown")
      .map((c) => {
        const source = Array.isArray(c.source) ? c.source.join("") : c.source;
        return `# [${c.cell_type}]\n${source.trim()}`;
      });
    return cells.join("\n\n");
  } catch {
    return null;
  }
}
