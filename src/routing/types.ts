import type { Catalog, Model as ModelsDevModel, ModelCost, Modality } from '@opencode-ai/models/effect';

export type ModelRef = { readonly providerID: string; readonly modelID: string; readonly variant?: string };

export type Route = {
  readonly parent: { readonly model: string; readonly variant?: string | readonly string[] };
  readonly fast: { readonly model: string; readonly variant?: string };
};

export type TokenPrice = Pick<ModelCost, 'input' | 'output'>;

export type PriceBand = {
  readonly fromContext: number;
  readonly price: TokenPrice;
};

export type PriceSchedule = {
  readonly bands: readonly PriceBand[];
};

export type ProviderPriceSchedule = {
  readonly providerID: string;
  readonly schedule: PriceSchedule;
};

export type CostEstimate = {
  readonly schedule: PriceSchedule;
  readonly providerSamples: number;
};

export type ModelCapabilities = {
  readonly attachment: boolean;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly structuredOutput: boolean;
  readonly input: ReadonlySet<Modality>;
  readonly output: ReadonlySet<Modality>;
};

export type ModelLimits = {
  readonly context: number;
  readonly input?: number;
  readonly output: number;
};

export type EnabledModel = {
  readonly providerID: string;
  readonly modelID: string;
  readonly sourceID?: string;
  readonly name?: string;
  readonly family?: string;
  readonly releaseDate?: string;
  readonly status?: string;
  readonly cost?: PriceSchedule;
  readonly capabilities?: ModelCapabilities;
  readonly limits?: ModelLimits;
  readonly variants: ReadonlySet<string>;
};

export type CanonicalIdentity = {
  readonly id: string;
  readonly lab: string;
  readonly lineage: string;
  readonly generation: number;
};

export type ModelProfile = {
  readonly enabled: EnabledModel;
  readonly source?: ModelsDevModel;
  readonly canonical?: CanonicalIdentity;
  readonly marketCost?: CostEstimate;
};

export type ResolveContext = {
  readonly routes?: readonly Route[];
  readonly modelsDev?: Catalog;
};
