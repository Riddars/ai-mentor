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

const csv = await call("table_info", { path: "station_readings.csv" });
check("CSV rows", csv.includes("строк данных: 360"), csv);
const csvHead = await call("read_file", { path: "station_readings.csv", from: 37 });
check("CSV head only", !csvHead.includes("S0037"), csvHead);
const tsv = await call("table_info", { path: "specimen_catalog.tsv" });
check("TSV rows", tsv.includes("строк данных: 120"), tsv);
const jsonl = await call("table_info", { path: "activity_log.jsonl" });
check("JSONL rows", jsonl.includes("строк данных: 180"), jsonl);
const jsonlHead = await call("read_file", { path: "activity_log.jsonl", from: 170 });
check("JSONL head only", !jsonlHead.includes("E0180"), jsonlHead);
const json = await call("json_info", { path: "response_bundle.json" });
check("JSON structure", json.includes("JSON:") && json.includes("responses"), json);
const fictional = await call("json_get", { path: "response_bundle.json", key: "/fictional" });
check("JSON exact value", fictional.includes("true"), fictional);
const xml = await call("xml_info", { path: "archive_index.xml" });
check("XML records", xml.includes("72 элементов"), xml);
const xmlRecord = await call("xml_get", { path: "archive_index.xml", element: "archive/record", index: 0 });
check("XML exact record", xmlRecord.includes('id="A001"') && xmlRecord.includes("<title>"), xmlRecord);
const html = await call("html_info", { path: "card_exhibit.html" });
check("HTML title and table", html.includes("Lantern Survey | Card Exhibit") && html.includes("строк таблиц: 49"), html);
const htmlCards = await call("html_section", { path: "card_exhibit.html", heading: "Selected cards" });
check("HTML exact section", htmlCards.includes("C001") && htmlCards.includes(" | "), htmlCards);
const text = await call("read_file", { path: "field_notebook.txt", from: 1, to: 5 });
check("TXT lines", text.includes("0-9 dial"), text);
const entry = await call("grep", { path: "field_notebook.txt", text: "F001" });
check("TXT entry search", entry.includes("F001"), entry);
for (const path of ["calibration_journal.md", "data_dictionary.yaml", "reading_list.bib", "seed_archive.sql"]) {
  const result = await call("read_file", { path, from: 1, to: 10 });
  check(`${path} accessible`, result.includes(path) && result.length > path.length + 10, result);
}
