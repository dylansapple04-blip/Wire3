// netlify/functions/parcels.js
// Proxies a Regrid polygon parcel query so the REGRID_TOKEN never reaches the browser.
//
// Setup:
//   1. In Netlify: Site settings -> Environment variables -> add REGRID_TOKEN = <your key>
//   2. Deploy. The map calls this at /.netlify/functions/parcels
//
// Request (POST):  { "geojson": <GeoJSON Polygon geometry>, "limit": 1000 }
// Response:        { "count": N, "pins": [ { lat, lng, address, owner, use } ... ] }

exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "POST only" }) };

  const TOKEN = process.env.REGRID_TOKEN;
  if (!TOKEN)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "REGRID_TOKEN not set in Netlify env" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "bad JSON" }) }; }

  const geojson = body.geojson;
  const limit = Math.min(body.limit || 1000, 1000);
  if (!geojson)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "geojson required" }) };

  // Regrid v2 polygon query. Token as query param; geometry in the POST body.
  const url = "https://app.regrid.com/api/v2/parcels/query?token=" + encodeURIComponent(TOKEN);

  let data;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geojson, limit, return_zoning: false, return_buildings: false }),
    });
    if (!r.ok) {
      const text = await r.text();
      return { statusCode: r.status, headers: CORS, body: JSON.stringify({ error: "regrid " + r.status, detail: text.slice(0, 300) }) };
    }
    data = await r.json();
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "regrid fetch failed", detail: String(e) }) };
  }

  // Response shape can be { parcels: { features } } or { features } or { results }.
  const fc = data.parcels || data;
  const features = fc.features || data.results || [];

  const pins = [];
  for (const f of features) {
    const p = (f && f.properties) || {};
    const fields = p.fields || p;
    // address
    const address = p.headline || fields.address || fields.saddno && (fields.saddno + " " + (fields.saddstr || "")) || "(no address)";
    const owner = fields.owner || "";
    const use = fields.usedesc || fields.lbcs_activity_desc || "";
    // census block GEOID (15 digits) for competitor join, if Regrid provides it
    let block = fields.census_block || fields.census_blockgroup || fields.geoid || "";
    block = ("" + block).replace(/\D/g, "");
    if (block.length !== 15) block = ""; // only keep full block GEOIDs
    // point: prefer provided lat/lon, else centroid of geometry
    let lat = fields.lat, lng = fields.lon;
    if ((lat == null || lng == null) && f.geometry) {
      const c = centroid(f.geometry);
      if (c) { lat = c[1]; lng = c[0]; }
    }
    if (lat != null && lng != null) pins.push({ lat: +lat, lng: +lng, address, owner, use, block });
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ count: pins.length, pins }) };
};

// rough centroid of a (Multi)Polygon — average of outer-ring vertices
function centroid(geom) {
  let coords = null;
  if (geom.type === "Polygon") coords = geom.coordinates[0];
  else if (geom.type === "MultiPolygon") coords = geom.coordinates[0][0];
  else if (geom.type === "Point") return geom.coordinates;
  if (!coords || !coords.length) return null;
  let x = 0, y = 0;
  for (const pt of coords) { x += pt[0]; y += pt[1]; }
  return [x / coords.length, y / coords.length];
}
