export { StubRetriever } from './retriever/stub-retriever.js';
export { PgTsRankRetriever } from './retriever/pg-ts-rank-retriever.js';
export { PgvectorDenseRetriever } from './retriever/pgvector-dense-retriever.js';
export {
  HybridRetriever,
  type HybridRetrieverOptions,
} from './retriever/hybrid-retriever.js';
export { rrf, weightedFusion, type FusionInput, type FusionStrategy } from './retriever/fusion.js';

export { StubLanguageModel } from './language-model/stub-language-model.js';
export { StubToolRegistry } from './tool-registry/stub-tool-registry.js';
export { StubTraceSink } from './trace-sink/stub-trace-sink.js';
export { StubCatalogueRepository } from './catalogue-repository/stub-catalogue-repository.js';
export { NoopReranker } from './reranker/noop-reranker.js';

export { HybridRouter } from './router/hybrid-router.js';
export { StubRouter } from './router/stub-router.js';
export { RULES, matchRule, type Rule } from './router/rules.js';
export { CLASSIFIER_MODEL, classifyWithLLM } from './router/llm-classifier.js';
