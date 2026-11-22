import { fileKind } from "./file-policy";

const OMIT_DIR = /(?:^|\/)(?:\.git|node_modules|\.next|\.venv|venv|__pycache__|dist|build|coverage)(?:\/|$)/;
const BINARY = /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|pyc|woff2?|ttf|mp[34]|wav|bin|pt|pth|onnx)$/i;
const SECRET = /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;
export function sensitivePath(path: string): boolean { return SECRET.test(path); }
export function snapshotExclusion(path: string): string | null {
  if (OMIT_DIR.test(path)) return "служебный каталог";
  if (SECRET.test(path)) return "файл учётных данных";
  if (/\.pdbqt$/i.test(path)) return "данные молекулярных структур";
  if (BINARY.test(path)) return "двоичный или графический файл";
  const kind = fileKind(path);
  return kind === "text" ? null : `категория ${kind}`;
}
