// Catalog — mirrors the live Shopify store (evincus.shop), with duplicate
// listings merged into one product per design. Prices in USD.
const CDN = 'https://cdn.shopify.com/s/files/1/0923/9258/7635/files/';
const img = f => CDN + f;

const TEE_SIZES   = ['S', 'M', 'L', 'XL', '2XL'];
const HEAVY_TEE   = 'Oversized fit, 100% cotton, 300 g/m² (8.8 oz/yd²)';
const FLEECE      = 'Unisex, 51% polyester / 49% cotton fleece, 360 g/m² (10.6 oz/yd²)';
const TRACK       = 'Unisex, 64% cotton / 36% polyester, 365 g/m² (10.8 oz/yd²)';
const CARE        = 'Machine wash at 30°C on a gentle cycle. Do not bleach. Tumble dry low. Iron at low temperature.';

export const LOOKBOOK = [
  'https://evincus.shop/cdn/shop/files/IMG_0559.jpg?v=1771262379&width=2400',
  'https://evincus.shop/cdn/shop/files/IMG_0566.jpg?v=1771263317&width=1600',
  'https://evincus.shop/cdn/shop/files/IMG_0561.jpg?v=1771263510&width=1600',
  'https://evincus.shop/cdn/shop/files/IMG_0558.jpg?v=1771263676&width=1500',
];

export const CATEGORIES = [
  { id: 'all',       name: 'Everything' },
  { id: 'tees',      name: 'Tees' },
  { id: 'outerwear', name: 'Outerwear' },
  { id: 'bottoms',   name: 'Bottoms' },
];

export const PRODUCTS = [
  {
    id: 'catastrophe-zip-hoodie',
    name: 'Catastrophe Zip Hoodie',
    collection: 'Catastrophe',
    category: 'outerwear',
    price: 45.99,
    fabric: FLEECE,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Black', hex: '#151515' },
      { name: 'Brown', hex: '#4A3528' },
    ],
    images: [
      img('768e2b9b0f454633b767e5a733300e20.png?v=1773436716'),
      img('8d22fcadc26f442d88a2b696ba93ea06.png?v=1773436716'),
      img('b8100ebf89124a4694541e79711b0a6a.png?v=1773436716'),
      img('381ef1586d254a5fb3dabd0aa2f8461f.png?v=1773436716'),
    ],
  },
  {
    id: 'catastrophe-sweatpants',
    name: 'Catastrophe Sweatpants',
    collection: 'Catastrophe',
    category: 'bottoms',
    price: 45.00,
    fabric: FLEECE + ', straight leg with drawstring',
    sizes: TEE_SIZES,
    colors: [
      { name: 'Black', hex: '#151515' },
      { name: 'Brown', hex: '#4A3528' },
    ],
    images: [
      img('b696b662411246e9a64842af154198d6.png?v=1775926227'),
      img('227bc27968334a78b3d951849cdc71f9.png?v=1775926227'),
      img('c868150017b245458831381647e8780c.png?v=1775926227'),
      img('29bcd906916a4e8c8c37e5ce6252d8c0.png?v=1775926229'),
    ],
  },
  {
    id: 'disaster-zone-tee',
    name: 'Disaster Zone Tee',
    collection: 'Catastrophe',
    category: 'tees',
    price: 34.99,
    fabric: HEAVY_TEE,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Black, white print',  hex: '#151515', ring: '#F2F2F0',
        images: [img('rn-image_picker_lib_temp_8a961301-4e10-4060-be2c-261b02ed441e.png?v=1771779269'), img('disaster_zone_mockup_back_darker.png?v=1771779250')] },
      { name: 'Black, red print',    hex: '#151515', ring: '#B3262B',
        images: [img('disaster_zone_mockup_red_front_2.png?v=1774546847'), img('disaster_zone_mockup_red_back_2.png?v=1774546847')] },
      { name: 'Black, purple print', hex: '#151515', ring: '#7B4FA8',
        images: [img('disaster_zone_mockup_purple_front_2.png?v=1774546920'), img('disaster_zone_mockup_purple_back_2.png?v=1774546919')] },
    ],
  },
  {
    id: 'made-for-chaos-tee',
    name: 'Made for Chaos Distressed Tee',
    collection: 'Catastrophe',
    category: 'tees',
    price: 38.99,
    fabric: 'Oversized cropped boxy fit, 100% cotton, 300 g/m² (8.8 oz/yd²), distressed finish',
    sizes: ['S', 'M', 'L', 'XL'],
    colors: [
      { name: 'Washed Black',       hex: '#2B2B2B' },
      { name: 'Washed White',       hex: '#E8E6E0' },
      { name: 'Washed Cement Gray', hex: '#8E8D88' },
    ],
    images: [
      img('ChatGPT_Image_Feb_16_2026_01_12_34_PM.png?v=1771266346'),
      img('242843bea0da4461b3228e6d2c22c21a.png?v=1771266346'),
      img('d4f35aa497074b219317fead0304ac23.png?v=1771349511'),
      img('2ac258363265455c8833a141ebc6b347.png?v=1771266346'),
      img('9708e77d635f486890f9c1e653c794a5.png?v=1771266346'),
      img('4e5404601d874b70998c06cd53599d22.png?v=1771266346'),
    ],
  },
  {
    id: 'reflection-track-jacket',
    name: 'Reflection Striped Track Jacket',
    collection: 'Reflection',
    category: 'outerwear',
    price: 49.99,
    fabric: TRACK,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Black',     hex: '#151515' },
      { name: 'Red',       hex: '#9E1B1F' },
      { name: 'Dark Gray', hex: '#3A3A3A' },
    ],
    images: [
      img('7b0b25855ae3438085098ca9cadeb57f.png?v=1773206367'),
      img('5fd00bfaf64e4406b1c6f158ec50d72c.png?v=1773206367'),
      img('8a8a69ae481c41d3aa6aa269a6a500b1.png?v=1773206367'),
      img('1d9aafe50d9341f8b3a4ed30c7bc8015.png?v=1773206366'),
      img('621645c275544adc94a392cd45df2ff8.png?v=1773206367'),
      img('471c9d2691e44909b252d1d859824489.png?v=1773206367'),
    ],
  },
  {
    id: 'reflection-track-pants',
    name: 'Reflection Striped Track Pants',
    collection: 'Reflection',
    category: 'bottoms',
    price: 40.99,
    fabric: TRACK,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Black',     hex: '#151515' },
      { name: 'Red',       hex: '#9E1B1F' },
      { name: 'Dark Gray', hex: '#3A3A3A' },
    ],
    images: [
      img('35640d57d32c496db6ad869a0b4eb9db.png?v=1773206606'),
      img('8968fdbd6d484ea4a11db516c841bee8.png?v=1773206607'),
      img('b86b493bb3d840c1a31be7cf4a9fc613.png?v=1773206607'),
      img('4bfe1b2664074985b0e4f90902e94321.png?v=1773206607'),
      img('d2b0679c2a8b402b8ac48c81013995b0.png?v=1773206606'),
      img('6aca6159b045434a987a2327c07214d0.png?v=1773206607'),
    ],
  },
  {
    id: '99-tee',
    name: '99 Tee',
    collection: 'Core',
    category: 'tees',
    price: 34.99,
    fabric: HEAVY_TEE,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Classic Black', hex: '#151515',
        images: [img('rn-image_picker_lib_temp_f0746b01-53eb-40f7-9cdf-a726f64c12b0.png?v=1771580365'), img('c3fd1a8682a74d89b4626d9c64b6b77a.png?v=1771580323')] },
      { name: 'Lucent White',  hex: '#F4F4F2',
        images: [img('image_2026-02-17_131815390.png?v=1771352371'), img('4c42b2cfd89d4f689b4f0b3b50c51f8c.png?v=1771352332')] },
    ],
  },
  {
    id: 'flaming-eye-tee',
    name: 'Flaming Eye Tee',
    collection: 'Core',
    category: 'tees',
    price: 30.99,
    fabric: HEAVY_TEE,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Classic Black', hex: '#151515',
        images: [img('ChatGPT_Image_Feb_16_2026_01_12_24_PM.png?v=1771266303'), img('talk_less_do_more_mockup.png?v=1771266303')] },
      { name: 'Lucent White',  hex: '#F4F4F2',
        images: [img('image_2026-02-17_131756655.png?v=1771352403'), img('ef027254b01642988f20fb115731b338.png?v=1771352309')] },
    ],
  },
  {
    id: 'worldwide-tee',
    name: 'Worldwide Tee',
    collection: 'Core',
    category: 'tees',
    price: 30.99,
    fabric: HEAVY_TEE,
    sizes: TEE_SIZES,
    colors: [
      { name: 'Classic Black',       hex: '#151515' },
      { name: 'Lucent White',        hex: '#F4F4F2' },
      { name: 'Grape Purple',        hex: '#5B3A78' },
      { name: 'Jungle Green',        hex: '#2F4F3A' },
      { name: 'Cherry Blossom Pink', hex: '#F1C6D3' },
      { name: 'Light Gray',          hex: '#CFCFCB' },
    ],
    images: [
      img('rn-image_picker_lib_temp_82bb757f-11c0-4236-8d33-ff0ee4025257.png?v=1771492892'),
      img('rn-image_picker_lib_temp_e1179604-839f-4104-9e19-b0e6b98ed352.png?v=1771492928'),
      img('304c9c05849e4298b18e4a175a83e494.png?v=1771492892'),
      img('aa02a99d8e224406b1be6c0cdfc888e9.png?v=1771492892'),
      img('041b0656bd7d4d7e96fa7cb20d637911.png?v=1771492892'),
      img('8a23109cc76643129f261bc4024806ce.png?v=1771492892'),
      img('e4521e05d8c54654a3a066f3360577c0.png?v=1771492828'),
      img('8848d931f87c458bb7d294a45c2ba002.png?v=1771492828'),
    ],
  },
];

export const CARE_NOTE = CARE;

export function findProduct(id) {
  return PRODUCTS.find(p => p.id === id);
}

export function imagesFor(product, colorName) {
  const c = product.colors.find(c => c.name === colorName);
  return c?.images ?? product.images ?? product.colors[0].images;
}

export function money(n) {
  return '$' + Number(n).toFixed(2);
}
