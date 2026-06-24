// Work Sharp Daily Price Scrape
// Scrapes Total Tools + Sydney Tools, writes results to Google Sheets

const https = require('https');

const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY;
const SHEET_ID      = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDS  = JSON.parse(process.env.GOOGLE_CREDENTIALS);

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
  'WSBCHPAJ-PRO':  'WSBCHPAJ-PRO-I',
  'WSEDCPVP-I':    'WSEDCPVP',
  'WSEDCPVT-I':    'WSEDCPVT',
  'WSHHDPVT':      'WSHHDPVT-I',
  'WSCHPAJ-ELT-I': 'WSBCHPAJ-ELT',
  'WSKTS2-A':      'WSKTS2-I',
  'WSKTNRKS-I':    'WSKTNRKS',
  'WSSA000CMB-I':  'WSSA000CMB',
};

function post(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function normaliseSku(sku) {
  return SKU_MAP[sku] || sku;
}

function roundNickel(n) {
  return Math.round(n / 0.05) * 0.05;
}

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
    return products.map(p => ({ supplier, sku: normaliseSku(p.sku), name: p.product_name, price: p.price_aud, inStock: p.in_stock }));
  } catch(e) {
    console.error(`    FAILED: ${e.message}`);
    return [];
  }
}

async function getGoogleToken() {
  // Build JWT for Google service account
  const { createSign } = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: GOOGLE_CREDS.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(GOOGLE_CREDS.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const resp = await post('oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/json' },
    { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }
  );
  return resp.access_token;
}

async function appendToSheet(token, rows) {
  const body = { values: rows };
  const path = `/v4/spreadsheets/${SHEET_ID}/values/Prices!A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const result = await post('sheets.googleapis.com', path,
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body
  );
  return result;
}

async function ensureHeader(token) {
  const path = `/v4/spreadsheets/${SHEET_ID}/values/Prices!A1:L1`;
  const result = await get('sheets.googleapis.com', path, { 'Authorization': `Bearer ${token}` });
  if (!result.values || result.values.length === 0) {
    // Write header row
    await post('sheets.googleapis.com',
      `/v4/spreadsheets/${SHEET_ID}/values/Prices!A1:append?valueInputOption=USER_ENTERED`,
      { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      { values: [['Date','SKU','Product Name','Total Tools Price','Total Tools Stock','Sydney Tools Price','Sydney Tools Stock','# Suppliers','Cheapest','Highest','Market Avg','ITM Match Price','Pricing Rule']] }
    );
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Work Sharp Price Scrape: ${today} ===\n`);

  // Scrape all URLs
  let allRecords = [];
  for (const { supplier, url } of URLS) {
    const records = await scrapeUrl(supplier, url);
    allRecords = allRecords.concat(records);
  }

  // Dedup per supplier
  const seen = new Set();
  const deduped = allRecords.filter(r => {
    const key = `${r.supplier}|${r.sku}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`\nTotal unique records: ${deduped.length}`);

  // Pivot by SKU
  const pivot = {};
  for (const r of deduped) {
    if (!pivot[r.sku]) {
      pivot[r.sku] = { sku: r.sku, name: r.name, tt: 0, ttStock: '', st: 0, stStock: '' };
    }
    if (r.name.length > pivot[r.sku].name.length) pivot[r.sku].name = r.name;
    if (r.supplier === 'Total Tools')  { pivot[r.sku].tt = r.price; pivot[r.sku].ttStock = r.inStock ? 'Yes' : 'No'; }
    if (r.supplier === 'Sydney Tools') { pivot[r.sku].st = r.price; pivot[r.sku].stStock = r.inStock ? 'Yes' : 'No'; }
  }

  // Build rows
  const rows = [];
  for (const sku of Object.keys(pivot).sort()) {
    const p = pivot[sku];
    const prices = [p.tt, p.st].filter(x => x > 0);
    const suppliers = prices.length;
    const cheapest  = prices.length ? Math.min(...prices) : 0;
    const highest   = prices.length ? Math.max(...prices) : 0;
    const avg       = prices.length ? Math.round((prices.reduce((a,b) => a+b,0) / prices.length) * 100) / 100 : 0;

    let matchPrice = 0, note = '';
    if (p.tt > 0 && p.st > 0) {
      if (p.tt === p.st) { matchPrice = roundNickel(p.tt); note = `TT and ST same — matched at $${p.tt}`; }
      else { matchPrice = roundNickel((p.tt + p.st) / 2); note = `Midpoint TT $${p.tt} / ST $${p.st}`; }
    } else if (p.tt > 0) {
      matchPrice = roundNickel(p.tt); note = `Matched Total Tools $${p.tt} (ST not listed)`;
    } else if (p.st > 0) {
      matchPrice = roundNickel(p.st); note = `Matched Sydney Tools $${p.st} (TT not listed)`;
    } else {
      note = 'No competitor prices — set manually';
    }

    rows.push([today, sku, p.name, p.tt || '', p.ttStock, p.st || '', p.stStock, suppliers, cheapest || '', highest || '', avg || '', matchPrice || '', note]);
  }

  console.log(`\nWriting ${rows.length} rows to Google Sheets...`);
  const token = await getGoogleToken();
  await ensureHeader(token);
  await appendToSheet(token, rows);
  console.log(`Done! ${rows.length} SKUs written for ${today}`);
}

main().catch(e => { console.error(e); process.exit(1); });
