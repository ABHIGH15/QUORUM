/**
 * Quorum Curated Catalog Fixture (§12.1)
 * 
 * Deliberate boundary pricing for testing Quorum Guard & Policy thresholds:
 * - $59 (Tier 1: 2 votes) vs $60 (Tier 1 limit: 2 votes) vs $61 (Tier 2: 4 votes)
 * - $135 (Tier 2 compliant alternative) vs $145 (Tier 2 compliant primary)
 * - $149 (Tier 2: 4 votes) vs $150 (Unanimity threshold: 4 votes) vs $151 (Unanimous: 6 votes)
 * - $180 (Unanimity tier: 6 votes)
 * - $199 (Under cap: 4 votes) vs $200 (Hard cap limit: 4 votes) vs $201 (Over cap: BLOCKED)
 * - $350 (Over cap: BLOCKED)
 */

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  vendorId: string;
  vendorName: string;
  priceCents: number;
  specs: Record<string, string | number>;
}

export const CURATED_CATALOG: CatalogItem[] = [
  // --- PROJECTORS ---
  {
    id: 'prod_proj_pro_4k',
    name: 'Lumix Cinema 4K Pro Projector',
    description: 'Ultra-bright 4000 lumens commercial projector for large auditoriums.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 35000, // $350.00 (Exceeds $200 hard cap -> BLOCKED)
    specs: { resolution: '4K UHD', brightness: '4000 lumens', throwRatio: '1.2:1' },
  },
  {
    id: 'prod_proj_hd_executive',
    name: 'ViewMax HD Executive Projector',
    description: 'High-clarity conference projector with wireless streaming.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 18000, // $180.00 (Above $150 -> Mandates 6/6 Unanimity)
    specs: { resolution: '1080p FHD', brightness: '3200 lumens', connectivity: 'Wi-Fi/HDMI' },
  },
  {
    id: 'prod_proj_hd_standard',
    name: 'OptiView HD Classroom Projector',
    description: 'Crisp 1080p native projector, low-latency, energy efficient.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 14500, // $145.00 (Tier 2: 4 votes required)
    specs: { resolution: '1080p FHD', brightness: '2800 lumens', contrast: '10000:1' },
  },
  {
    id: 'prod_proj_portable_lite',
    name: 'PocketCast Portable Mini Projector',
    description: 'Compact travel projector with built-in battery and stereo speaker.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 13500, // $135.00 (Tier 2: 4 votes required, alternative)
    specs: { resolution: '720p HD', brightness: '1500 lumens', batteryHours: 3 },
  },

  // --- TIER 1 BOUNDARY TEST ITEMS ($60 TIER LIMIT) ---
  {
    id: 'prod_mic_budget',
    name: 'VocalPro USB Boundary Mic',
    description: 'Clear desk microphone for committee presentations.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 5900, // $59.00 (Tier 1: <= $60 -> 2 votes)
    specs: { pattern: 'Cardioid', connection: 'USB-C' },
  },
  {
    id: 'prod_mic_exact_tier1',
    name: 'VocalPro Dual Wireless Mic Set',
    description: 'Dual wireless microphones tuned for spoken word clarity.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 6000, // $60.00 (Tier 1 limit: exactly $60 -> 2 votes)
    specs: { rangeMeters: 30, frequency: '2.4GHz' },
  },
  {
    id: 'prod_mic_tier2_boundary',
    name: 'SoundCraft Studio Condenser Mic',
    description: 'Broadcasting studio microphone with pop filter and boom arm.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 6100, // $61.00 (Tier 2: > $60 -> 4 votes)
    specs: { diaphragm: 'Large', sampleRate: '192kHz/24bit' },
  },

  // --- UNANIMITY BOUNDARY TEST ITEMS ($150 THRESHOLD) ---
  {
    id: 'prod_screen_tier2',
    name: 'Panaview 100-inch Pull-Down Screen',
    description: 'Matte white high-gain projection screen with black borders.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 14900, // $149.00 (Tier 2: <= $150 -> 4 votes)
    specs: { sizeInches: 100, gain: '1.1', aspectRatio: '16:9' },
  },
  {
    id: 'prod_screen_exact_unanimous',
    name: 'Panaview 110-inch Motorized Screen',
    description: 'Motorized projection screen with wireless remote control.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 15000, // $150.00 (Threshold: exactly $150 -> 4 votes)
    specs: { sizeInches: 110, motorType: 'Synchronous', gain: '1.2' },
  },
  {
    id: 'prod_screen_unanimous_over',
    name: 'Panaview 120-inch Motorized Acoustic Screen',
    description: 'Acoustically transparent motorized screen for front-speaker setups.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 15100, // $151.00 (Above $150 -> Mandates 6/6 Unanimity)
    specs: { sizeInches: 120, weave: 'Perforated', gain: '1.0' },
  },

  // --- HARD CAP BOUNDARY TEST ITEMS ($200 HARD CAP) ---
  {
    id: 'prod_av_system_under_cap',
    name: 'OmniSound 5.1 Presentation Soundbar',
    description: 'Surround soundbar with wireless subwoofer for auditoriums.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 19900, // $199.00 (Under hard cap: <= $200 -> Unanimous 6 votes)
    specs: { powerWatts: 300, channels: 5.1 },
  },
  {
    id: 'prod_av_system_exact_cap',
    name: 'OmniSound Pro Auditorium PA System',
    description: 'Integrated dual-speaker PA system with mixer and Bluetooth.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 20000, // $200.00 (Hard cap limit: exactly $200 -> Unanimous 6 votes)
    specs: { powerWatts: 500, inputs: 6 },
  },
  {
    id: 'prod_av_system_over_cap',
    name: 'OmniSound Touring Line Array',
    description: 'Compact line array sound system for large outdoor events.',
    category: 'equipment',
    vendorId: 'v_projector_shop',
    vendorName: 'Projector Shop',
    priceCents: 20100, // $201.00 (Above $200 -> BLOCKED by HARD_CAP_EXCEEDED)
    specs: { powerWatts: 800, maxSpl: '120dB' },
  },

  // --- UNALLOWLISTED VENDOR ITEM (For Guard negative testing) ---
  {
    id: 'prod_unverified_gadget',
    name: 'QuickVendor Portable Speaker',
    description: 'Unverified external vendor item for policy testing.',
    category: 'equipment',
    vendorId: 'v_unverified_discount_depot',
    vendorName: 'Discount Depot',
    priceCents: 4500, // $45.00
    specs: { bluetooth: '5.0' },
  },
];
