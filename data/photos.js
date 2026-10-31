// Photo size rules shared by the inventory app, the build script and the tests. Pure.
export const WIDTHS = [480, 960, 1440];
export const MAX_VARIANT_BYTES = 250 * 1024;
export const MIN_WIDTH = 100; // media names carry a 3-4 digit width

// Standard widths up to the photo's own width, plus that width itself when it is under the largest.
export const variantWidths = width =>
  [...new Set([...WIDTHS.filter(w => w <= width), ...(width < WIDTHS.at(-1) ? [width] : [])])].sort((a, b) => a - b);

export const photoPath = (ref, w = ref.widths.at(-1)) => `media/${ref.id}-${w}.${ref.ext}`;

export const manifestEntry = ref => ({
  width: ref.width,
  height: ref.height,
  variants: ref.widths.map(width => ({ src: photoPath(ref, width), width })),
});
