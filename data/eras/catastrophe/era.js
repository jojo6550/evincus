// Catastrophe. Photos live in ./img and are referenced by filename.

export const era = {
  slug: "catastrophe",
  name: "Catastrophe",
  tagline: "Peace in chaos",
  story: "Zip fleece, heavyweight cotton and distressed washes. In black, brown and bold prints.",
  hero: "hero.jpg",
  dropsAt: null,
  endsAt: null
};

export const products = [
  {
    id: "catastrophe-zip-hoodie",
    name: "Catastrophe Zip Hoodie",
    category: "outerwear",
    priceCents: 4599,
    fabric: "Unisex, 51% polyester / 49% cotton fleece, 360 g/m² (10.6 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Black",
        hex: "#151515"
      },
      {
        name: "Brown",
        hex: "#4A3528"
      }
    ],
    images: ["catastrophe-zip-hoodie-1.jpg", "catastrophe-zip-hoodie-2.jpg", "catastrophe-zip-hoodie-3.jpg", "catastrophe-zip-hoodie-4.jpg"],
    soldOut: false,
    soldOutVariants: []
  },
  {
    id: "catastrophe-sweatpants",
    name: "Catastrophe Sweatpants",
    category: "bottoms",
    priceCents: 4500,
    fabric: "Unisex, 51% polyester / 49% cotton fleece, 360 g/m² (10.6 oz/yd²), straight leg with drawstring",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Black",
        hex: "#151515"
      },
      {
        name: "Brown",
        hex: "#4A3528"
      }
    ],
    images: ["catastrophe-sweatpants-1.jpg", "catastrophe-sweatpants-2.jpg", "catastrophe-sweatpants-3.jpg", "catastrophe-sweatpants-4.jpg"],
    soldOut: false,
    soldOutVariants: []
  },
  {
    id: "disaster-zone-tee",
    name: "Disaster Zone Tee",
    category: "tees",
    priceCents: 3499,
    fabric: "Oversized fit, 100% cotton, 300 g/m² (8.8 oz/yd²)",
    sizes: ["S", "M", "L", "XL", "2XL"],
    colors: [
      {
        name: "Black, white print",
        hex: "#151515",
        ring: "#F2F2F0",
        images: ["disaster-zone-tee-black-white-print-1.webp", "disaster-zone-tee-black-white-print-2.webp"]
      },
      {
        name: "Black, red print",
        hex: "#151515",
        ring: "#B3262B",
        images: ["disaster-zone-tee-black-red-print-1.webp", "disaster-zone-tee-black-red-print-2.webp"]
      },
      {
        name: "Black, purple print",
        hex: "#151515",
        ring: "#7B4FA8",
        images: ["disaster-zone-tee-black-purple-print-1.webp", "disaster-zone-tee-black-purple-print-2.webp"]
      }
    ],
    soldOut: false,
    soldOutVariants: []
  },
  {
    id: "made-for-chaos-tee",
    name: "Made for Chaos Distressed Tee",
    category: "tees",
    priceCents: 3899,
    fabric: "Oversized cropped boxy fit, 100% cotton, 300 g/m² (8.8 oz/yd²), distressed finish",
    sizes: ["S", "M", "L", "XL"],
    colors: [
      {
        name: "Washed Black",
        hex: "#2B2B2B"
      },
      {
        name: "Washed White",
        hex: "#E8E6E0"
      },
      {
        name: "Washed Cement Gray",
        hex: "#8E8D88"
      }
    ],
    images: ["made-for-chaos-tee-1.jpg", "made-for-chaos-tee-2.jpg", "made-for-chaos-tee-3.webp", "made-for-chaos-tee-4.jpg", "made-for-chaos-tee-5.jpg", "made-for-chaos-tee-6.jpg"],
    soldOut: false,
    soldOutVariants: []
  }
];
