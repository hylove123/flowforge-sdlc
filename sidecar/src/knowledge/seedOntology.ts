// ================================================================
//  Seed Ontology — hard write-time constraints for the knowledge layer
//
//  The fallback (non-Cognee) route enforces the SDLC ontology
//  (domain/ontology.ts: 7 concepts + 14 relations) as a schema
//  contract on every graphStore write:
//    - entity.type must be a known concept
//    - edge.relation must be a known relation
//    - traceability edges must respect the relation's source/target
//      concept signature
//
//  It also resolves the correct traceability relation for a pair of
//  concepts, so auto-linking (e.g. TestCase → Deliverable) always
//  produces ontology-valid edges instead of a blanket DERIVED_FROM.
// ================================================================

import { CONCEPTS, RELATIONS, DEFAULT_TRACEABILITY_CHAIN, type ChainItem } from '../domain/ontology.js'

export interface OntologyViolation {
  code: 'unknown_concept' | 'unknown_relation' | 'endpoint_mismatch'
  message: string
}

export class OntologyError extends Error {
  violation: OntologyViolation
  constructor(violation: OntologyViolation) {
    super(violation.message)
    this.name = 'OntologyError'
    this.violation = violation
  }
}

// ─── Concept / relation validation ──────────────────────────────

export function isValidConcept(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONCEPTS, type)
}

export function isValidRelation(relation: string): boolean {
  return Object.prototype.hasOwnProperty.call(RELATIONS, relation)
}

/** Throws OntologyError when the entity type is not a seed concept. */
export function assertConcept(type: string): void {
  if (!isValidConcept(type)) {
    throw new OntologyError({
      code: 'unknown_concept',
      message: `未知概念类型 "${type}"（本体仅允许：${Object.keys(CONCEPTS).join(', ')}）`,
    })
  }
}

/**
 * Throws OntologyError when the relation is unknown or, for
 * traceability relations, when the endpoint concepts don't match the
 * relation's declared source/target signature.
 */
export function assertEdge(relation: string, sourceType: string, targetType: string): void {
  const def = RELATIONS[relation]
  if (!def) {
    throw new OntologyError({
      code: 'unknown_relation',
      message: `未知关系类型 "${relation}"（本体仅允许：${Object.keys(RELATIONS).join(', ')}）`,
    })
  }
  // traceability relations are the hard chain — enforce endpoint types
  if (def.traceability && (def.source !== sourceType || def.target !== targetType)) {
    throw new OntologyError({
      code: 'endpoint_mismatch',
      message: `关系 ${relation} 要求 ${def.source} → ${def.target}，实际 ${sourceType} → ${targetType}`,
    })
  }
}

// ─── Traceability relation resolution ───────────────────────────
// Given two endpoint concepts, pick the ontology-correct downstream →
// upstream traceability relation (used by auto-linking on register).

const TRACE_BY_PAIR: Record<string, string> = {}
for (const def of Object.values(RELATIONS)) {
  // first declaration wins: DERIVED_FROM (not its inverse DERIVES) is the
  // canonical Deliverable → Deliverable traceability edge
  const key = `${def.source}→${def.target}`
  if (def.traceability && !(key in TRACE_BY_PAIR)) TRACE_BY_PAIR[key] = def.id
}

export function resolveTraceRelation(sourceType: string, targetType: string): string | null {
  return TRACE_BY_PAIR[`${sourceType}→${targetType}`] ?? null
}

export function inverseOf(relation: string): string | null {
  return RELATIONS[relation]?.inverse ?? null
}

// ─── Stage → concept mapping (default chain) ────────────────────

export function conceptForStage(stageId: string, flowConfig: ChainItem[] | null = null): string {
  const chain = flowConfig && flowConfig.length > 0 ? flowConfig : DEFAULT_TRACEABILITY_CHAIN
  return chain.find((c) => c.stage === stageId)?.concept ?? 'Deliverable'
}

export function upstreamStagesOf(stageId: string, flowConfig: ChainItem[] | null = null): ChainItem[] {
  const chain = flowConfig && flowConfig.length > 0 ? flowConfig : DEFAULT_TRACEABILITY_CHAIN
  const idx = chain.findIndex((c) => c.stage === stageId)
  return idx > 0 ? chain.slice(0, idx) : []
}
