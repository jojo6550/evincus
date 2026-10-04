// Era order, newest first. `npm run new-era` adds new eras below both markers.
import { merge } from './merge.js';
// eras:imports
import * as era_catastrophe from './catastrophe/era.js';
import * as era_reflection from './reflection/era.js';
import * as era_core from './core/era.js';

const ERAS = [
  // eras:list
  era_catastrophe,
  era_reflection,
  era_core,
];

export const FOLDERS = ERAS.map(m => m.era.slug);
export const CATALOG = merge(ERAS);
