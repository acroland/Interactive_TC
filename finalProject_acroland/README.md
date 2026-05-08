# Transect Heat Index Game

An interactive web-based simulation for walking transects with heat index measurements on a 5m grid. The visualization uses Google Street View to provide a realistic, first-person perspective of Grier Heights, Charlotte, NC.

## Features

- **Dynamic Google Street View** background showing real street-level imagery
- First-person navigation using keyboard (WASD or arrow keys)
- Mouse look for camera rotation and direction control (click and drag)
- On-screen navigation buttons: Reset View and Return to Start
- Live HUD display of heat index and feature statistics from the transect dataset
- Movement constrained inside the provided bounding polygon
- Real-world mapping context for Grier Heights, Charlotte, NC

## Data Integration

The app expects data files to be placed under `public/data/`:

- `t1aggEBKlogHI.tif` for the heat index raster
- `t1Poly.geojson` for the player bounds polygon
- `t1agg.geojson` for transect feature statistics

The HUD uses these fields from `t1agg.geojson`:

- `pctCanopy` → Tree Canopy
- `pctImperv` → Impervious Surfaces
- `hwRatio` → Building Height to Street Width Ratio

## How to Run

1. Install dependencies: `npm install`
2. Copy your data files into `public/data/`
3. **Add your Google Maps API key** to `index.html` (replace the placeholder key in the Google Maps script tag)
4. Start the development server: `npm run dev`
5. Open http://localhost:5173/ in your browser
6. Use mouse to look around and WASD or arrow keys to move

## Controls

- **WASD or Arrow Keys**: Move forward, backward, left, right (relative to where you're looking)
- **Mouse Click + Drag**: Look around (change heading and pitch)
- **Return to Start Button**: Return to the starting position and reset view

## Google Maps Integration

The visualization is centered on Grier Heights, Charlotte, NC and uses Google Street View to display the actual street-level environment. As you navigate along the transect route, the Street View updates to show the real-world scenery at that location. **Street View imagery may not reflect season when data was collected.

To enable Street View:
- Obtain a Google Maps JavaScript API key from [Google Cloud Console](https://cloud.google.com/console)
- Add the key to `index.html` in the script tag: `https://maps.googleapis.com/maps/api/js?key=YOUR_API_KEY&callback=initMap`
- Enable the Street View API in your Google Cloud project

## Project Structure

- `index.html`: Main HTML file with Street View container
- `src/main.js`: Game logic with Street View integration
- `src/style.css`: Styles for UI overlays
- `package.json`: Project dependencies and scripts

## Technologies

- Vite for build tool and dev server
- Google Maps JavaScript API (Street View Panorama)
- JavaScript for game logic and controls