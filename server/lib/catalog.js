// The catalog bundled into the Worker at deploy. Era data lives in data/eras/, rules in data/catalog.js.
import { CATALOG as ERA_CATALOG } from '../../data/eras/index.js';
import site from '../../data/site.json' with { type: 'json' };

export const CATALOG = { ...ERA_CATALOG, site };
