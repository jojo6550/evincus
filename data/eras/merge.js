// Turns the era folders into the catalog shape the rest of the code uses: { eras, products }.
// Image fields in era.js are bare filenames; here they become paths relative to the site root.
// No validation: tests/data.test.mjs checks the real catalog.

export const imgPath = (slug, file) => `data/eras/${slug}/img/${file}`;

const withPaths = (slug, files) => files.map(f => imgPath(slug, f));

export function merge(modules) {
  const eras = modules.map(({ era }) => ({ ...era, hero: imgPath(era.slug, era.hero) }));
  const products = modules.flatMap(({ era, products }) =>
    products.map(({ id, ...p }) => ({
      id,
      era: era.slug,
      ...p,
      ...(p.images && { images: withPaths(era.slug, p.images) }),
      colors: p.colors.map(c => (c.images ? { ...c, images: withPaths(era.slug, c.images) } : c)),
    })),
  );
  return { eras, products };
}
