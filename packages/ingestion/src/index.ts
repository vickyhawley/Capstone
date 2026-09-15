export type {
  ChunkInput,
  ContentType,
  DocumentInput,
  DocumentWithChunks,
} from './types.js';

export { chunkProduct, type ShopifyRow } from './product-chunker.js';
export {
  chunkGuide,
  OVERLAP_CHARS,
  TARGET_CHARS,
  type GuideInput,
} from './guide-chunker.js';
export { renderVariantTable, type VariantRow } from './render-variant-table.js';
export {
  parseExtractionResponse,
  type DropReason,
  type DroppedAttribute,
  type ExtractionResult,
} from './attribute-extractor.js';
