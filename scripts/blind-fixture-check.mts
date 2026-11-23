import { resolve } from "node:path";
import { createToolLog, createTools } from "@/lib/agent/tools.mjs";

const root = resolve("blind-fixtures");
const tools = Object.fromEntries(createTools(root, createToolLog()).map((tool) => [tool.name, tool]));
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await tools[name].execute("blind-check", args as never);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
};
const check = (label: string, condition: boolean, detail: string) => {
  if (!condition) throw new Error(`${label}: ${detail.slice(0, 500)}`);
  console.log(`ok ${label}`);
};

const listing = await call("list_files", {});
for (const path of ["station_readings.csv", "specimen_catalog.tsv", "activity_log.jsonl", "response_bundle.json",
  "archive_index.xml", "card_exhibit.html", "field_notebook.txt", "reading_list.bib"]) {
  check(`${path} listed`, listing.includes(path), listing);
  const result = await call("read_file", { path }).catch((error: Error) => error.message);
  check(`${path} content excluded`, result.includes("excluded by policy"), result);
}
for (const path of ["calibration_journal.md", "data_dictionary.yaml", "seed_archive.sql"]) {
  const result = await call("read_file", { path, from: 1, to: 10 });
  check(`${path} accessible`, result.includes(path) && result.length > path.length + 10, result);
}
