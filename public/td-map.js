// NaviGO's night map look for a Mapbox GL map (same colours as the app): navy-grey land, blue water,
// green parks, Waze steel-blue motorways with one-way arrows, blue-grey roads, red-and-white striped railways,
// buildings lighter only for businesses/schools/shops, and no footpaths, cycle paths, steps or tracks. Use: TDMap.apply(map, routeShown)
'use strict';
window.TDMap = (function () {
  let map;
  // ---------- Truck Dash colours (same as the NaviGO app) ----------
  // Night colours from NaviGO's map (TruckDashMap.kt): navy-grey land, blue-grey roads, dark green parks
  // Waze night colours (Nick's colour spec, 23 Nov): midnight navy land, slate highways, steel streets, navy water
  const C = { LAND: '#121722', URBAN: '#121722', PARK: '#132624', BUILDING: '#1B2333', WATER: '#0C2238', RIVER: '#0C2238', MINOR: '#1E2636',
    MAIN: '#253043', MOTORWAY: '#2A3447', MOTORWAY_ROUTE: '#2A3447', CASE: '#0F141E', PATH: '#1A202C', BORDER: '#3A4456',
    TOWN: '#CBD5E1', ROADLABEL: '#94A3B8', MINORLABEL: '#94A3B8', WATERLABEL: '#4A7FA8', HALO: '#0F172A' };
  // parks, fields, woods, pitches etc. green; everything else plain ground
  const greenByClass = ['match', ['get', 'class'],
    ['park', 'grass', 'pitch', 'cemetery', 'wood', 'scrub', 'agriculture', 'crop', 'golf_course', 'garden', 'playground'], C.PARK, C.LAND];
  // only businesses, schools, shops etc. get the lighter building colour; houses are the same as the ground (like Waze)
  const BIZ = ['commercial', 'retail', 'industrial', 'office', 'warehouse', 'supermarket', 'school', 'college', 'university', 'kindergarten',
    'hospital', 'church', 'chapel', 'mosque', 'public', 'civic', 'government', 'hotel', 'train_station', 'transportation', 'sports_centre',
    'sports_hall', 'stadium', 'manufacture', 'factory', 'fire_station', 'police', 'library', 'museum', 'shop', 'store'];
  const buildingByType = ['match', ['get', 'type'], BIZ, C.BUILDING, C.LAND];
  const isRoad = id => /^(road|bridge|tunnel)-/.test(id) && !/label|shield|number|exit/.test(id);
  const isMotorway = id => /motorway|trunk/.test(id);
  const byClass = route => ['match', ['get', 'class'],
    ['motorway', 'motorway_link', 'trunk', 'trunk_link'], route ? C.MOTORWAY_ROUTE : C.MOTORWAY,
    ['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'], C.MAIN,
    ['major_rail', 'minor_rail', 'service_rail'], '#E02424',
    ['path', 'pedestrian', 'track'], 'rgba(0,0,0,0)', C.MINOR];
  // Fat Waze-style roads (same as the app): thin zoomed out, wide and chunky close in
  function wazeWidth(id) {
    const w = isMotorway(id) ? [2.5, 6.5, 20, 52] : /primary|secondary|tertiary|major/.test(id) ? [2, 5.5, 17, 46] : [0.8, 2.8, 11, 34];
    const k = id.includes('case') ? 1.15 : 1;
    return ['interpolate', ['exponential', 1.5], ['zoom'], 12, w[0] * k, 14, w[1] * k, 16, w[2] * k, 18, w[3] * k];
  }
  function paint(id, prop, v) { try { map.setPaintProperty(id, prop, v); } catch (e) { /* layer doesn't have it */ } }
  function apply(m, routeShown) {
    map = m;
    for (const l of map.getStyle().layers) {
      const id = l.id;
      if (id.startsWith('nv-')) continue;
      if (/oneway/.test(id)) { try { map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {} continue; }
      if (id.endsWith('-bg') && id.startsWith('admin')) continue;
      // building outlines shown (like the app); footpaths, cycle paths, steps and tracks are hidden (railways stay, striped)
      if (l.type === 'fill' && id.includes('building')) { try { map.setLayoutProperty(id, 'visibility', 'visible'); } catch (e) {} paint(id, 'fill-color', buildingByType); paint(id, 'fill-outline-color', buildingByType); continue; }
      if (id.includes('building') || /path|steps|pedestrian|track|cycleway|piste|ferry|aerialway|golf|transit/.test(id) || /rail/.test(id) && /label/.test(id)) {
        try { map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {} continue; }
      if (l.type === 'background') paint(id, 'background-color', C.LAND);
      else if (l.type === 'fill') {
        if (id === 'land') paint(id, 'fill-color', C.LAND);
        else if (id.includes('water')) paint(id, 'fill-color', C.WATER);
        else if (id.includes('park')) paint(id, 'fill-color', C.PARK);
        else if (/landuse|landcover/.test(id)) { paint(id, 'fill-color', greenByClass); paint(id, 'fill-opacity', 1); }
        else if (/aeroway|structure|pitch/.test(id) || /^(road|bridge|tunnel)-/.test(id)) paint(id, 'fill-color', C.URBAN);
      } else if (l.type === 'line') {
        if (isRoad(id) && !/rail|path|pedestrian|steps|track/.test(id)) paint(id, 'line-width', wazeWidth(id));
        if (id.includes('water')) paint(id, 'line-color', C.RIVER);
        else if (id.startsWith('admin')) paint(id, 'line-color', C.BORDER);
        else if (isRoad(id) && id.includes('case')) { paint(id, 'line-color', C.CASE); paint(id, 'line-opacity', 1); }
        else if (isRoad(id) && isMotorway(id)) { paint(id, 'line-opacity', 1); paint(id, 'line-color', routeShown ? C.MOTORWAY_ROUTE : C.MOTORWAY); }
        else if (isRoad(id) && /primary|secondary|tertiary|major/.test(id)) paint(id, 'line-color', C.MAIN);
        else if (isRoad(id) && /rail/.test(id)) { paint(id, 'line-color', '#E02424'); paint(id, 'line-opacity', 1); stripes(l); }
        else if (isRoad(id) && /path|pedestrian|steps|track/.test(id)) paint(id, 'line-color', C.PATH);
        else if (isRoad(id)) { paint(id, 'line-opacity', 1); paint(id, 'line-color', byClass(routeShown)); }
      } else if (l.type === 'symbol') {
        const c = /settlement|place|country|state/.test(id) ? C.TOWN : /water/.test(id) ? C.WATERLABEL : /road/.test(id) ? C.ROADLABEL : C.MINORLABEL;
        paint(id, 'text-color', c); paint(id, 'text-halo-color', C.HALO);
      }
    }
    onewayArrows();
  }

  // One-way arrows like Waze: small chevrons along one-way roads from zoom 15, pale blue on motorways, darker blue elsewhere.
  function onewayArrows() {
    if (map.getLayer('nv-oneway')) return;
    try {
      if (!map.hasImage('nv-oneway')) {
        const n = 32, cv = document.createElement('canvas'); cv.width = cv.height = n;
        const g = cv.getContext('2d'); g.strokeStyle = '#fff'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(10, 7); g.lineTo(22, 16); g.lineTo(10, 25); g.stroke();
        map.addImage('nv-oneway', g.getImageData(0, 0, n, n), { sdf: true });
      }
      const src = map.getStyle().layers.find(l => l['source-layer'] === 'road');
      if (!src) return;
      const before = map.getStyle().layers.find(l => l.type === 'symbol' && /label|shield/.test(l.id));
      map.addLayer({ id: 'nv-oneway', type: 'symbol', source: src.source, 'source-layer': 'road', minzoom: 15,
        filter: ['==', ['get', 'oneway'], 'true'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 120, 'icon-image': 'nv-oneway', 'icon-size': 0.5,
          'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
        paint: { 'icon-color': ['match', ['get', 'class'], ['motorway', 'motorway_link', 'trunk', 'trunk_link'], '#B5E7FF', '#6A8DB3'] } },
        before ? before.id : undefined);
    } catch (e) { console.warn('oneway', e.message); }
  }

  // Railways: red with white stripes on top (like a level-crossing barrier), drawn above the red line.
  function stripes(l) {
    const id = 'nv-stripe-' + l.id;
    if (map.getLayer(id)) return;
    const def = { id, type: 'line', source: l.source, 'source-layer': l['source-layer'], minzoom: l.minzoom || 0,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#FFFFFF', 'line-dasharray': [1.2, 1.2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 15, 2.2, 18, 4] } };
    if (l.filter) def.filter = l.filter;
    try { map.addLayer(def, nextLayerAfter(l.id)); } catch (e) { console.warn('stripes', e.message); }
    paint(l.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 12, 1.6, 15, 3.2, 18, 6]);
  }
  function nextLayerAfter(id) { const ls = map.getStyle().layers; const i = ls.findIndex(x => x.id === id); return ls[i + 1] ? ls[i + 1].id : undefined; }

  // Live traffic like Waze (same as the app): moderate orange, heavy red, standstill dark red, each direction on its own
  // side of the road, with darker stripes sliding along the way the traffic is going.
  const TW = ['interpolate', ['exponential', 1.5], ['zoom'], 9, 1, 12, 1.4, 14, 3.2, 16, 9, 18, 24];
  const TS = ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1, 14, 2.2, 16, 6, 18, 16];
  const TO = ['interpolate', ['exponential', 1.5], ['zoom'], 9, -0.5, 12, -0.8, 14, -1.8, 16, -5, 18, -13];
  const DASH = 1.6, LEN = 4, STEPS = 24;
  function dash(step) {
    const sh = LEN * (step % STEPS) / STEPS;
    if (sh + DASH <= LEN) return [0, sh, DASH, LEN - sh - DASH];
    const d1 = sh + DASH - LEN; return [d1, sh - d1, LEN - sh, 0];
  }
  let trafficTimer = null;
  function traffic(m, before) {
    map = m;
    try {
      if (!map.getSource('nv-traffic')) map.addSource('nv-traffic', { type: 'vector', url: 'mapbox://mapbox.mapbox-traffic-v1' });
      if (!map.getLayer('nv-traffic')) map.addLayer({ id: 'nv-traffic', type: 'line', source: 'nv-traffic', 'source-layer': 'traffic', minzoom: 8,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'congestion'], 'moderate', '#FFB74D', 'heavy', '#FF5252', 'severe', '#B71C1C', 'rgba(0,0,0,0)'],
          'line-width': TW, 'line-offset': TO, 'line-opacity': 0.95 } }, before);
      if (!map.getLayer('nv-traffic-anim')) map.addLayer({ id: 'nv-traffic-anim', type: 'line', source: 'nv-traffic', 'source-layer': 'traffic', minzoom: 12,
        filter: ['match', ['get', 'congestion'], ['moderate', 'heavy', 'severe'], true, false],
        paint: { 'line-color': ['match', ['get', 'congestion'], 'moderate', '#804900', 'heavy', '#7F0000', 'severe', '#3E0000', 'rgba(0,0,0,0)'],
          'line-width': TS, 'line-offset': TO, 'line-opacity': 0.85, 'line-dasharray': dash(0) } }, before);
    } catch (e) { console.warn('traffic', e.message); return; }
    if (trafficTimer) return;
    let step = 0;
    trafficTimer = setInterval(() => {
      if (document.hidden || !map.getLayer('nv-traffic-anim') || map.getZoom() < 12) return;
      step = (step + 1) % STEPS;
      try { map.setPaintProperty('nv-traffic-anim', 'line-dasharray', dash(step)); } catch (e) {}
    }, 80);
  }

  return { apply, traffic };
})();
