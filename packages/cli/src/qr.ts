import qrcode from 'qrcode-generator';

/** Half-block rendering: two QR rows per terminal line, light modules drawn solid
 * so the code scans on the usual dark terminal background. */
export function terminalQr(text: string): string {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
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
