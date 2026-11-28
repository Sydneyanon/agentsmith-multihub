/** Squarified treemap layout (Bruls, Huizing, van Wijk). Pure function: area is proportional to weight. */
export interface TreemapItem<T> { weight: number; data: T }
export interface TreemapRect<T> { x: number; y: number; w: number; h: number; data: T }

export function squarify<T>(items: Array<TreemapItem<T>>, width: number, height: number): Array<TreemapRect<T>> {
  const positive = items.filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = positive.reduce((acc, item) => acc + item.weight, 0);
  if (!positive.length || total <= 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const nodes = positive.map((item) => ({ area: item.weight * scale, data: item.data }));
  const out: Array<TreemapRect<T>> = [];
  let x = 0, y = 0, w = width, h = height;

  const worst = (row: number[], side: number): number => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  let i = 0;
  while (i < nodes.length) {
    const side = Math.min(w, h);
    const row: number[] = [];
    let j = i;
    while (j < nodes.length) {
      const candidate = [...row, nodes[j]!.area];
      if (row.length && worst(candidate, side) > worst(row, side)) break;
      row.push(nodes[j]!.area);
      j += 1;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const rowWidth = rowSum / h; let cy = y;
      for (let k = 0; k < row.length; k += 1) { const rh = row[k]! / rowWidth; out.push({ x, y: cy, w: rowWidth, h: rh, data: nodes[i + k]!.data }); cy += rh; }
      x += rowWidth; w -= rowWidth;
    } else {
      const rowHeight = rowSum / w; let cx = x;
      for (let k = 0; k < row.length; k += 1) { const rw = row[k]! / rowHeight; out.push({ x: cx, y, w: rw, h: rowHeight, data: nodes[i + k]!.data }); cx += rw; }
      y += rowHeight; h -= rowHeight;
    }
    i = j;
  }
  return out;
}
