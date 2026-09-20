const EFFORT = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORT)[number];

export type ModelRef = { providerID: string; modelID: string; variant?: string };

export type Route = {
  parent: { model: string; variant?: string | string[] };
  fast: { model: string; variant?: string };
};

export type CatalogModel = {
  providerID: string;
  id: string;
  family?: string;
  tool_call?: boolean;
  status?: string;
  cost?: { input?: number };
  variants?: Record<string, unknown>;
};

function parseModel(id: string): { providerID: string; modelID: string } | undefined {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) return;

  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) };
}

function variantMatches(routeVariant: string | string[] | undefined, parentVariant?: string): boolean {
  if (routeVariant === undefined) return true;

  const actual = parentVariant ?? 'default';
  if (typeof routeVariant === 'string') return routeVariant === actual;
  return routeVariant.includes(actual);
}

/** Last matching route wins. Omit `parent.variant` to match every variant of that model. */
export function matchRoute(parent: ModelRef, routes: Route[]): ModelRef | undefined {
  const parentId = `${parent.providerID}/${parent.modelID}`;
  let hit: ModelRef | undefined;
  for (const route of routes) {
    if (route.parent.model !== parentId) continue;

    if (!variantMatches(route.parent.variant, parent.variant)) continue;

    const fast = parseModel(route.fast.model);
    if (!fast) continue;

    hit = { ...fast };
    if (route.fast.variant !== undefined) hit.variant = route.fast.variant;
  }

  return hit;
}

function effortRank(v?: string) {
  const i = EFFORT.indexOf((v ?? 'medium') as Effort);
  if (i !== -1) return i;
  return EFFORT.indexOf('medium');
}

function costOf(m: CatalogModel) {
  return m.cost?.input ?? Number.POSITIVE_INFINITY;
}

export function resolveFast(parent: ModelRef, catalog: CatalogModel[], routes?: Route[]): ModelRef | undefined {
  const override = matchRoute(parent, routes ?? []);
  if (override) {
    const sameModel = override.providerID === parent.providerID && override.modelID === parent.modelID;
    if (!sameModel || effortRank(override.variant) < effortRank(parent.variant)) return override;
  }

  const self = catalog.find((m) => m.providerID === parent.providerID && m.id === parent.modelID);
  const variantKeys = Object.keys(self?.variants ?? {});
  if (effortRank(parent.variant) >= effortRank('high') && variantKeys.includes('low')) {
    return { ...parent, variant: 'low' };
  }

  if (!self?.family) return;
  const siblings = catalog.filter(
    (m) =>
      m.providerID === parent.providerID &&
      m.family === self.family &&
      m.tool_call !== false &&
      m.status !== 'deprecated' &&
      costOf(m) < costOf(self),
  );

  siblings.sort((a, b) => costOf(a) - costOf(b));
  const cheap = siblings[0];
  if (!cheap) return;

  return {
    providerID: cheap.providerID,
    modelID: cheap.id,
    variant: Object.keys(cheap.variants ?? {}).includes('low') ? 'low' : undefined,
  };
}
