import './style.css'
import { fromArrayBuffer } from 'geotiff';
import * as turf from '@turf/turf';

const streetViewContainer = document.getElementById('streetview');
const heatLabel = document.getElementById('heat-index');
const treeCanopyLabel = document.getElementById('tree-canopy');
const imperviousLabel = document.getElementById('impervious');
const hwRatioLabel = document.getElementById('hw-ratio');
const heatHazardLabel = document.getElementById('heat-hazard');
const heatHazardWindow = document.getElementById('heat-hazard-window');
const sunImage = document.getElementById('sun-img');
const walkerImage = document.getElementById('walker-img');
const statusWindow = document.getElementById('status-window');

const FILES = {
  raster: '/data/t1aggEBKlogHI.tif',
  bounds: '/data/t1Poly.geojson',
  stats: '/data/t1agg.geojson',
  start: '/data/startPt.geojson',
};

const transectOrigin = { lat: 35.2271, lng: -80.8371 };

let boundsPolygon = null;
let statsFeatures = [];
let heatImage = null;
let heatWidth = 0;
let heatHeight = 0;
let heatOrigin = null;
let heatResolution = null;
let heatNoData = null;

let playerLocation = { lat: transectOrigin.lat, lng: transectOrigin.lng };
let heading = 0;
let pitch = 0;
let panorama = null;
let streetViewService = null;
let mapOverlay = null;
let dataLayer = null;
let mapMarker = null;
let boundsOverlayReady = false;
let heatSampleInFlight = false;
let startLocation = { lat: transectOrigin.lat, lng: transectOrigin.lng };
let startPoint = { lat: transectOrigin.lat, lng: transectOrigin.lng };
let navigationStarted = false;

function logError(message) {
  console.error(message);
  setStatus(`Error: ${message}`, true);
}

function setStatus(message, isError = false) {
  if (!statusWindow) {
    return;
  }
  statusWindow.textContent = message;
  statusWindow.style.background = isError ? 'rgba(255, 220, 220, 0.95)' : 'rgba(255, 250, 220, 0.95)';
}

async function loadGeoJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load GeoJSON: ${url} (status ${response.status})`);
  }
  return response.json();
}

function mercatorToLngLat(coord) {
  const [x, y] = coord;
  const R = 6378137;
  const lng = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lng, lat];
}

function lngLatToMercator(lng, lat) {
  const R = 6378137;
  const x = (lng * Math.PI / 180) * R;
  const y = Math.log(Math.tan((lat * Math.PI / 180 + Math.PI / 2) / 2)) * R;
  return [x, y];
}

function convertCoords(coord) {
  if (!Array.isArray(coord)) {
    return coord;
  }

  if (typeof coord[0] === 'number' && coord.length >= 2) {
    return mercatorToLngLat(coord);
  }

  return coord.map(convertCoords);
}

function convertGeoJSONToWgs84(geojson) {
  if (!geojson) {
    return geojson;
  }

  if (geojson.type === 'FeatureCollection') {
    return {
      ...geojson,
      features: geojson.features.map(convertGeoJSONToWgs84),
    };
  }

  if (geojson.type === 'Feature') {
    return {
      ...geojson,
      geometry: convertGeoJSONToWgs84(geojson.geometry),
    };
  }

  if (geojson.coordinates) {
    return {
      ...geojson,
      coordinates: convertCoords(geojson.coordinates),
    };
  }

  return geojson;
}

async function loadBounds() {
  const geojson = await loadGeoJSON(FILES.bounds);
  const converted = convertGeoJSONToWgs84(geojson);
  if (converted.type === 'FeatureCollection' && Array.isArray(converted.features) && converted.features.length === 1) {
    boundsPolygon = converted.features[0];
  } else {
    boundsPolygon = converted;
  }
}

async function loadStatsData() {
  const geojson = await loadGeoJSON(FILES.stats);
  const converted = convertGeoJSONToWgs84(geojson);
  statsFeatures = converted.features || [];
}

async function loadHeatRaster() {
  const response = await fetch(FILES.raster);
  if (!response.ok) {
    throw new Error(`Unable to load raster: ${FILES.raster}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  heatImage = image;
  heatWidth = image.getWidth();
  heatHeight = image.getHeight();
  heatOrigin = image.getOrigin();
  heatResolution = image.getResolution();
  heatNoData = image.getGDALNoData();
}

async function loadStartPoint() {
  const geojson = await loadGeoJSON(FILES.start);
  const feature = geojson.features?.[0];
  if (!feature || feature.geometry?.type !== 'Point') {
    throw new Error('Invalid start point GeoJSON');
  }

  const [lng, lat] = feature.geometry.coordinates;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    const [convertedLng, convertedLat] = mercatorToLngLat([lng, lat]);
    startPoint = { lat: convertedLat, lng: convertedLng };
  } else {
    startPoint = { lat, lng };
  }
}

function getPixelFromLatLng(lat, lng) {
  if (!heatImage || !heatWidth || !heatHeight) {
    return null;
  }

  const [mercX, mercY] = lngLatToMercator(lng, lat);
  let px;
  let py;

  if (typeof heatImage.getBoundingBox === 'function') {
    const [minX, minY, maxX, maxY] = heatImage.getBoundingBox();
    const pixelWidth = (maxX - minX) / heatWidth;
    const pixelHeight = (maxY - minY) / heatHeight;

    px = (mercX - minX) / pixelWidth;
    py = (maxY - mercY) / pixelHeight;
  } else if (heatOrigin && heatResolution) {
    const [originX, originY] = heatOrigin;
    const [resX, resY] = heatResolution;

    px = (mercX - originX) / resX;
    py = (originY - mercY) / Math.abs(resY);
  } else {
    return null;
  }

  if (Number.isNaN(px) || Number.isNaN(py)) {
    return null;
  }

  if (px < 0 || px >= heatWidth || py < 0 || py >= heatHeight) {
    return null;
  }

  return {
    x: Math.floor(px),
    y: Math.floor(py),
  };
}

async function sampleHeatIndex(lat, lng) {
  if (!heatImage) {
    return null;
  }

  const pixel = getPixelFromLatLng(lat, lng);
  if (!pixel) {
    return null;
  }

  const { x, y } = pixel;
  if (x < 0 || x >= heatWidth || y < 0 || y >= heatHeight) {
    return null;
  }

  const window = [x, y, x + 1, y + 1];
  const raster = await heatImage.readRasters({ window });
  const band = raster[0];
  const value = band && band[0] != null ? band[0] : null;

  if (value === heatNoData || Number.isNaN(value) || value == null) {
    return null;
  }

  return value;
}

function pointInsideBounds(lat, lng) {
  if (!boundsPolygon) {
    return true;
  }

  const pt = turf.point([lng, lat]);
  return turf.booleanPointInPolygon(pt, boundsPolygon);
}

function getNearestStatsFeature(lat, lng) {
  if (!statsFeatures.length) {
    return null;
  }

  const currentPoint = turf.point([lng, lat]);
  let nearest = null;
  let bestDistance = Infinity;

  for (const feature of statsFeatures) {
    let dist = Infinity;
    const geometryType = feature.geometry.type;

    if (geometryType === 'Point') {
      dist = turf.distance(currentPoint, turf.point(feature.geometry.coordinates), { units: 'kilometers' });
    } else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
      const linePoint = turf.nearestPointOnLine(feature, currentPoint);
      dist = turf.distance(currentPoint, linePoint, { units: 'kilometers' });
    } else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
      const polygonLine = turf.polygonToLine(feature);
      const nearestPoint = turf.nearestPointOnLine(polygonLine, currentPoint);
      dist = turf.distance(currentPoint, nearestPoint, { units: 'kilometers' });
    }

    if (dist < bestDistance) {
      bestDistance = dist;
      nearest = feature;
    }
  }

  return nearest;
}

function updateHUDValues(statsFeature) {
  const canopy = statsFeature?.properties?.pctCanopy;
  const imperv = statsFeature?.properties?.pctImperv;
  const hwRatio = statsFeature?.properties?.hwRatio;

  treeCanopyLabel.textContent = canopy != null ? (canopy * 100).toFixed(1) : 'Unknown';
  imperviousLabel.textContent = imperv != null ? (imperv * 100).toFixed(1) : 'Unknown';
  hwRatioLabel.textContent = hwRatio != null ? hwRatio.toFixed(2) : 'Unknown';
}

function updateMiniMapMarker() {
  if (!mapMarker) {
    return;
  }
  mapMarker.setPosition(playerLocation);
  if (mapOverlay) {
    mapOverlay.panTo(playerLocation);
  }
}

function getHeatHazard(celsius) {
  if (celsius == null || Number.isNaN(celsius)) {
    return {
      text: 'No Data',
      level: 'no-data',
    };
  }

  if (celsius >= 54) {
    return {
      text: 'Extreme Danger — Heat stroke or sunstroke likely.',
      level: 'extreme-danger',
    };
  }
  if (celsius >= 41) {
    return {
      text: 'Danger — Sunstroke possible with prolonged exposure and/or physical activity.',
      level: 'danger',
    };
  }
  if (celsius >= 32) {
    return {
      text: 'Extreme Caution — Sunstroke, muscle cramps, and/or heat exhaustion possible with prolonged exposure and/or physical activity.',
      level: 'extreme-caution',
    };
  }
  if (celsius >= 27) {
    return {
      text: 'Caution — Fatigue possible with prolonged exposure and/or physical activity.',
      level: 'caution',
    };
  }

  return {
    text: 'Little to no risk.',
    level: 'low-risk',
  };
}

async function refreshHeatIndex() {
  if (heatSampleInFlight) {
    return;
  }
  if (!heatImage) {
    heatLabel.textContent = 'Waiting...';
    heatHazardLabel.textContent = 'Waiting...';
    return;
  }

  heatSampleInFlight = true;
  const heatValue = await sampleHeatIndex(playerLocation.lat, playerLocation.lng);
  if (heatValue != null) {
    const celsius = Number(heatValue);
    const displayedCelsius = Number(celsius.toFixed(1));
    const fahrenheit = (displayedCelsius * 9) / 5 + 32;
    heatLabel.textContent = `${displayedCelsius.toFixed(1)}°C/${fahrenheit.toFixed(1)}°F`;
    const hazard = getHeatHazard(displayedCelsius);
    heatHazardLabel.textContent = hazard.text;
    if (heatHazardWindow) {
      let className = hazard.level;
      if (hazard.level === 'low-risk') {
        className += ' brisk';
      } else if (hazard.level === 'caution') {
        className += ' moderate-sweat';
      } else if (hazard.level === 'extreme-caution') {
        className += ' strong-sweat';
      } else if (hazard.level === 'danger' || hazard.level === 'extreme-danger') {
        className += ' heavy-sweat';
      }
      heatHazardWindow.className = `heat-hazard-window ${className}`;
    }

    if (sunImage && walkerImage) {
      const normalSun = '/data/Sun_Normal.png';
      const normalWalker = '/data/Normal.png';
      const hotSun = '/data/Sun_Hot.png';
      const hotWalker = '/data/Hot.png';

      if (hazard.level === 'low-risk') {
        sunImage.src = normalSun;
        walkerImage.src = normalWalker;
      } else {
        sunImage.src = hotSun;
        walkerImage.src = hotWalker;
      }
    }
  } else {
    heatLabel.textContent = 'No Data';
    heatHazardLabel.textContent = 'No Data';
    if (heatHazardWindow) {
      heatHazardWindow.className = 'heat-hazard-window no-data';
    }
  }
  heatSampleInFlight = false;
}

function hideStatusWindow() {
  if (statusWindow) {
    statusWindow.style.display = 'none';
  }
}

function updateInfo() {
  const statsFeature = getNearestStatsFeature(playerLocation.lat, playerLocation.lng);
  updateHUDValues(statsFeature);
  updateMiniMapMarker();
  refreshHeatIndex().catch((error) => logError(error));
}

function setPanoramaPosition(lat, lng) {
  if (!panorama) {
    return;
  }
  panorama.setPosition({ lat, lng });
}

function bindPanoramaEvents() {
  if (!panorama) {
    return;
  }

  panorama.addListener('position_changed', () => {
    const pos = panorama.getPosition();
    if (pos) {
      playerLocation = pos.toJSON();
      updateInfo();
    }
  });

  panorama.addListener('pov_changed', () => {
    const pov = panorama.getPov();
    if (pov) {
      heading = pov.heading;
      pitch = pov.pitch;
    }
  });
}

function initializeStreetView() {
  const startPos = { lat: playerLocation.lat, lng: playerLocation.lng };

  panorama = new google.maps.StreetViewPanorama(streetViewContainer, {
    position: startPos,
    pov: {
      heading,
      pitch,
    },
    zoom: 1,
    enableCloseButton: false,
    addressControl: false,
    linksControl: false,
    panControl: false,
    motionTracking: false,
  });

  panorama.setOptions({ scrollwheel: false });
  bindPanoramaEvents();
}

async function findNearestStreetView(lat, lng, radii = [1500, 3000, 5000]) {
  if (!streetViewService) {
    throw new Error('Street View service is not initialized');
  }

  for (const radius of radii) {
    const panoLocation = await new Promise((resolve, reject) => {
      streetViewService.getPanorama(
        { location: { lat, lng }, radius, source: google.maps.StreetViewSource.DEFAULT },
        (data, status) => {
          if (status === google.maps.StreetViewStatus.OK) {
            resolve(data.location.latLng.toJSON());
          } else {
            reject(new Error(status));
          }
        }
      );
    }).catch(() => null);

    if (panoLocation) {
      return panoLocation;
    }
  }

  throw new Error('No Street View panorama found within supported radii');
}

async function findNearestStreetViewInBounds(lat, lng, radii = [1500, 3000, 5000]) {
  const candidate = await findNearestStreetView(lat, lng, radii);
  if (pointInsideBounds(candidate.lat, candidate.lng)) {
    return candidate;
  }

  if (!boundsPolygon) {
    return candidate;
  }

  const boundaryCoords = turf.coordAll(turf.polygonToLine(boundsPolygon));
  const candidates = [startPoint];

  for (let i = 0; i < boundaryCoords.length; i += Math.max(1, Math.floor(boundaryCoords.length / 8))) {
    const [lngBoundary, latBoundary] = boundaryCoords[i];
    candidates.push({ lat: latBoundary, lng: lngBoundary });
  }

  for (const point of candidates) {
    const pano = await findNearestStreetView(point.lat, point.lng, radii).catch(() => null);
    if (pano && pointInsideBounds(pano.lat, pano.lng)) {
      return pano;
    }
  }

  return candidate;
}

function initializeMiniMap() {
  mapOverlay = new google.maps.Map(document.getElementById('map-container'), {
    center: transectOrigin,
    zoom: 17,
    mapTypeId: 'satellite',
    disableDefaultUI: true,
    gestureHandling: 'none',
  });

  dataLayer = new google.maps.Data({ map: mapOverlay });
  dataLayer.setStyle({
    fillColor: 'rgba(0, 150, 255, 0.2)',
    strokeColor: '#0077cc',
    strokeWeight: 3,
  });

  mapMarker = new google.maps.Marker({
    position: playerLocation,
    map: mapOverlay,
    title: 'Player Position',
  });

  renderBoundsOverlay();
}

function renderBoundsOverlay() {
  if (!dataLayer || !boundsPolygon) {
    return;
  }

  dataLayer.forEach((feature) => dataLayer.remove(feature));
  dataLayer.addGeoJson(boundsPolygon);
  boundsOverlayReady = true;
}

window.__realInitMap = async function() {
  setStatus('Google Maps loaded. Initializing map and GIS data...');
  streetViewService = new google.maps.StreetViewService();
  initializeMiniMap();

  try {
    await initializeData();
    const startPos = startPoint;

    try {
      const panoLocation = await findNearestStreetViewInBounds(startPos.lat, startPos.lng);
      playerLocation = panoLocation;
      startLocation = panoLocation;
      setStatus('Found nearby Street View location inside bounds. Initializing panorama...');
    } catch (innerError) {
      logError(`Street View search failed: ${innerError.message}. Using southwestern transect point instead.`);
      playerLocation = startPos;
      startLocation = startPos;
    }

    initializeStreetView();
    if (panorama) {
      const actualPos = panorama.getPosition();
      if (actualPos) {
        playerLocation = actualPos.toJSON();
        startLocation = { ...playerLocation };
      }
    }
    updateInfo();
    if (boundsPolygon) {
      renderBoundsOverlay();
    }
    setStatus('Street View ready. Use WASD/arrow keys to move.');
  } catch (error) {
    logError(error);
  }
};

if (window.__initMapPending) {
  window.__realInitMap();
}

window.gm_authFailure = function() {
  setStatus('Google Maps authorization failed. Check your API key and restrictions.', true);
};

async function initializeData() {
  try {
    setStatus('Loading GIS data...');
    await Promise.all([loadBounds(), loadStatsData(), loadHeatRaster(), loadStartPoint()]);
    if (mapOverlay) {
      renderBoundsOverlay();
    }
    updateInfo();
    setStatus('Loaded GIS data. Use mouse drag and WASD/arrow keys to move.');
  } catch (error) {
    logError(error);
  }
}

// Navigation buttons
const returnStartBtn = document.getElementById('return-start');

returnStartBtn.addEventListener('click', async () => {
  playerLocation = { ...startLocation };
  heading = 0;
  pitch = 0;

  if (!panorama) {
    initializeStreetView();
  }

  setPanoramaPosition(playerLocation.lat, playerLocation.lng);
  if (panorama) {
    panorama.setPov({ heading, pitch });
    await new Promise((resolve) => google.maps.event.addListenerOnce(panorama, 'position_changed', resolve));
    const actualPos = panorama.getPosition();
    if (actualPos) {
      playerLocation = actualPos.toJSON();
    }
  }

  updateInfo();
});

// Movement
const keys = {};
let isMouseDown = false;
let mouseX = 0;
let mouseY = 0;
const sensitivity = 0.3; // degrees per pixel
const moveSpeedMeters = 2.5;

function addKey(key) {
  keys[key.toLowerCase()] = true;
}

function removeKey(key) {
  keys[key.toLowerCase()] = false;
}

document.addEventListener('keydown', (e) => {
  addKey(e.key);
});

document.addEventListener('keyup', (e) => {
  removeKey(e.key);
});

document.addEventListener('mousedown', (e) => {
  isMouseDown = true;
  mouseX = e.clientX;
  mouseY = e.clientY;
});

document.addEventListener('mousemove', (e) => {
  if (!isMouseDown || !panorama) return;

  const deltaX = e.clientX - mouseX;
  const deltaY = e.clientY - mouseY;
  mouseX = e.clientX;
  mouseY = e.clientY;

  heading -= deltaX * sensitivity;
  pitch = Math.max(-90, Math.min(90, pitch - deltaY * sensitivity));

  if (panorama) {
    panorama.setPov({ heading, pitch });
  }
});

document.addEventListener('mouseup', () => {
  isMouseDown = false;
});

function moveAlongBearing(distanceMeters, bearingDegrees) {
  const currentPoint = turf.point([playerLocation.lng, playerLocation.lat]);
  const nextPoint = turf.destination(currentPoint, distanceMeters / 1000, bearingDegrees, { units: 'kilometers' });
  const [lng, lat] = nextPoint.geometry.coordinates;

  if (pointInsideBounds(lat, lng)) {
    playerLocation = { lat, lng };
    setPanoramaPosition(lat, lng);
    updateInfo();
  }
}

function updateMovement() {
  if (!panorama) return;

  if ((keys['w'] || keys['arrowup'] || keys['a'] || keys['arrowleft'] || keys['s'] || keys['arrowdown'] || keys['d'] || keys['arrowright']) && !navigationStarted) {
    navigationStarted = true;
    hideStatusWindow();
  }

  if (keys['w'] || keys['arrowup']) {
    moveAlongBearing(moveSpeedMeters, heading);
  }
  if (keys['s'] || keys['arrowdown']) {
    moveAlongBearing(moveSpeedMeters, heading + 180);
  }
  if (keys['a'] || keys['arrowleft']) {
    moveAlongBearing(moveSpeedMeters, heading - 90);
  }
  if (keys['d'] || keys['arrowright']) {
    moveAlongBearing(moveSpeedMeters, heading + 90);
  }
}

function animate() {
  requestAnimationFrame(animate);
  updateMovement();
}

animate();

window.addEventListener('resize', () => {
  // Street View auto-resizes with the container.
});