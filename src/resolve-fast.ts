import { isNotNil, last, minBy } from 'es-toolkit';

const EFFORT = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORT)[number];

export type ModelRef = { readonly providerID: string; readonly modelID: string; readonly variant?: string };

export type Route = {
  readonly parent: { readonly model: string; readonly variant?: string | readonly string[] };
  readonly fast: { readonly model: string; readonly variant?: string };
};

export type CatalogModel = {
  readonly providerID: string;
  readonly id: string;
  readonly family?: string;
  readonly tool_call?: boolean;
  readonly status?: string;
  readonly cost?: { readonly input?: number };
  readonly variants?: Readonly<Record<string, unknown>>;
};

function parseModel(id: string): ModelRef | undefined {
  const separator = id.indexOf('/');
  if (separator <= 0 || separator === id.length - 1) return undefined;

  return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) };
}

function variantMatches(routeVariant: string | readonly string[] | undefined, parentVariant?: string): boolean {
  if (routeVariant === undefined) return true;

  const actual = parentVariant ?? 'default';
  return typeof routeVariant === 'string' ? routeVariant === actual : routeVariant.includes(actual);
}

/** Last matching route wins. Omit `parent.variant` to match every variant of that model. */
export function matchRoute(parent: ModelRef, routes: readonly Route[]): ModelRef | undefined {
  const parentId = `${parent.providerID}/${parent.modelID}`;
  const matches = routes
    .map((route): ModelRef | undefined => {
      if (route.parent.model !== parentId || !variantMatches(route.parent.variant, parent.variant)) return undefined;

      const fast = parseModel(route.fast.model);
      if (!fast) return undefined;
      return route.fast.variant === undefined ? fast : { ...fast, variant: route.fast.variant };
    })
    .filter(isNotNil);

  return last(matches);
}

function effortRank(value?: string): number {
  const rank = EFFORT.indexOf((value ?? 'medium') as Effort);
  return rank === -1 ? EFFORT.indexOf('medium') : rank;
}

function costOf(model: CatalogModel): number {
  return model.cost?.input ?? Number.POSITIVE_INFINITY;
}

export function resolveFast(
  parent: ModelRef,
  catalog: readonly CatalogModel[],
  routes: readonly Route[] = [],
): ModelRef | undefined {
  const override = matchRoute(parent, routes);
  if (override) {
    const sameModel = override.providerID === parent.providerID && override.modelID === parent.modelID;
    if (!sameModel || effortRank(override.variant) < effortRank(parent.variant)) return override;
  }

  const self = catalog.find((model) => model.providerID === parent.providerID && model.id === parent.modelID);
  const variantKeys = Object.keys(self?.variants ?? {});
  if (effortRank(parent.variant) >= effortRank('high') && variantKeys.includes('low')) {
    return { ...parent, variant: 'low' };
  }

  if (!self?.family) return undefined;
  const cheap = minBy(
    catalog.filter(
      (model) =>
        model.providerID === parent.providerID &&
        model.family === self.family &&
        model.tool_call !== false &&
        model.status !== 'deprecated' &&
        costOf(model) < costOf(self),
    ),
    costOf,
  );
  if (!cheap) return undefined;

  return {
    providerID: cheap.providerID,
    modelID: cheap.id,
    ...(Object.keys(cheap.variants ?? {}).includes('low') ? { variant: 'low' } : {}),
  };
}
