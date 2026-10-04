// Reflection. Photos live in ./img and are referenced by filename.

export const era = {
  slug: "reflection",
  name: "Reflection",
  tagline: "Stripes on repeat",
  story: "A striped track jacket and pants in a cotton-rich 365 g/m² knit.",
  hero: "hero.jpg",
  dropsAt: null,
  endsAt: null
};

export const products = [
  {
    id: "reflection-track-jacket",
    name: "Reflection Striped Track Jacket",
    category: "outerwear",
    priceCents: 4999,
    fabric: "Unisex, 64% cotton / 36% polyester, 365 g/m² (10.8 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Black",
        hex: "#151515"
      },
      {
        name: "Red",
        hex: "#9E1B1F"
      },
      {
        name: "Dark Gray",
        hex: "#3A3A3A"
      }
    ],
    images: ["reflection-track-jacket-1.jpg", "reflection-track-jacket-2.jpg", "reflection-track-jacket-3.jpg", "reflection-track-jacket-4.jpg", "reflection-track-jacket-5.jpg", "reflection-track-jacket-6.jpg"],
    soldOut: false,
    soldOutVariants: []
  },
  {
    id: "reflection-track-pants",
    name: "Reflection Striped Track Pants",
    category: "bottoms",
    priceCents: 4099,
    fabric: "Unisex, 64% cotton / 36% polyester, 365 g/m² (10.8 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Black",
        hex: "#151515"
      },
      {
        name: "Red",
        hex: "#9E1B1F"
      },
      {
        name: "Dark Gray",
        hex: "#3A3A3A"
      }
    ],
    images: ["reflection-track-pants-1.jpg", "reflection-track-pants-2.jpg", "reflection-track-pants-3.jpg", "reflection-track-pants-4.jpg", "reflection-track-pants-5.jpg", "reflection-track-pants-6.jpg"],
    soldOut: false,
    soldOutVariants: []
  }
];
