// Work Sharp Daily Price Scrape
// Scrapes Total Tools + Sydney Tools, writes latest-prices.csv and history/YYYY-MM-DD.csv to repo

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY;

const URLS = [
  { supplier: 'Total Tools', url: 'https://www.totaltools.com.au/brands/worksharp' },
  { supplier: 'Sydney Tools', url: 'https://sydneytools.com.au/category/by-brand/work-sharp/sharpeners' },
  { supplier: 'Sydney Tools', url: 'https://sydneytools.com.au/category/by-brand/work-sharp/sanding-belts' },
  { supplier: 'Sydney Tools', url: 'https://sydneytools.com.au/category/by-brand/work-sharp/knife-blades' },
  { supplier: 'Sydney Tools', url: 'https://sydneytools.com.au/category/by-brand/work-sharp/knives' },
  { supplier: 'Sydney Tools', url: 'https://sydneytools.com.au/category/by-brand/work-sharp/sharpener-attachments' },
  { supplier: 'Sydney Tools', url: 'https://sydneytools.com.au/category/by-brand/work-sharp/tool-bags' },
];

const SKU_MAP = {
  'WSBCHPAJ-1':    'WSBCHPAJ-I',
  'WSSA0004772-I': 'WSSA0004772',
  'WSHHDPVT':      'WSHHDPVT-I',
  'WSHHDPV-I':     'WSHHDPVT-I',   // TT variant — same product as WSHHDPVT-I
  'WSCHPAJ-ELT-I': 'WSBCHPAJ-ELT',
  'WSKTS2-A':      'WSKTS2-I',
  'WSKTNRKS-I':    'WSKTNRKS',
  'WSSA000CMB-I':  'WSSA000CMB',
};

function post(hostname, path_, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path: path_, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function normaliseSku(sku) { return SKU_MAP[sku] || sku; }
function roundNickel(n)    { return Math.round(n / 0.05) * 0.05; }

async function scrapeUrl(supplier, url) {
  console.log(`  Scraping ${supplier}: ${url}`);
  try {
    const result = await post('api.firecrawl.dev', '/v1/scrape',
      { 'Authorization': `Bearer ${FIRECRAWL_KEY}`, 'Content-Type': 'application/json' },
      {
        url,
        formats: ['extract'],
        extract: {
          prompt: 'Extract all Work Sharp brand products from this page. Return product name, SKU/model number (e.g. WSGFS221, WSBCHPAJ-I), price in AUD as a number only, and whether in stock.',
          schema: {
            type: 'object',
            properties: {
              products: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    product_name: { type: 'string' },
                    sku:          { type: 'string' },
                    price_aud:    { type: 'number' },
                    in_stock:     { type: 'boolean' }
                  },
                  required: ['product_name', 'sku', 'price_aud', 'in_stock']
                }
              }
            }
          }
        }
      }
    );
    const products = result?.data?.extract?.products || [];
    console.log(`    → ${products.length} products`);
    return products.map(p => ({
      supplier,
      sku:     normaliseSku(p.sku),
      name:    p.product_name,
      price:   p.price_aud,
      inStock: p.in_stock
    }));
  } catch(e) {
    console.error(`    FAILED: ${e.message}`);
    return [];
  }
}

function toCsv(rows) {
  const header = ['Date','SKU','Product Name','Total Tools Price','Total Tools Stock','Sydney Tools Price','Sydney Tools Stock','# Suppliers','Cheapest','Highest','Market Avg','ITM Match Price','Pricing Rule'];
  const escape = v => (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) ? `"${v.replace(/"/g,'""')}"` : v;
  return [header, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Work Sharp Price Scrape: ${today} ===\n`);

  // Scrape
  let allRecords = [];
  for (const { supplier, url } of URLS) {
    allRecords = allRecords.concat(await scrapeUrl(supplier, url));
  }

  // Dedup per supplier+SKU
  const seen = new Set();
  const deduped = allRecords.filter(r => {
    const key = `${r.supplier}|${r.sku}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`\nUnique records: ${deduped.length}`);

  // Pivot by SKU
  const pivot = {};
  for (const r of deduped) {
    if (!pivot[r.sku]) pivot[r.sku] = { sku: r.sku, name: r.name, tt: 0, ttStock: '', st: 0, stStock: '' };
    if (r.name.length > pivot[r.sku].name.length) pivot[r.sku].name = r.name;
    if (r.supplier === 'Total Tools')  { pivot[r.sku].tt = r.price; pivot[r.sku].ttStock = r.inStock ? 'Yes' : 'No'; }
    if (r.supplier === 'Sydney Tools') { pivot[r.sku].st = r.price; pivot[r.sku].stStock = r.inStock ? 'Yes' : 'No'; }
  }

  // Build CSV rows
  const csvRows = [];
  for (const sku of Object.keys(pivot).sort()) {
    const p = pivot[sku];
    const prices   = [p.tt, p.st].filter(x => x > 0);
    const cheapest = prices.length ? Math.min(...prices) : '';
    const highest  = prices.length ? Math.max(...prices) : '';
    const avg      = prices.length ? Math.round(prices.reduce((a,b) => a+b,0) / prices.length * 100) / 100 : '';

    const r2 = v => Math.round(v * 100) / 100;

    let matchPrice = '', note = '';
    if (p.tt > 0 && p.st > 0) {
      if (p.tt === p.st) { matchPrice = r2(roundNickel(p.tt));          note = `TT and ST same — matched at $${p.tt}`; }
      else               { matchPrice = r2(roundNickel((p.tt+p.st)/2)); note = `Midpoint TT $${p.tt} / ST $${p.st}`; }
    } else if (p.tt > 0) {
      matchPrice = r2(roundNickel(p.tt)); note = `Matched Total Tools $${p.tt} (ST not listed)`;
    } else if (p.st > 0) {
      matchPrice = r2(roundNickel(p.st)); note = `Matched Sydney Tools $${p.st} (TT not listed)`;
    } else {
      note = 'No competitor prices — set manually';
    }

    csvRows.push([today, sku, p.name, p.tt ? r2(p.tt) : '', p.ttStock, p.st ? r2(p.st) : '', p.stStock, prices.length, cheapest ? r2(cheapest) : '', highest ? r2(highest) : '', avg ? r2(avg) : '', matchPrice, note]);
  }

  // Write files
  const csv = toCsv(csvRows);

  // latest-prices.csv — always overwritten, this is what NetSuite will pull
  fs.writeFileSync('latest-prices.csv', csv, 'utf8');

  // history/YYYY-MM-DD.csv — daily archive
  fs.mkdirSync('history', { recursive: true });
  fs.writeFileSync(`history/${today}.csv`, csv, 'utf8');

  console.log(`Written: latest-prices.csv and history/${today}.csv (${csvRows.length} SKUs)`);
}

main().catch(e => { console.error(e); process.exit(1); });
