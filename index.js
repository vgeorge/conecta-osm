import { parse } from "csv-parse/sync";
import fs from "fs-extra";
import * as turf from "@turf/turf";

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAndParseCsv(filePath) {
  const citiesCsv = await fs.readFile(filePath, "utf8");
  const cities = parse(citiesCsv, { columns: true, skip_empty_lines: true });
  return cities.filter((city) => city.uf_code === "RS");
}

function convertToGeoJson(cities) {
  return {
    type: "FeatureCollection",
    features: cities.map((city) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [parseFloat(city.lon), parseFloat(city.lat)],
      },
      properties: {
        name: city.name,
        state: city.uf_code,
        slug_name: city.slug_name,
      },
    })),
  };
}

async function fetchDistances(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return await response.json();
}

function generateRoutePairs(currentCity, closestCities, distancesData) {
  return closestCities.map((item, index) => ({
    city: item.city,
    distance: item.distance,
    routeDistance: distancesData.distances[0][index + 1] / 1000,
    ratio: distancesData.distances[0][index + 1] / 1000 / item.distance,
    lineArc: turf.lineString([
      currentCity.geometry.coordinates,
      item.city.geometry.coordinates,
    ]),
  }));
}

async function saveGeoJsonToFile(filePath, data) {
  await fs.ensureDir("routes");
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const cities = await readAndParseCsv("municipios.csv");
  const citiesGeoJson = convertToGeoJson(cities);

  for (let i = 0; i < citiesGeoJson.features.length; i++) {
    const currentCity = citiesGeoJson.features[i];

    const distances = citiesGeoJson.features.map((targetCity) => ({
      city: targetCity,
      distance: turf.distance(currentCity.geometry, targetCity.geometry, {
        units: "kilometers",
      }),
    }));

    const closestCities = distances
      .filter(
        (item) => item.city.properties.name !== currentCity.properties.name
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    const coordinates = closestCities
      .map((item) => item.city.geometry.coordinates.join(","))
      .join(";");

    const routeToUrl = `http://router.project-osrm.org/table/v1/driving/${currentCity.geometry.coordinates.join(
      ","
    )};${coordinates}?annotations=distance&sources=0`;

    try {
      const distancesData = await fetchDistances(routeToUrl);

      const routePairs = generateRoutePairs(
        currentCity,
        closestCities,
        distancesData
      );

      const routeToGeojson = {
        type: "FeatureCollection",
        features: routePairs.map((item) => ({
          type: "Feature",
          geometry: item.lineArc.geometry,
          properties: {
            city: item.city,
            distance: item.distance,
            routeDistance: item.routeDistance,
            ratio: item.ratio,
          },
        })),
      };

      await saveGeoJsonToFile(
        `routes/${currentCity.properties.slug_name}.geojson`,
        routeToGeojson
      );
    } catch (error) {
      console.error("Failed to fetch data:", error);
    }

    await delay(20000); // delay next request
  }
}

main();
