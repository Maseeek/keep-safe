import qrcode from "qrcode-generator";

/** One SVG path for the whole code: crisp at any size and cheap to render. */
export function qrPath(text: string): { path: string; size: number } {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      if (!code.isDark(row, column)) continue;
      let width = 1;
      while (column + width < count && code.isDark(row, column + width)) width++;
      path += `M${column} ${row}h${width}v1h-${width}z`;
      column += width - 1;
    }
  }
  return { path, size: count };
}
