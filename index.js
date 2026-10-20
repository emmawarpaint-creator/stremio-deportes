/**
 * @file        index.js
 * @description Addon de Stremio para ver canales de deportes en vivo.
 *              Sirve los canales definidos en streams.json (repo de GitHub).
 *              Catálogos separados por liga y soporte para tres tipos de stream:
 *                - url          → video directo (.m3u8 / .mpd / .mp4)
 *                - ytId         → video de YouTube (ID del video)
 *                - externalUrl  → abre un enlace externo (sitio o app oficial)
 * @usage       Vercel serverless. Desarrollo local: node index.js
 */

'use strict';

const express = require('express');

const app = express();

// ─── Configuración ────────────────────────────────────────────────────────────

/** URL del streams.json en GitHub. Se sobreescribe con la variable STREAMS_JSON_URL en Vercel. */
const STREAMS_JSON_URL = process.env.STREAMS_JSON_URL || '';

/** TTL del caché en memoria — 5 minutos */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Catálogos del addon.
 * La clave es el id del catálogo; el valor es el género que se filtra en streams.json
 * (null = muestra todos los canales).
 * Para cambiar o agregar ligas, edita aquí Y en MANIFEST.catalogs.
 */
const CATALOG_GENRES = {
  'deportes-live':      null,
  'deportes-champions': 'Champions League',
  'deportes-liga-mx':   'Liga MX',
  'deportes-premier':   'Premier League'
};

// ─── Caché de canales ─────────────────────────────────────────────────────────

let _channelsCache  = null;
let _cacheTimestamp = 0;

/**
 * Obtiene los canales desde GitHub con caché de 5 minutos.
 * Si el fetch falla, devuelve el caché anterior.
 * @returns {Promise<Array>}
 */
async function getChannels() {
  const now = Date.now();
  if (_channelsCache && (now - _cacheTimestamp) < CACHE_TTL_MS) return _channelsCache;

  try {
    const res = await fetch(`${STREAMS_JSON_URL}?_=${now}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data      = await res.json();
    _channelsCache  = data.channels || [];
    _cacheTimestamp = now;
    console.log(`[streams] ${_channelsCache.length} canales cargados`);
    return _channelsCache;
  } catch (err) {
    console.error('[streams] Error:', err.message);
    return _channelsCache || [];
  }
}

// ─── Helper de respuesta ──────────────────────────────────────────────────────

/**
 * Responde con JSON, headers CORS y Cache-Control.
 * @param {object} res
 * @param {object} data
 * @param {number} maxAgeSeconds - 0 = no-store
 */
function respond(res, data, maxAgeSeconds = 300) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader(
    'Cache-Control',
    maxAgeSeconds > 0
      ? `public, max-age=${maxAgeSeconds}, stale-while-revalidate=60`
      : 'no-store'
  );
  return res.json(data);
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

const MANIFEST = {
  id:          'stremio.deportes',
  version:     '1.1.0',
  name:        'Deportes en Vivo',
  description: 'Canales de deportes en vivo: Champions League, Liga MX y Premier League.',
  types:       ['tv'],
  catalogs: [
    { type: 'tv', id: 'deportes-live',      name: 'Deportes en Vivo (todos)',
      extra: [{ name: 'genre', isRequired: false }, { name: 'search', isRequired: false }] },
    { type: 'tv', id: 'deportes-champions', name: 'Champions League',
      extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'deportes-liga-mx',   name: 'Liga MX',
      extra: [{ name: 'search', isRequired: false }] },
    { type: 'tv', id: 'deportes-premier',   name: 'Premier League',
      extra: [{ name: 'search', isRequired: false }] }
  ],
  resources: [
    { name: 'catalog', types: ['tv'] },
    { name: 'meta',    types: ['tv'], idPrefixes: ['deportes-'] },
    { name: 'stream',  types: ['tv'], idPrefixes: ['deportes-'] }
  ],
  behaviorHints: { configurable: false }
};

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.get('/manifest.json', (_, res) => respond(res, MANIFEST, 3600));

/**
 * Construye el objeto meta de Stremio a partir de un canal.
 * @param {object} ch
 * @returns {object}
 */
function buildMeta(ch) {
  return {
    id:          `deportes-${ch.id}`,
    type:        'tv',
    name:        ch.name,
    poster:      ch.logo        || '',
    logo:        ch.logo        || '',
    background:  ch.background  || '',
    description: ch.description || '',
    genres:      ch.genres      || []
  };
}

/**
 * Responde un catálogo aplicando el filtro de su liga y los extras opcionales.
 * @param {object} res
 * @param {string} catalogId
 * @param {object} extra - { genre?, search? }
 */
async function sendCatalog(res, catalogId, extra = {}) {
  if (!(catalogId in CATALOG_GENRES)) return respond(res, { metas: [] });

  let channels = await getChannels();

  const catalogGenre = CATALOG_GENRES[catalogId];
  if (catalogGenre) {
    channels = channels.filter(ch => (ch.genres || []).includes(catalogGenre));
  }
  if (extra.genre) {
    channels = channels.filter(ch => (ch.genres || []).includes(extra.genre));
  }
  if (extra.search) {
    const q = extra.search.toLowerCase();
    channels = channels.filter(ch =>
      (ch.name || '').toLowerCase().includes(q) ||
      (ch.description || '').toLowerCase().includes(q)
    );
  }

  respond(res, { metas: channels.map(buildMeta) });
}

// Catálogo sin extras
app.get('/catalog/tv/:catalogId.json', (req, res) =>
  sendCatalog(res, req.params.catalogId)
);

// Catálogo con extras (genre=..., search=..., skip=...)
app.get('/catalog/tv/:catalogId/:extra.json', (req, res) => {
  const extra = Object.fromEntries(new URLSearchParams(req.params.extra));
  sendCatalog(res, req.params.catalogId, extra);
});

// Meta individual
app.get('/meta/tv/:id.json', async (req, res) => {
  const channels = await getChannels();
  const ch = channels.find(c => c.id === req.params.id.replace(/^deportes-/, ''));
  if (!ch) return res.status(404).json({ err: 'no encontrado' });
  respond(res, { meta: buildMeta(ch) }, 300);
});

/**
 * Streams de un canal — sin caché HTTP.
 * Cada entrada de streams[] puede tener UNO de estos campos:
 *   url          → video directo
 *   ytId         → ID de un video de YouTube
 *   externalUrl  → enlace que se abre fuera de Stremio
 * Las entradas con los tres campos vacíos se ignoran.
 */
app.get('/stream/tv/:id.json', async (req, res) => {
  const channels = await getChannels();
  const ch = channels.find(c => c.id === req.params.id.replace(/^deportes-/, ''));

  if (!ch) return respond(res, { streams: [] }, 0);

  const streams = (ch.streams || [])
    .filter(s => s.url || s.ytId || s.externalUrl)
    .map(s => {
      const stream = { title: s.label || ch.name };

      if (s.url) {
        stream.url = s.url;
        const hasHeaders = s.headers && typeof s.headers === 'object';
        // Stremio exige notWebReady: true cuando se usan proxyHeaders
        stream.behaviorHints = { notWebReady: hasHeaders ? true : false };
        if (hasHeaders) {
          stream.behaviorHints.proxyHeaders = { request: s.headers };
        }
      } else if (s.ytId) {
        stream.ytId = s.ytId;
      } else {
        stream.externalUrl = s.externalUrl;
      }

      return stream;
    });

  respond(res, { streams }, 0);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

/** Exportar para Vercel (serverless handler) */
module.exports = (req, res) => app(req, res);

/** Arranque local: node index.js */
if (require.main === module) {
  const PORT = process.env.PORT || 7001;
  app.listen(PORT, () => console.log(`\n🟢 Addon en http://localhost:${PORT}/manifest.json\n`));
}
