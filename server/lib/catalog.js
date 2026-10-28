// The catalog bundled into the server at deploy. Era data lives in data/eras/, rules in data/catalog.js.
import { CATALOG as ERA_CATALOG } from '../../data/eras/index.js';
import { applyStock, lineKey } from '../../data/catalog.js';
import site from '../../data/site.json' with { type: 'json' };

// shortcut: stock is seeded from the bundled soldOut flags until the KV catalog and stock replace this; drop with the flags.
const flagged = new Map(ERA_CATALOG.products.flatMap(p => p.colors.flatMap(c => p.sizes.map(s => [
  lineKey(p.id, c.name, s),
  { onHand: p.soldOut === true || (p.soldOutVariants ?? []).includes(`${c.name}|${s}`) ? 0 : 1000, committed: 0 },
]))));

export const CATALOG = { ...applyStock(ERA_CATALOG, flagged), site };
