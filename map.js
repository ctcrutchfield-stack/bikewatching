import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Set your Mapbox token
mapboxgl.accessToken = 'pk.eyJ1IjoiY3RjcnV0Y2hmaWVsZCIsImEiOiJjbXdiNmVpeDgwMGNtMnlvaDJuZXNsNGQ4In0.YZi4TEb8-z38Ze8lIQR81g';

// Step 1.3: Initialize Mapbox Map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// Helper functions for time conversion
function minutesSinceStartOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Global coordinate transformation for SVG overlays
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

map.on('load', async () => {
  // Step 2.1 & 2.3: Add Boston & Cambridge Bike Lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis-data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  const laneStyle = {
    'line-color': '#32D400',
    'line-width': 3,
    'line-opacity': 0.5,
  };

  map.addLayer({
    id: 'boston-bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: laneStyle,
  });

  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: laneStyle,
  });

  // Step 3.1 & 4.1: Fetch Bluebikes Station JSON and March Traffic CSV
  const jsonUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
  const csvUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

  const [jsonData, rawTrips] = await Promise.all([
    d3.json(jsonUrl),
    d3.csv(csvUrl, (trip) => {
      // Parse ISO dates into Date objects and store time in minutes
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      trip.start_min = minutesSinceStartOfDay(trip.started_at);
      trip.end_min = minutesSinceStartOfDay(trip.ended_at);
      return trip;
    }),
  ]);

  let stations = jsonData.data.stations;
  const svg = d3.select('#map').select('svg');

  // Step 6.1: Define Quantile/Diverging Color Scale for Traffic Flow
  // Ratio = departures / totalTraffic (ranges 0 to 1)
  const stationFlowColor = d3
    .scaleLinear()
    .domain([0, 0.5, 1])
    .range(['rgb(31, 120, 180)', 'rgb(150, 150, 150)', 'rgb(227, 26, 28)']);

  // Step 4.2 & 5.3: Filter and Aggregate Traffic Function
  function filterTripsByTime(trips, timeFilter) {
    return timeFilter === -1
      ? trips
      : trips.filter(
          (trip) =>
            Math.abs(trip.start_min - timeFilter) <= 60 ||
            Math.abs(trip.end_min - timeFilter) <= 60
        );
  }

  function computeStationTraffic(stations, filteredTrips) {
    const departures = d3.rollup(
      filteredTrips,
      (v) => v.length,
      (d) => d.start_station_id
    );

    const arrivals = d3.rollup(
      filteredTrips,
      (v) => v.length,
      (d) => d.end_station_id
    );

    return stations.map((station) => {
      const id = station.short_name;
      const dep = departures.get(id) ?? 0;
      const arr = arrivals.get(id) ?? 0;
      return {
        ...station,
        departures: dep,
        arrivals: arr,
        totalTraffic: dep + arr,
      };
    });
  }

  // Initial Calculation with all trips
  let stationTraffic = computeStationTraffic(stations, rawTrips);

  // Step 4.3: Radius Scale (Square root scale for area proportionality)
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stationTraffic, (d) => d.totalTraffic) || 1])
    .range([0, 25]);

  // Step 3.3: Render SVG Circles
  const circles = svg
    .selectAll('circle')
    .data(stationTraffic, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .attr('fill', (d) => {
      const ratio = d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic;
      return stationFlowColor(ratio);
    });

  // Step 4.4: Add Tooltips
  circles.each(function (d) {
    d3.select(this)
      .append('title')
      .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
  });

  // Reposition circles based on current viewport
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();

  // Step 3.3: Re-align markers on map movements
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // Step 5: Interactive Time Filtering & Updates
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatterPlot(timeFilter) {
    const filteredTrips = filterTripsByTime(rawTrips, timeFilter);
    const updatedStations = computeStationTraffic(stations, filteredTrips);

    // Adjust domain dynamically or use max range when filtering
    radiusScale.domain([0, d3.max(updatedStations, (d) => d.totalTraffic) || 1]);

    circles
      .data(updatedStations, (d) => d.short_name)
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .attr('fill', (d) => {
        const ratio = d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic;
        return stationFlowColor(ratio);
      })
      .each(function (d) {
        d3.select(this)
          .select('title')
          .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
      });
  }

  timeSlider.addEventListener('input', (event) => {
    const timeFilter = Number(event.target.value);

    if (timeFilter === -1) {
      anyTimeLabel.style.display = 'inline';
      selectedTime.textContent = '';
    } else {
      anyTimeLabel.style.display = 'none';
      selectedTime.textContent = formatTime(timeFilter);
    }

    updateScatterPlot(timeFilter);
  });
});