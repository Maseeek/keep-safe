import qrcode from 'qrcode-generator';

function make(text: string) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  return code;
}

/** Half-block rendering: two QR rows per terminal line, light modules drawn solid
 * so the code scans on the usual dark terminal background. */
export function terminalQr(text: string): string {
  const code = make(text);
  const size = code.getModuleCount();
  const quiet = 2;
  const light = (row: number, column: number) => row < 0 || column < 0 || row >= size || column >= size || !code.isDark(row, column);
  const lines: string[] = [];
  for (let row = -quiet; row < size + quiet; row += 2) {
    let line = '';
    for (let column = -quiet; column < size + quiet; column++) {
      const top = light(row, column); const bottom = light(row + 1, column);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** One SVG path per code, dark on white with a four-module quiet zone, whatever the theme. */
export function svgQr(text: string): string {
  const code = make(text);
  const count = code.getModuleCount();
  const quiet = 4;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (!code.isDark(row, column)) continue;
      let width = 1;
      while (column + width < count && code.isDark(row, column + width)) width++;
      path += `M${column + quiet} ${row + quiet}h${width}v1h-${width}z`;
      column += width - 1;
    }
  }
  const box = count + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${box}" height="${box}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

const escape = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

/** A self-contained page for clients that render HTML inline, such as T3 Code's html_render.
 * No page background and theme variables with fallbacks, so it sits on the host's own theme.
 * It carries the one-time pairing link and nothing else about the connection. */
export function qrHtml(link: string, expiresAt: string): string {
  const time = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair your phone</title>
<style>
  .pair { display: flex; flex-wrap: wrap; gap: 20px; align-items: center; font-family: var(--font-sans, system-ui, sans-serif); color: var(--foreground, inherit); }
  .code { flex: 0 0 auto; width: 240px; max-width: 100%; background: #fff; padding: 16px; border-radius: var(--radius, 12px); box-sizing: border-box; }
  .code svg { display: block; width: 100%; height: auto; }
  .text { flex: 1 1 220px; min-width: 0; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { margin: 0 0 10px; line-height: 1.45; color: var(--muted-foreground, inherit); }
  code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; word-break: break-all; color: var(--foreground, inherit); }
</style>
</head>
<body>
<div class="pair">
  <div class="code">${svgQr(link)}</div>
  <div class="text">
    <h1>Pair your phone</h1>
    <p>Scan this with your phone camera. One scan, valid once, until ${escape(time)}.</p>
    <p>Cannot scan? Open this link on the phone:<br><code>${escape(link)}</code></p>
  </div>
</div>
</body>
</html>
`;
}
