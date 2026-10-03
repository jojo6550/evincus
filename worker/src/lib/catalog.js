// The catalog bundled into the Worker at deploy. Rules live in data/catalog.js.
import eras from '../../../data/eras.json' with { type: 'json' };
import products from '../../../data/products.json' with { type: 'json' };
import site from '../../../data/site.json' with { type: 'json' };

export const CATALOG = { eras, products, site };
