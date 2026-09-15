/**
 * Render a product's variants as a compact text table that goes into
 * the composed product chunk body. Kept as a plain function so it's
 * testable in isolation from the CSV-parsing side of the chunker.
 *
 * Format is a pipe-delimited table because it's readable both by a
 * human and by embedding models. Markdown table syntax would work
 * too; pipe-delimited plain-text is one dependency lighter and
 * tokenises the same way.
 */

export interface VariantRow {
  readonly optionName: string;
  readonly optionValue: string;
  readonly sku: string;
  readonly price: number | null;
}

export function renderVariantTable(rows: readonly VariantRow[]): string {
  const [firstRow] = rows;
  if (!firstRow) {
    return '';
  }
  const header = `${firstRow.optionName} | SKU | Price`;
  const separator = '- | - | -';
  const body = rows.map((row) => {
    const priceCell = row.price === null ? '—' : `£${row.price.toFixed(2)}`;
    const optionCell = row.optionValue.trim() === '' ? '(default)' : row.optionValue;
    return `${optionCell} | ${row.sku} | ${priceCell}`;
  });
  return [header, separator, ...body].join('\n');
}
