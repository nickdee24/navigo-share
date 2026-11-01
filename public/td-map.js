// NaviGO's night map look for a Mapbox GL map (same colours as the app): navy-grey land, blue water,
// green parks, orange motorways (pale grey while a route is shown), blue-grey roads, red-and-white striped railways,
// building outlines, and no footpaths, cycle paths, steps or tracks. Use: TDMap.apply(map, routeShown)
'use strict';
window.TDMap = (function () {
  let map;
  // ---------- Truck Dash colours (same as the NaviGO app) ----------
  // Night colours from NaviGO's map (TruckDashMap.kt): navy-grey land, blue-grey roads, dark green parks
  const C = { LAND: '#272E3A', URBAN: '#272E3A', PARK: '#174A38', BUILDING: '#2D3E53', WATER: '#1C3550', RIVER: '#24456A', MINOR: '#3E5770',
    MAIN: '#4A6886', MOTORWAY: '#FF8A3D', MOTORWAY_ROUTE: '#E3E6EA', CASE: '#34495F', PATH: '#34475C', BORDER: '#575E68',
    TOWN: '#FFFFFF', ROADLABEL: '#A9C3DE', MINORLABEL: '#8FA9C4', WATERLABEL: '#5A9EC4', HALO: '#272E3A' };
  // parks, fields, woods, pitches etc. green; everything else plain ground
  const greenByClass = ['match', ['get', 'class'],
    ['park', 'grass', 'pitch', 'cemetery', 'wood', 'scrub', 'agriculture', 'crop', 'golf_course', 'garden', 'playground'], C.PARK, C.LAND];
  const isRoad = id => /^(road|bridge|tunnel)-/.test(id) && !/label|shield|number|exit/.test(id);
  const isMotorway = id => /motorway|trunk/.test(id);
  const byClass = route => ['match', ['get', 'class'],
    ['motorway', 'motorway_link', 'trunk', 'trunk_link'], route ? C.MOTORWAY_ROUTE : C.MOTORWAY,
    ['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'], C.MAIN,
    ['major_rail', 'minor_rail', 'service_rail'], '#E02424',
    ['path', 'pedestrian', 'track'], 'rgba(0,0,0,0)', C.MINOR];
  function paint(id, prop, v) { try { map.setPaintProperty(id, prop, v); } catch (e) { /* layer doesn't have it */ } }
  function apply(m, routeShown) {
    map = m;
    for (const l of map.getStyle().layers) {
      const id = l.id;
      if (id.startsWith('nv-')) continue;
      if (id.endsWith('-bg') && id.startsWith('admin')) continue;
      // building outlines shown (like the app); footpaths, cycle paths, steps and tracks are hidden (railways stay, striped)
      if (l.type === 'fill' && id.includes('building')) { try { map.setLayoutProperty(id, 'visibility', 'visible'); } catch (e) {} paint(id, 'fill-color', C.BUILDING); continue; }
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
        if (id.includes('water')) paint(id, 'line-color', C.RIVER);
        else if (id.startsWith('admin')) paint(id, 'line-color', C.BORDER);
        else if (isRoad(id) && id.includes('case')) paint(id, 'line-color', C.CASE);
        else if (isRoad(id) && isMotorway(id)) paint(id, 'line-color', routeShown ? C.MOTORWAY_ROUTE : C.MOTORWAY);
        else if (isRoad(id) && /primary|secondary|tertiary|major/.test(id)) paint(id, 'line-color', C.MAIN);
        else if (isRoad(id) && /rail/.test(id)) { paint(id, 'line-color', '#E02424'); paint(id, 'line-opacity', 1); stripes(l); }
        else if (isRoad(id) && /path|pedestrian|steps|track/.test(id)) paint(id, 'line-color', C.PATH);
        else if (isRoad(id)) paint(id, 'line-color', byClass(routeShown));
      } else if (l.type === 'symbol') {
        const c = /settlement|place|country|state/.test(id) ? C.TOWN : /water/.test(id) ? C.WATERLABEL : /road/.test(id) ? C.ROADLABEL : C.MINORLABEL;
        paint(id, 'text-color', c); paint(id, 'text-halo-color', C.HALO);
      }
    }
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

  return { apply };
})();
