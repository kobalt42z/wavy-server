import { extname } from "node:path";

/** Lower-case extension without the dot ("Clip.MOV" -> "mov"). */
export function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}
