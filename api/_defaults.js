// Shared business defaults for api/agent.js and api/deposit.js (not a public endpoint).
// Fallback business facts, used only if the Booking API's public_settings can't be reached.
const DEFAULT_SETTINGS = {
  business: { name: 'Sparkle & Bling Mobile Auto Detailing', phone: '(661) 481-5317' },
  packages: {
    express: { label: 'Express Wash & Wax', sedan: 135, mid_suv: 165, full_suv: 185 },
    signature: { label: 'Signature Full Detail', sedan: 265, mid_suv: 305, full_suv: 345 },
    ceramic_3yr: { label: '3-Year Ceramic Shield', sedan: 1050, mid_suv: 1260, full_suv: 1470 },
    ceramic_5yr: { label: '5-Year Graphene Armor', sedan: 1575, mid_suv: 1785, full_suv: 1995 },
    ceramic_lifetime: { label: 'Lifetime Crown Graphene', sedan: 2625, mid_suv: 3045, full_suv: 3465 }
  },
  addons: {
    headlight: { label: 'Headlight Restoration', price: 95 }, engine: { label: 'Engine Bay Detail', price: 125 },
    petHair: { label: 'Pet Hair Extraction', price: 85 }, glass: { label: 'Windshield Ceramic Shield', price: 75 },
    wheelCoating: { label: 'Wheel Barrel Ceramic Barrier', price: 150 }
  },
  sizeLabels: { sedan: 'Sedan / Coupe', mid_suv: 'Mid-size SUV / Pickup', full_suv: 'Full-size SUV / Van' },
  ceramicVoucher: 150,
  serviceCities: ['Lancaster', 'Palmdale', 'Quartz Hill', 'Santa Clarita', 'Valencia', 'Stevenson Ranch', 'Saugus', 'Newhall', 'Canyon Country', 'Rosamond', 'Acton']
};

const SITE_FACTS = `
- Fully mobile: we come to the customer's home or work with our own deionized spot-free water and power. No hookups needed.
- Ceramic and graphene coatings are 9H and include paint correction (multi-stage machine polish) before coating. Coating warranties are registered to the vehicle's VIN through CARFAX.
- Express Wash & Wax: maintenance hand wash and refresh. Signature Full Detail: full interior (steam, hot-water extraction of seats/carpets/headliner) plus exterior.
- Licensed, $1M insured, 4.9-star rating with 180+ local reviews, BBB A+.
- New ceramic clients get a ceramic prep credit (amount in settings: ceramicVoucher).
- Expanding to Henderson / Las Vegas (Henderson, Green Valley, Anthem, Inspirada, Lake Las Vegas, Seven Hills, Southern Highlands) for ceramic coating; those requests can always be taken as a quote request even if online booking there isn't open yet.
- Exact final price is confirmed after the paint is seen; very dirty interiors, heavy pet hair or heavy oxidation may cost more.`;

module.exports = { DEFAULT_SETTINGS, SITE_FACTS };
