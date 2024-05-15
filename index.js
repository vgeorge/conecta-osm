import { parse } from "csv-parse/sync";
import fs from "fs-extra";
import * as turf from "@turf/turf";

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const citiesCsv = await fs.readFile("municipios.csv", "utf8");
  let cities = parse(citiesCsv, { columns: true, skip_empty_lines: true });

  cities = cities.filter((city) => city.uf_code === "RS");

  const citiesGeoJson = {
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
      },
    })),
  };

  // for (let i = 0; i < citiesGeoJson.features.length; i++) {
  for (let i = 0; i < 2; i++) {
    const currentCity = citiesGeoJson.features[i];

    // console.log(JSON.stringify(currentCity, null, 2));

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

    // console.log(JSON.stringify(closestCities, null, 2));

    // Constructing the URL for OSRM API
    const coordinates = closestCities
      .map((item) => item.city.geometry.coordinates.join(","))
      .join(";");

    const url = `http://router.project-osrm.org/table/v1/driving/${currentCity.geometry.coordinates.join(
      ","
    )};${coordinates}?annotations=distance&sources=0`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();

      const routePairs = closestCities.map((item, index) => ({
        city: item.city.properties.name,
        distance: item.distance,
        routeDistance: data.distances[0][index + 1] / 1000,
      }));
      console.log(routePairs);

      // console.log(`Data for ${currentCity.properties.name}: `, data);
    } catch (error) {
      console.error("Failed to fetch data:", error);
    }

    await delay(20000); // Wait for 20 seconds before the next request
  }
}

main();
