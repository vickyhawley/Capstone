export { NotImplementedError } from './errors.js';
export { EMBEDDING_MODEL, EMBEDDING_DIM } from './embedding.js';

export type { Retriever, RetrievalQuery, RetrievedChunk } from './ports/retriever.js';
export { INTENTS } from './ports/router.js';
export type { Intent, Router, RouterQuery, RouterDecision } from './ports/router.js';
export type {
  Behaviour,
  EscalationTarget,
  RefusalReason,
  SafetyGate,
} from './ports/safety-gate.js';
export { ABSTAIN_COPY, ESCALATION_COPY, renderBehaviour } from './copy/behaviour-copy.js';
export type {
  LanguageModel,
  CompletionRequest,
  CompletionChunk,
  Message,
  Role,
} from './ports/language-model.js';
export type {
  ToolRegistry,
  ToolDefinition,
  ToolInvocation,
  ToolResult,
} from './ports/tool-registry.js';
export type { TraceSink, Span, SpanKind } from './ports/trace-sink.js';
export type {
  CatalogueRepository,
  Product,
  ProductVariant,
  StockLevel,
} from './ports/catalogue-repository.js';
export type { Reranker, RerankableCandidate, RerankedCandidate } from './ports/reranker.js';

export {
  beddingSchema,
  feedSchema,
  getAttributeSchema,
  haylageSchema,
  listAttributeSchemas,
  outerwearSchema,
  supplementsSchema,
} from './attribute-schemas/index.js';
export type {
  AttributeDefinition,
  AttributeSchema,
  AttributeType,
  ExtractedAttribute,
  SourceSpan,
} from './attribute-schemas/index.js';
