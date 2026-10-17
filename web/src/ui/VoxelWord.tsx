// Voxel art: each pixel of a bitmap is a cube in cabinet projection (front face, plus top and right
// faces receding up-right). Faces hidden by a neighbouring cube are skipped, and cubes are painted
// bottom row first, right to left, so nearer front faces cover deeper ones. A cube's top is its colour
// lit, its side the colour shaded, so a bitmap only names front colours.
const GLYPHS: Record<string, string[]> = {
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
};
const S = 10; // cube edge, in viewBox units

// rows: one string per bitmap row, a character per pixel; "." is empty, any other character is a
// key into colors.
export function Voxels({
  rows,
  colors,
  depth = 6, // projected; under one cube, so receding faces never cross a further row
  label,
  className,
}: {
  rows: string[];
  colors: Record<string, string>;
  depth?: number;
  label?: string;
  className?: string;
}) {
  const D = depth;
  const on = (c: number, r: number) => (rows[r]?.[c] ?? ".") !== ".";
  const w = Math.max(...rows.map((r) => r.length));
  const mix = (c: string, to: string, pct: number) =>
    `color-mix(in srgb, ${c}, ${to} ${pct}%)`;
  const faces = [];
  for (let r = rows.length - 1; r >= 0; r--)
    for (let c = w - 1; c >= 0; c--) {
      if (!on(c, r)) continue;
      const col = colors[rows[r][c]];
      const x = c * S;
      const y = r * S;
      if (!on(c + 1, r))
        faces.push(
          <path
            key={`s${c},${r}`}
            style={{ fill: mix(col, "black", 45) }}
            d={`M${x + S} ${y}l${D} ${-D}v${S}l${-D} ${D}z`}
          />,
        );
      if (!on(c, r - 1))
        faces.push(
          <path
            key={`t${c},${r}`}
            style={{ fill: mix(col, "white", 28) }}
            d={`M${x} ${y}l${D} ${-D}h${S}l${-D} ${D}z`}
          />,
        );
      faces.push(
        <rect
          key={`f${c},${r}`}
          x={x}
          y={y}
          width={S}
          height={S}
          style={{ fill: col, stroke: mix(col, "black", 22) }}
          strokeWidth={0.5}
        />,
      );
    }
  return (
    <svg
      viewBox={`0 ${-D} ${w * S + D} ${rows.length * S + D}`}
      className={className}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
    >
      {faces}
    </svg>
  );
}

export function VoxelWord({
  word,
  className,
}: {
  word: string;
  className?: string;
}) {
  // One row string per bitmap row, letters joined by a blank column.
  const rows = [...Array(7)].map((_, r) =>
    [...word]
      .map((ch) => GLYPHS[ch][r])
      .join("0")
      .replaceAll("0", "."),
  );
  return (
    <Voxels
      rows={rows}
      colors={{ "1": "#3d3d3d" }}
      label={word}
      className={className}
    />
  );
}
