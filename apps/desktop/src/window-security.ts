export function isEditorUrl(url: string, editorUrl: string): boolean {
  try {
    const target = new URL(url);
    const editor = new URL(editorUrl);
    return target.protocol === editor.protocol && target.host === editor.host && target.pathname === editor.pathname;
  } catch {
    return false;
  }
}

export function isExternalWebUrl(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function allowsMediaRequest(types?: readonly string[]): boolean {
  return !!types?.length && types.every((type) => type === "audio");
}

export function allowsMediaCheck(type?: string): boolean {
  return type === undefined || type === "audio";
}
