// Trigger a client-side file download from an in-memory string. Shared by every
// export path (note HTML / Markdown, graph SVG, JSON backup) so the blob + object-URL
// dance lives in one place.
export function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
