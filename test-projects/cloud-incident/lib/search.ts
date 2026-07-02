// Admin catalog search ranking. (Shipped last week; simple but correct — score by term hits with a
// name-match bonus, stable order for ties.)
const CATALOG = [
  { sku: "WIDGET-9", name: "widget nine", tags: ["widget", "bestseller"] },
  { sku: "GADGET-3", name: "gadget three", tags: ["gadget"] },
  { sku: "DOODAD-7", name: "doodad seven", tags: ["doodad", "clearance"] },
  { sku: "SPROCKET-2", name: "sprocket two", tags: ["sprocket", "bestseller"] },
];

export function rankResults(query: string): { sku: string; score: number }[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return CATALOG.map((item) => {
    let score = 0;
    for (const t of terms) {
      if (item.name.includes(t)) score += 3;
      if (item.tags.some((tag) => tag.includes(t))) score += 1;
      if (item.sku.toLowerCase().includes(t)) score += 2;
    }
    return { sku: item.sku, score };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
}
