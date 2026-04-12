/** Bump when breaking JSON response or valuation request semantics (document in CHANGELOG / OpenAPI). */
export const ENGINE_CONTRACT_VERSION = "1" as const;

export type EngineContractVersion = typeof ENGINE_CONTRACT_VERSION;
