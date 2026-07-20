/**
 * ML Fly — serveur de recherche de vols RÉELS
 * -------------------------------------------
 * Source 100% gratuite active par défaut :
 *   - Travelpayouts / Aviasales Data API  -> vrais prix réels (cache ~7 jours), gratuit, sans carte bancaire
 * Source optionnelle (désactivée tant qu'aucune clé n'est fournie) :
 *   - Duffel -> prix en direct temps réel, mais payant à l'usage en mode "live"
 * Le serveur n'utilise que les sources pour lesquelles une clé est configurée dans .env.
 * Sans clé Duffel, tout fonctionne normalement avec Travelpayouts seul.
 *
 * Installation :
 *   1. npm install
 *   2. Copier .env.example vers .env et renseigner TRAVELPAYOUTS_TOKEN (gratuit)
 *   3. npm start   (démarre sur le port 3000 par défaut)
 *
 * Déploiement rapide (gratuit) : Render.com, Railway.app ou Fly.io
 *   - Ajoute ce dossier comme repo Git
 *   - "Start command": node server.js
 *   - Renseigne les variables d'environnement du .env dans les settings du service
 */
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const DUFFEL_TOKEN = process.env.DUFFEL_TOKEN || ''; // clé "live" ou "test" depuis le dashboard Duffel
const DUFFEL_BASE = 'https://api.duffel.com';

const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN || '';
const TP_MARKER = process.env.TRAVELPAYOUTS_MARKER || '';

// ---------- Duffel: recherche d'aéroports/villes (autocomplete) ----------
async function duffelResolveAirport(keyword) {
  if (!DUFFEL_TOKEN) return [];
  const url = DUFFEL_BASE + '/places/suggestions?query=' + encodeURIComponent(keyword);
  const r = await fetch(url, { headers: duffelHeaders() });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.data || [])
    .filter(x => x.iata_code)
    .map(x => ({ iata: x.iata_code, name: x.name, city: (x.city && x.city.name) || x.name, country: x.iata_country_code, type: x.type }));
}
function duffelHeaders() {
  return {
    Authorization: 'Bearer ' + DUFFEL_TOKEN,
    'Duffel-Version': 'v2',
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

// ---------- Duffel: recherche de vols en direct (offer requests) ----------
async function duffelSearchFlights({ origin, destination, date, returnDate, adults }) {
  if (!DUFFEL_TOKEN) return [];
  const slices = [{ origin, destination, departure_date: date }];
  if (returnDate) slices.push({ origin: destination, destination: origin, departure_date: returnDate });
  const body = {
    data: {
      slices,
      passengers: Array.from({ length: adults || 1 }, () => ({ type: 'adult' })),
      cabin_class: 'economy'
    }
  };
  const r = await fetch(DUFFEL_BASE + '/air/offer_requests?return_offers=true', {
    method: 'POST', headers: duffelHeaders(), body: JSON.stringify(body)
  });
  if (!r.ok) { console.error('Duffel search error', r.status, await r.text().catch(()=>'')); return []; }
  const d = await r.json();
  const offers = (d.data && d.data.offers) || [];
  return offers.slice(0, 15).map(o => {
    const slice = o.slices[0];
    const segs = slice.segments;
    const first = segs[0], last = segs[segs.length - 1];
    return {
      source: 'Duffel',
      airline: (o.owner && o.owner.name) || first.marketing_carrier_flight_number,
      stops: segs.length - 1,
      duration: slice.duration,
      date: first.departing_at.slice(0, 10),
      price: parseFloat(o.total_amount),
      currency: o.total_currency,
      depIata: first.origin.iata_code,
      depTime: first.departing_at,
      arrIata: last.destination.iata_code,
      arrTime: last.arriving_at
    };
  });
}

// ---------- Travelpayouts: prix les moins chers en cache (rapide, secours) ----------
async function travelpayoutsSearch({ origin, destination, date }) {
  if (!TP_TOKEN) return [];
  const month = (date || '').slice(0, 7); // l'API travaille par mois
  const url = 'https://api.travelpayouts.com/v1/prices/cheap?' + new URLSearchParams({
    origin, destination, depart_date: month, token: TP_TOKEN, currency: 'eur'
  });
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  const routes = (d.data && d.data[destination]) || {};
  return Object.values(routes).map(o => ({
    source: 'Travelpayouts',
    airline: o.airline,
    stops: 0,
    duration: null,
    date: (o.departure_at || '').slice(0, 10),
    price: o.price,
    currency: 'EUR',
    depIata: origin,
    depTime: o.departure_at,
    arrIata: destination,
    arrTime: o.return_at || null,
    bookLink: TP_MARKER ? `https://www.aviasales.com/search/${origin}${(o.departure_at||'').slice(8,10)}${(o.departure_at||'').slice(5,7)}${destination}1?marker=${TP_MARKER}` : undefined
  }));
}

const SERVER_VERSION = '2026-07-20-v3-citynames'; // change à chaque envoi pour vérifier le déploiement

// ---------- Endpoints ----------
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    flights: !!DUFFEL_TOKEN || !!TP_TOKEN,
    sources: { duffel: !!DUFFEL_TOKEN, travelpayouts: !!TP_TOKEN }
  });
});

// ---------- Résolution d'aéroports SANS clé : base publique Travelpayouts (gratuite, pas de token requis) ----------
let airportCache = null, airportCacheAt = 0;
async function loadAirportDB() {
  if (airportCache && Date.now() - airportCacheAt < 24 * 3600 * 1000) return airportCache;
  const r = await fetch('https://api.travelpayouts.com/data/en/airports.json');
  if (!r.ok) throw new Error('airports.json fetch failed: ' + r.status);
  airportCache = await r.json();
  airportCacheAt = Date.now();
  return airportCache;
}
let cityCache = null, cityCacheAt = 0;
async function loadCityDB() {
  if (cityCache && Date.now() - cityCacheAt < 24 * 3600 * 1000) return cityCache;
  const r = await fetch('https://api.travelpayouts.com/data/en/cities.json');
  if (!r.ok) throw new Error('cities.json fetch failed: ' + r.status);
  const list = await r.json();
  cityCache = {}; // index par code ville pour lookup rapide
  list.forEach(c => { cityCache[c.code] = c.name; });
  cityCacheAt = Date.now();
  return cityCache;
}
let countryCache = null, countryCacheAt = 0;
async function loadCountryDB() {
  if (countryCache && Date.now() - countryCacheAt < 24 * 3600 * 1000) return countryCache;
  const r = await fetch('https://api.travelpayouts.com/data/en/countries.json');
  if (!r.ok) throw new Error('countries.json fetch failed: ' + r.status);
  countryCache = await r.json();
  countryCacheAt = Date.now();
  return countryCache;
}
function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
async function freeResolveAirport(keyword) {
  const db = await loadAirportDB();
  const cities = await loadCityDB().catch(() => ({})); // pas bloquant si indispo
  const q = norm(keyword);
  const scored = [];
  for (const a of db) {
    if (a.iata_type && a.iata_type !== 'airport') continue; // ignore gares/bus si le champ existe
    const cityName = cities[a.city_code] || '';
    const name = norm(a.name), city = norm(cityName), code = norm(a.code);
    let score = -1;
    if (code === q) score = 100;
    else if (city === q) score = 95;
    else if (city.startsWith(q)) score = 90;
    else if (name.startsWith(q)) score = 80;
    else if (city.includes(q)) score = 60;
    else if (name.includes(q)) score = 50;
    if (score > 0) scored.push({ score, a, cityName });
  }
  // recherche par PAYS (ex: "Mali" -> tous les aéroports du Mali, capitale en premier)
  if (!scored.length || scored[0].score < 90) {
    try {
      const countries = await loadCountryDB();
      const match = countries.find(c => norm(c.name) === q || norm(c.name).startsWith(q));
      if (match) {
        const inCountry = db.filter(a => a.country_code === match.code);
        inCountry.slice(0, 8).forEach(a => scored.push({ score: 70, a, cityName: cities[a.city_code] || '' }));
      }
    } catch (e) { /* pas grave si indispo, on garde les résultats déjà trouvés */ }
  }
  scored.sort((x, y) => y.score - x.score);
  const seen = new Set();
  return scored.filter(({ a }) => !seen.has(a.code) && seen.add(a.code)).slice(0, 8).map(({ a, cityName }) => ({
    iata: a.code, name: a.name, city: cityName || a.name, country: a.country_code, type: 'AIRPORT'
  }));
}

app.get('/api/resolve-airport', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    let results = await freeResolveAirport(q); // toujours dispo, gratuit
    if (!results.length && DUFFEL_TOKEN) results = await duffelResolveAirport(q); // complément si Duffel configuré
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/search-flights', async (req, res) => {
  try {
    const { origin, destination, date, returnDate, adults, flexDays, useNearby } = req.body || {};
    if (!origin || !destination || !date) return res.status(400).json({ error: 'origin, destination et date sont requis' });

    // dates à tester (recherche flexible en option)
    const dates = [date];
    if (flexDays) {
      for (let i = 1; i <= flexDays; i++) {
        const d1 = new Date(date); d1.setDate(d1.getDate() + i); dates.push(d1.toISOString().slice(0, 10));
        const d2 = new Date(date); d2.setDate(d2.getDate() - i); dates.push(d2.toISOString().slice(0, 10));
      }
    }

    const sourcesUsed = new Set();
    let offers = [];

    // Duffel (live) — on limite à 3 dates pour rester rapide et limiter les coûts
    for (const d of dates.slice(0, 3)) {
      try {
        const r = await duffelSearchFlights({ origin, destination, date: d, returnDate, adults });
        if (r.length) sourcesUsed.add('Duffel');
        offers = offers.concat(r);
      } catch (e) { console.error('Duffel error', e.message); }
    }

    // Travelpayouts (cache, complément rapide)
    try {
      const r = await travelpayoutsSearch({ origin, destination, date });
      if (r.length) sourcesUsed.add('Travelpayouts');
      offers = offers.concat(r);
    } catch (e) { console.error('Travelpayouts error', e.message); }

    if (!offers.length) {
      return res.json({ count: 0, sources: [], note: 'Aucun vol trouvé pour ces critères (ou aucune source de données configurée sur le serveur).' });
    }

    offers.sort((a, b) => a.price - b.price);
    const cheapest = offers[0];
    // "meilleur rapport" = pas trop cher (< 130% du moins cher) et le moins d'escales / trajet le plus court
    const candidates = offers.filter(o => o.price <= cheapest.price * 1.3);
    const bestValue = candidates.sort((a, b) => (a.stops - b.stops) || (a.price - b.price))[0];
    cheapest._cheapest = true;
    if (bestValue && bestValue !== cheapest) bestValue._value = true;

    res.json({
      count: offers.length,
      sources: Array.from(sourcesUsed),
      searched: { dates },
      cheapest, bestValue,
      offers: offers.slice(0, 40)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('ML Fly flight server running on port ' + PORT));
