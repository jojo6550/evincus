// Core. Photos live in ./img and are referenced by filename.

export const era = {
  slug: "core",
  name: "Core",
  tagline: "Always in the line-up",
  story: "Heavyweight oversized tees that stay in the store between drops.",
  hero: "hero.webp",
  dropsAt: null,
  endsAt: null
};

export const products = [
  {
    id: "99-tee",
    name: "99 Tee",
    category: "tees",
    priceCents: 3499,
    fabric: "Oversized fit, 100% cotton, 300 g/m² (8.8 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Classic Black",
        hex: "#151515",
        images: ["99-tee-classic-black-1.webp", "99-tee-classic-black-2.jpg"]
      },
      {
        name: "Lucent White",
        hex: "#F4F4F2",
        images: ["99-tee-lucent-white-1.webp", "99-tee-lucent-white-2.jpg"]
      }
    ],
    soldOut: false,
    soldOutVariants: []
  },
  {
    id: "flaming-eye-tee",
    name: "Flaming Eye Tee",
    category: "tees",
    priceCents: 3099,
    fabric: "Oversized fit, 100% cotton, 300 g/m² (8.8 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Classic Black",
        hex: "#151515",
        images: ["flaming-eye-tee-classic-black-1.webp", "flaming-eye-tee-classic-black-2.webp"]
      },
      {
        name: "Lucent White",
        hex: "#F4F4F2",
        images: ["flaming-eye-tee-lucent-white-1.webp", "flaming-eye-tee-lucent-white-2.jpg"]
      }
    ],
    soldOut: false,
    soldOutVariants: []
  },
  {
    id: "worldwide-tee",
    name: "Worldwide Tee",
    category: "tees",
    priceCents: 3099,
    fabric: "Oversized fit, 100% cotton, 300 g/m² (8.8 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Classic Black",
        hex: "#151515"
      },
      {
        name: "Lucent White",
        hex: "#F4F4F2"
      },
      {
        name: "Grape Purple",
        hex: "#5B3A78"
      },
      {
        name: "Jungle Green",
        hex: "#2F4F3A"
      },
      {
        name: "Cherry Blossom Pink",
        hex: "#F1C6D3"
      },
      {
        name: "Light Gray",
        hex: "#CFCFCB"
      }
    ],
    images: ["worldwide-tee-1.webp", "worldwide-tee-2.webp", "worldwide-tee-3.jpg", "worldwide-tee-4.jpg", "worldwide-tee-5.jpg", "worldwide-tee-6.jpg", "worldwide-tee-7.jpg", "worldwide-tee-8.jpg"],
    soldOut: false,
    soldOutVariants: []
  }
];
